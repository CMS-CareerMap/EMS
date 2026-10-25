import type { AppContext } from '../../platform/context'
import { NotFound, Conflict, BadRequest, Forbidden } from '../../platform/errors/AppError'
import { applyTypeQuotaChange } from '../leave/leaveEntitlement.service'
import { zonedToday, toDateColumn, fromDateColumn, addCalendarDays } from '../../domain/shared/dates'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { audit, withAudit } from '../audit/audit.service'
import { logger } from '../../platform/logger'
import * as repo from './settings.repository'
import { bestReading, checkGeofence, effectiveFence, geofenceMessage, type Fence, type Reading } from '../../domain/attendance/geofence'
import { methodNeeds, PUNCH_METHOD_WORDS } from '../../domain/attendance/punchMethod'
import type { TxDb } from '../../platform/db/transaction'

/**
 * Company settings.
 *
 * Two different kinds of setting live here and they are saved differently:
 *
 *   IDENTITY      address, GSTIN, phone. Facts about the company that were
 *                 always true and were simply recorded late. Overwritten.
 *
 *   POLICY        PF rates, ESI threshold, pay day. Rules that applied over a
 *                 PERIOD. Never overwritten — a change closes the old period
 *                 and opens a new one, so a payslip issued in March can still
 *                 be explained by March's rules.
 *
 * Mixing those up is how a rate change in April silently rewrites every payslip
 * already issued.
 */

export interface CompanyIdentityInput {
  name?: string | undefined
  legalName?: string | null | undefined
  gstin?: string | null | undefined
  pan?: string | null | undefined
  addressLine?: string | null | undefined
  city?: string | null | undefined
  state?: string | null | undefined
  pincode?: string | null | undefined
  phone?: string | null | undefined
  email?: string | null | undefined
  website?: string | null | undefined
  timezone?: string | undefined
  country?: string | undefined
  currency?: string | undefined
  maxUploadMb?: number | undefined
}

export async function getCompany(ctx: AppContext) {
  const organization = await repo.getOrganization(ctx.db, ctx.organizationId)
  if (!organization) throw NotFound('Company not found')
  return organization
}

export async function updateCompany(ctx: AppContext, input: CompanyIdentityInput) {
  const data: Record<string, unknown> = {}

  // Only the keys actually sent are written. Spreading the whole input would
  // turn "the form did not include website" into "set website to null".
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) data[key] = value
  }

  if (Object.keys(data).length === 0) throw BadRequest('Nothing to update')

  if (typeof data.country === 'string') data.country = data.country.toUpperCase()
  if (typeof data.currency === 'string') data.currency = data.currency.toUpperCase()

  // With the values: a company's own details are not personal data, and "who
  // changed the time zone" is exactly the question this answers.
  const updated = await withAudit(
    ctx,
    (tx) => repo.updateOrganization(tx, ctx.organizationId, data),
    () => ({ action: 'company.updated', entityType: 'organization', entityId: ctx.organizationId, details: { changes: data } }),
  )

  logger.info('Company settings updated', {
    by: ctx.userId,
    fields: Object.keys(data),
  })

  return updated
}

export interface PolicyInput {
  pfEmployeeRate?: number | undefined
  pfEmployerRate?: number | undefined
  pfRestrictToCeiling?: boolean | undefined
  pfWageCeiling?: number | undefined
  epsWageCeiling?: number | undefined
  wagesShareEnabled?: boolean | undefined
  wagesSharePercent?: number | undefined
  esiEmployeeRate?: number | undefined
  esiEmployerRate?: number | undefined
  esiThreshold?: number | undefined
  payDay?: number | undefined
  payslipLockDay?: number | null | undefined
  leaveYearStartMonth?: number | undefined
  fiscalYearStartMonth?: number | undefined
  lopBasis?: 'calendar_days' | 'fixed_30' | 'working_days' | undefined
  sandwichRule?: boolean | undefined
  tdsEnabled?: boolean | undefined
  overtimeEnabled?: boolean | undefined
  overtimeRate?: number | undefined
  overtimeBasis?: 'gross' | 'basic' | undefined
  encashmentBasis?: 'gross' | 'basic' | undefined
}

/**
 * The policy in force today, creating the default one if none exists.
 *
 * A company that has never opened Settings still needs rates to run payroll, so
 * the first read materialises the statutory defaults rather than returning
 * null and leaving every caller to invent them.
 */
export async function getPolicy(ctx: AppContext) {
  const current = await repo.getCurrentPolicy(ctx.db)
  if (current) return current

  return repo.createPolicy(ctx.db, {
    organizationId: ctx.organizationId,
    effectiveFrom: await companyToday(ctx),
    createdByUserId: ctx.userId,
  })
}

export async function listPolicyHistory(ctx: AppContext) {
  return repo.listPolicies(ctx.db)
}

/**
 * Today in the COMPANY's time zone, as a date column.
 *
 * It used to be today in UTC — so a rate changed at 1 a.m. in India on the 1st
 * of April took effect on the 31st of March, and the March payroll ran on the
 * new rate. The day a rule starts is a date on the company's calendar.
 */
async function companyToday(ctx: AppContext): Promise<Date> {
  const organization = await repo.getOrganization(ctx.db, ctx.organizationId)
  return toDateColumn(zonedToday(new Date(), organization?.timezone ?? 'Asia/Kolkata'))
}

/**
 * Changes the rules, by ending the current period and starting a new one.
 *
 * Except on the same day. A policy edited on the day it took effect is a
 * CORRECTION — somebody typed 21000 as 2100 and fixed it a minute later — and
 * recording that as two periods, one of them a minute long, would be noise in
 * the history and would collide on the unique effectiveFrom. Same day is
 * updated in place; any later day opens a new period.
 */
export async function updatePolicy(ctx: AppContext, input: PolicyInput) {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input)) {
    if (value !== undefined) data[key] = value
  }

  if (Object.keys(data).length === 0) throw BadRequest('Nothing to update')

  const from = await companyToday(ctx)

  // The leave year is fixed once any leave exists. Every balance is counted
  // within a leave year, so moving its start after grants and approvals would
  // split everybody's entitlement across two years that never existed.
  if (input.leaveYearStartMonth !== undefined) {
    const standing = await repo.getCurrentPolicy(ctx.db)
    if (standing && standing.leaveYearStartMonth !== input.leaveYearStartMonth) {
      if ((await repo.countLeaveLedgerEntries(ctx.db)) > 0) {
        throw Conflict(
          'The leave year cannot change once leave has been granted or taken — every balance is counted inside the current leave year. Change it before opening balances are granted.',
        )
      }
    }
  }

  const period = { organizationId: ctx.organizationId, effectiveFrom: from, createdByUserId: ctx.userId }

  const policyId = await withTransaction(ctx.db, async (tx) => {
    // One change to the rules at a time: two saves together both read the same
    // current period and both tried to open the next one.
    await lockFor(tx, `policy:${ctx.organizationId}`)
    const current = await repo.getCurrentPolicy(tx)

    const recorded = async (id: string, kind: 'first' | 'correction' | 'new_period') => {
      await audit(ctx, {
        action: 'policy.updated',
        entityType: 'organization_policy',
        entityId: id,
        details: { kind, effectiveFrom: fromDateColumn(from), changes: data },
      }, tx)
      return id
    }

    if (!current) {
      return recorded((await repo.createPolicy(tx, period, data)).id, 'first')
    }

    if (current.effectiveFrom.getTime() === from.getTime()) {
      await repo.updatePolicy(tx, current.id, data)
      return recorded(current.id, 'correction')
    }

    // Close yesterday, open today. The old row keeps every number it had, so
    // a payslip from that period is still explainable.
    await repo.closePolicy(tx, current.id, toDateColumn(addCalendarDays(fromDateColumn(from), -1)))

    const created = await repo.createPolicy(tx, period, {
      // Carry forward everything that was not explicitly changed, or the new
      // period would silently reset untouched rates to their defaults.
      pfEmployeeRate: current.pfEmployeeRate,
      pfEmployerRate: current.pfEmployerRate,
      pfRestrictToCeiling: current.pfRestrictToCeiling,
      pfWageCeiling: current.pfWageCeiling,
      epsWageCeiling: current.epsWageCeiling,
      wagesShareEnabled: current.wagesShareEnabled,
      wagesSharePercent: current.wagesSharePercent,
      esiEmployeeRate: current.esiEmployeeRate,
      esiEmployerRate: current.esiEmployerRate,
      esiThreshold: current.esiThreshold,
      payDay: current.payDay,
      payslipLockDay: current.payslipLockDay,
      // No longer read (the working week is WorkWeek since 25 Oct 2026); carried so the version before still finds what it had.
      weeklyOffDays: current.weeklyOffDays,
      leaveYearStartMonth: current.leaveYearStartMonth,
      fiscalYearStartMonth: current.fiscalYearStartMonth,
      lopBasis: current.lopBasis,
      sandwichRule: current.sandwichRule,
      tdsEnabled: current.tdsEnabled,
      overtimeEnabled: current.overtimeEnabled,
      overtimeRate: current.overtimeRate,
      overtimeBasis: current.overtimeBasis,
      encashmentBasis: current.encashmentBasis,
      ...data,
    })

    return recorded(created.id, 'new_period')
  })

  logger.info('Statutory policy updated', { by: ctx.userId, fields: Object.keys(data) })

  const policy = await repo.findPolicy(ctx.db, policyId)
  if (!policy) throw NotFound('Policy was saved but could not be read back')
  return policy
}

export interface GeofenceInput {
  name: string
  latitude: number
  longitude: number
  radiusMeters: number
  maxAccuracyMeters?: number | undefined
  isActive?: boolean | undefined
}

export async function listGeofences(ctx: AppContext) {
  return repo.listGeofences(ctx.db)
}

/**
 * Saves the office location.
 *
 * Upsert by name rather than requiring an id, because the Settings page edits
 * one location and has never had an id to send — it kept this in localStorage.
 */
export async function saveGeofence(ctx: AppContext, input: GeofenceInput) {
  const data: repo.GeofenceValues = {
    latitude: input.latitude,
    longitude: input.longitude,
    radiusMeters: input.radiusMeters,
    ...(input.maxAccuracyMeters === undefined ? {} : { maxAccuracyMeters: input.maxAccuracyMeters }),
    // Saving the office is saying "this is the office" — one switched off
    // before is switched back on, unless it is saved off on purpose.
    isActive: input.isActive ?? true,
  }

  // Where the office is decides whose punch counts. A fence moved to somebody's
  // house is the thing to be able to see.
  // One office (v1 decision, 4 Oct 2026): saving one under a new name retires
  // the others, so an old fence elsewhere can never stay switched on beside it.
  const saved = await withAudit(
    ctx,
    async (tx) => {
      // One save at a time: two at once under different names would each
      // retire the other's old office and leave both switched on.
      await lockFor(tx, `geofence:${ctx.organizationId}`)
      const existing = await repo.findGeofenceByName(tx, input.name)
      // Switching the office off is removing it, as far as punches go.
      if (!data.isActive && existing?.isActive) await assertOfficeNotInUse(ctx, tx)
      const row = existing ? await repo.updateGeofence(tx, existing.id, data) : await repo.createGeofence(tx, ctx.organizationId, input.name, data)
      if (row.isActive) await repo.retireOtherGeofences(tx, row.id)
      return { row, created: !existing }
    },
    ({ row, created }) => ({ action: 'geofence.saved', entityType: 'geofence', entityId: row.id, details: { name: input.name, ...data, created } }),
  )

  logger.info('Geofence saved', { by: ctx.userId, name: input.name })
  return saved.row
}

/**
 * The office is about to stop being the office — removed, or saved switched
 * off (client, 14 Oct 2026). Refused while the company's method checks punches
 * against it: otherwise every check-in would be refused. A day already checked
 * in against it is closed by the company's method instead (prepareCheckOut).
 */
async function assertOfficeNotInUse(ctx: AppContext, tx: TxDb): Promise<void> {
  const security = await repo.attendanceSecurityOf(tx, ctx.organizationId)
  if (security && methodNeeds(security.punchMethod).fence) {
    throw Conflict(`Check-ins are checked against this office: the attendance method is ${PUNCH_METHOD_WORDS[security.punchMethod]}. Choose Selfie, or Location + Selfie, as the method first — or, if the office has moved, save its new place instead.`)
  }
}

/** Settings → Attendance Security (client, 11 Oct 2026): which layers the company has on. */
export async function getAttendanceSecurity(ctx: AppContext): Promise<repo.AttendanceSecurity> {
  const security = await repo.attendanceSecurityOf(ctx.db, ctx.organizationId)
  if (!security) throw NotFound('Company not found')
  return security
}

/** With whether an office is saved: a method that checks it, with none, is a setup not finished. */
export type AttendanceSecurityView = repo.AttendanceSecurity & { officeSet: boolean }
export type AttendanceSecurityInput = { [K in keyof repo.AttendanceSecurity]?: repo.AttendanceSecurity[K] | undefined }

export async function attendanceSecurityView(ctx: AppContext, security?: repo.AttendanceSecurity): Promise<AttendanceSecurityView> {
  const [settings, office] = await Promise.all([security ?? getAttendanceSecurity(ctx), repo.findActiveGeofence(ctx.db)])
  return { ...settings, officeSet: office !== null }
}

/** Saved and audited — what changed, from what to what. Nothing changed: nothing written. */
export async function updateAttendanceSecurity(ctx: AppContext, input: AttendanceSecurityInput): Promise<repo.AttendanceSecurity> {
  const before = await getAttendanceSecurity(ctx)
  const keys = (Object.keys(input) as (keyof repo.AttendanceSecurity)[]).filter((k) => input[k] !== undefined && input[k] !== before[k])
  if (keys.length === 0) return before
  const data: Partial<repo.AttendanceSecurity> = Object.fromEntries(keys.map((k) => [k, input[k]]))
  const changes = Object.fromEntries(keys.map((k) => [k, { from: before[k], to: input[k] }]))
  return withAudit(
    ctx,
    async (tx) => {
      // A method that checks the office needs an office to check against
      // (client, 14 Oct 2026): refused here, so nobody is refused at the door.
      // Under the office's lock: never beside its removal.
      if (data.punchMethod && methodNeeds(data.punchMethod).fence) {
        await lockFor(tx, `geofence:${ctx.organizationId}`)
        if (!(await repo.findActiveGeofence(tx))) {
          throw Conflict(`Set and save the office location first (below, under Office Location): ${PUNCH_METHOD_WORDS[data.punchMethod]} checks every check-in against it.`)
        }
      }
      // The version before reads the old selfie switch: kept in step for one release, so a rollback keeps the photo.
      return repo.saveAttendanceSecurity(tx, ctx.organizationId, data, data.punchMethod ? { punchSelfie: methodNeeds(data.punchMethod).selfie } : {})
    },
    () => ({ action: 'attendance_security.updated', entityType: 'organization', entityId: ctx.organizationId, details: { changes } }),
  )
}

/**
 * "Test this spot" (client, 11 Oct 2026): where the Super Admin stands, as a
 * punch would be judged — the same rule, the same choice of reading — so the
 * fence can be tried at the hall's corners before anybody punches.
 */
export async function testGeofenceSpot(ctx: AppContext, readings: Reading[]) {
  const office = await repo.findActiveGeofence(ctx.db)
  if (!office) throw BadRequest('Set and save the office location first.')
  const fence: Fence = {
    latitude: Number(office.latitude),
    longitude: Number(office.longitude),
    radiusMeters: office.radiusMeters,
    maxAccuracyMeters: office.maxAccuracyMeters,
  }
  const best = bestReading(readings)
  if (!best) throw BadRequest('No location was read.')
  const verdict = checkGeofence(best, fence)
  const applied = effectiveFence(fence)
  return { verdict, radiusMeters: applied.radiusMeters, accuracyNeeded: applied.maxAccuracyMeters, message: geofenceMessage(verdict, fence) }
}

export async function deleteGeofence(ctx: AppContext, id: string) {
  const existing = await repo.findGeofence(ctx.db, id)
  if (!existing) throw NotFound('Location not found')
  await withAudit(
    ctx,
    async (tx) => {
      await lockFor(tx, `geofence:${ctx.organizationId}`)
      // Read again under the lock: an old office switched off is removed freely.
      const now = await repo.findGeofence(tx, id)
      if (!now) throw NotFound('Location not found')
      if (now.isActive) await assertOfficeNotInUse(ctx, tx)
      await repo.deleteGeofence(tx, id)
    },
    () => ({ action: 'geofence.deleted', entityType: 'geofence', entityId: id, details: { name: existing.name } }),
  )
}

export interface LeaveTypeInput {
  name?: string | undefined
  code?: string | undefined
  annualQuota?: number | undefined
  isPaid?: boolean | undefined
  carryForward?: boolean | undefined
  carryForwardCap?: number | undefined
  minNoticeDays?: number | undefined
  maxDaysPerRequest?: number | null | undefined
  eligibleAfterDays?: number | undefined
  eligibleGender?: 'male' | 'female' | 'other' | null | undefined
  accrual?: 'yearly' | 'monthly' | undefined
  halfDayAllowed?: boolean | undefined
  countsNonWorkingDays?: boolean | undefined
  encashable?: boolean | undefined
  encashMaxDaysPerYear?: number | null | undefined
  joinerGrant?: 'months_left' | 'months_after_joining' | 'full_year' | undefined
  usableAfterConfirmation?: boolean | undefined
  /**
   * With a change to the days a year: this leave year's balances change too,
   * by the difference. Left out, the change applies from the next leave year.
   */
  applyToThisYear?: boolean | undefined
}

/** A leave type's own rules (client §36–37, and 9 Oct 2026), each defaulting to what applied before they existed. */
const LEAVE_RULE_KEYS = [
  'minNoticeDays',
  'maxDaysPerRequest',
  'eligibleAfterDays',
  'eligibleGender',
  'accrual',
  'halfDayAllowed',
  'countsNonWorkingDays',
  'encashable',
  'encashMaxDaysPerYear',
  'joinerGrant',
  'usableAfterConfirmation',
] as const

/**
 * Unpaid leave has no paid days to keep or to turn into pay: an unpaid type
 * never carries forward and is never encashed (client, 9 Oct 2026).
 */
function assertUnpaidRules(type: { isPaid: boolean; carryForward: boolean; encashable: boolean; name: string }): void {
  if (type.isPaid) return
  if (type.carryForward) throw BadRequest(`${type.name} is unpaid, so it does not carry forward. Turn carry forward off, or make it paid.`)
  if (type.encashable) throw BadRequest(`${type.name} is unpaid, so it cannot be encashed. Turn encashment off, or make it paid.`)
}

export async function listLeaveTypes(ctx: AppContext) {
  return repo.listLeaveTypes(ctx.db)
}

/**
 * Adds a leave type — or brings back an archived one of the same code.
 *
 * Archived types keep their ledger history, and the code is unique for ever.
 * So "add Maternity Leave again" used to be a dead end: a 409 about a type
 * nobody could see. It restores that type now, with the values given, and its
 * history comes with it.
 */
export async function createLeaveType(ctx: AppContext, input: LeaveTypeInput) {
  if (!input.name || !input.code) throw BadRequest('A leave type needs a name and a code')

  const name = input.name.trim()
  const code = input.code.trim().toUpperCase()
  const values: repo.LeaveTypeValues = {
    name,
    code,
    annualQuota: input.annualQuota ?? 0,
    isPaid: input.isPaid ?? true,
    carryForward: input.carryForward ?? false,
    carryForwardCap: input.carryForwardCap ?? 0,
    minNoticeDays: input.minNoticeDays ?? 0,
    maxDaysPerRequest: input.maxDaysPerRequest ?? null,
    eligibleAfterDays: input.eligibleAfterDays ?? 0,
    eligibleGender: input.eligibleGender ?? null,
    accrual: input.accrual ?? 'yearly',
    halfDayAllowed: input.halfDayAllowed ?? true,
    countsNonWorkingDays: input.countsNonWorkingDays ?? false,
    encashable: input.encashable ?? false,
    encashMaxDaysPerYear: input.encashMaxDaysPerYear ?? null,
    joinerGrant: input.joinerGrant ?? 'months_left',
    usableAfterConfirmation: input.usableAfterConfirmation ?? false,
  }
  assertUnpaidRules(values)

  const matches = await repo.findLeaveTypesLike(ctx.db, code, name)
  const active = matches.find((t) => !t.archivedAt)
  if (active) throw Conflict(`A leave type called ${active.name} (${active.code}) already exists`)

  if (matches.length > 1) {
    throw Conflict('An archived leave type already uses that name, and another that code. Add it back under its own name and code.')
  }

  if (matches.length === 1) {
    const restored = await withAudit(
      ctx,
      (tx) => repo.restoreLeaveType(tx, matches[0]!.id, values),
      (row) => ({ action: 'leave_type.restored', entityType: 'leave_type', entityId: row.id, details: { ...values } }),
    )
    logger.info('Leave type restored', { by: ctx.userId, id: restored.id })
    return { row: restored, restored: true }
  }

  const row = await withAudit(
    ctx,
    (tx) => repo.createLeaveType(tx, ctx.organizationId, values),
    (created) => ({ action: 'leave_type.created', entityType: 'leave_type', entityId: created.id, details: { ...values } }),
  )
  return { row, restored: false }
}

export async function updateLeaveType(ctx: AppContext, id: string, input: LeaveTypeInput) {
  const existing = await repo.findLeaveType(ctx.db, id)
  if (!existing) throw NotFound('Leave type not found')

  const data: Record<string, unknown> = {}
  if (input.name !== undefined) data.name = input.name.trim()
  if (input.code !== undefined) data.code = input.code.trim().toUpperCase()
  if (input.annualQuota !== undefined) data.annualQuota = input.annualQuota
  if (input.isPaid !== undefined) data.isPaid = input.isPaid
  if (input.carryForward !== undefined) data.carryForward = input.carryForward
  if (input.carryForwardCap !== undefined) data.carryForwardCap = input.carryForwardCap
  for (const key of LEAVE_RULE_KEYS) {
    if (input[key] !== undefined) data[key] = input[key]
  }

  if (Object.keys(data).length === 0) throw BadRequest('Nothing to update')

  // The type as it will stand: a change of one part (paid, or carry forward)
  // is checked against the rest as stored.
  assertUnpaidRules({
    name: (data.name as string | undefined) ?? existing.name,
    isPaid: (data.isPaid as boolean | undefined) ?? existing.isPaid,
    carryForward: (data.carryForward as boolean | undefined) ?? existing.carryForward,
    encashable: (data.encashable as boolean | undefined) ?? existing.encashable,
  })

  // Days a year changed (client, 9 Oct 2026): from the next leave year for
  // everybody — and this year's balances too, when asked. Changing balances is
  // `leave:balance:manage` (HR, the Super Admin), whoever may change the type.
  const quotaChanged = data.annualQuota !== undefined && Number(data.annualQuota) !== Number(existing.annualQuota)
  const thisYear = quotaChanged && input.applyToThisYear === true
  if (thisYear && !ctx.can('leave:balance:manage')) {
    throw Forbidden('Changing this year’s balances is for whoever manages leave balances. Save the new days without it: they apply from the next leave year.')
  }

  // Checked here, not left to the unique index: a clash is somebody choosing a
  // name that is taken, which deserves a sentence, not a 500.
  const clash = (await repo.findLeaveTypesLike(
    ctx.db,
    data.code as string | undefined,
    data.name as string | undefined,
  )).find((t) => t.id !== id)
  if (clash) {
    throw Conflict(
      clash.archivedAt
        ? `An archived leave type already uses that name or code (${clash.name}, ${clash.code}).`
        : `${clash.name} (${clash.code}) already uses that name or code.`,
    )
  }

  return withTransaction(ctx.db, async (tx) => {
    const row = await repo.updateLeaveType(tx, id, data)
    // A year granted in advance always follows the new days; this one only when asked.
    const balances = quotaChanged
      ? await applyTypeQuotaChange(ctx, tx, { id, name: row.name, isPaid: row.isPaid, joinerGrant: row.joinerGrant }, Number(row.annualQuota), thisYear)
      : null
    await audit(ctx, {
      action: 'leave_type.updated',
      entityType: 'leave_type',
      entityId: id,
      // The old value beside each new one (client §47).
      details: {
        code: existing.code,
        changes: data,
        before: Object.fromEntries(Object.keys(data).map((k) => [k, plain((existing as Record<string, unknown>)[k])])),
        ...(balances ? { thisYear, balancesChanged: balances } : {}),
      },
    }, tx)
    return { row, balances, thisYear }
  })
}

/**
 * Archives a leave type. Never deletes it.
 *
 * Ledger entries reference this row, and a balance whose type has vanished
 * cannot be explained — "4 days of what?". Archiving removes it from the
 * dropdown and leaves history intact.
 */
export async function archiveLeaveType(ctx: AppContext, id: string) {
  const existing = await repo.findLeaveType(ctx.db, id)
  if (!existing) throw NotFound('Leave type not found')

  await withAudit(
    ctx,
    (tx) => repo.archiveLeaveType(tx, id, new Date()),
    () => ({ action: 'leave_type.archived', entityType: 'leave_type', entityId: id, details: { code: existing.code, name: existing.name } }),
  )
  logger.info('Leave type archived', { by: ctx.userId, id })
}

export async function listPtSlabs(ctx: AppContext, state?: string) {
  return repo.listPtSlabs(ctx.db, state)
}


// ── What counts as PF wages ─────────────────────────────────────────────────

/** The earning components, each with whether it counts as PF wages. */
export async function listPfComponents(ctx: AppContext) {
  return repo.listEarningComponents(ctx.db)
}

/**
 * Whether an earning counts as PF wages — Basic and DA to start; the
 * accountant may add, say, Special Allowance. The Super Admin's, as every
 * payroll rule is. A payroll calculated or recalculated afterwards follows it;
 * a month past draft keeps what it was paid on, and somebody already paid
 * keeps their EPS membership (payroll.service).
 */
export async function setCountsForPf(ctx: AppContext, id: string, countsForPf: boolean) {
  await withTransaction(ctx.db, async (tx) => {
    // One change to the payroll rules at a time, as with the rates.
    await lockFor(tx, `policy:${ctx.organizationId}`)
    const component = await repo.findSalaryComponent(tx, id)
    if (!component) throw NotFound('Salary component not found')
    if (component.type !== 'earning') throw BadRequest(`${component.label} is a deduction, so it cannot be PF wages.`)
    if (component.countsForPf === countsForPf) return
    await repo.setCountsForPf(tx, id, countsForPf)
    await audit(ctx, {
      action: 'salary_component.pf_changed',
      entityType: 'salary_component',
      entityId: id,
      details: { code: component.code, label: component.label, countsForPf },
    }, tx)
  })
  logger.info('PF wages components changed', { by: ctx.userId, componentId: id, countsForPf })
  return listPfComponents(ctx)
}

/** A stored value as the audit log keeps it — a Decimal as its number. */
function plain(value: unknown): unknown {
  return value !== null && typeof value === 'object' && 'toNumber' in value ? (value as { toNumber(): number }).toNumber() : value
}
