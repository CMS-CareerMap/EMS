import type { RequestHandler } from 'express'
import type { Prisma } from '@prisma/client'
import * as settings from '../../modules/settings/settings.service'
import {
  companySchema,
  policySchema,
  geofenceSchema,
  leaveTypeSchema,
  settingsIdSchema,
  ptSlabQuerySchema,
  ptTableSchema,
  pfComponentSchema,
} from '../validators/settings.validator'
import { parseBody } from '../validators/parse'
import { setPtTable } from '../../modules/settings/ptSlabs.service'
import { appContext } from '../context'
import { fromDateColumn } from '../../domain/shared/dates'
import { isUnlimited } from '../../domain/leave/leaveDays'

/**
 * Settings. Snake_case out, matching the rest of v1 and the form field names
 * the page already uses.
 */

function num(value: Prisma.Decimal | null): number | null {
  return value == null ? null : Number(value)
}

/** Sunday first, matching getUTCDay() and the stored numbers. */
const WEEKDAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

const ok = (res: Parameters<RequestHandler>[1], data: unknown, extra: object = {}) =>
  res.status(200).json({ data, meta: { requestId: res.locals.requestId, ...extra } })

type Company = Awaited<ReturnType<typeof settings.getCompany>>

function companyPayload(org: Company) {
  return {
    name: org.name,
    legal_name: org.legalName,
    gstin: org.gstin,
    pan: org.pan,
    address: org.addressLine,
    city: org.city,
    state: org.state,
    pincode: org.pincode,
    phone: org.phone,
    email: org.email,
    website: org.website,
    timezone: org.timezone,
    country: org.country,
    currency: org.currency,
    max_upload_mb: org.maxUploadMb,
  }
}

/** GET /api/settings/company */
export const getCompany: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  ok(res, companyPayload(await settings.getCompany(ctx)))
}

/** PUT /api/settings/company */
export const putCompany: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  // The page sends `address`; the column is `addressLine` because `address` is
  // ambiguous once there is a second line. Mapped here, in the one place that
  // knows about both names.
  const body = req.body as Record<string, unknown>
  if ('address' in body) {
    body.addressLine = body.address
    delete body.address
  }

  const input = parseBody(companySchema, body)
  const updated = await settings.updateCompany(ctx, input)

  ok(res, companyPayload(updated))
}

type Policy = Awaited<ReturnType<typeof settings.getPolicy>>

function policyPayload(policy: Policy) {
  return {
    pf_employee: num(policy.pfEmployeeRate),
    pf_employer: num(policy.pfEmployerRate),
    pf_restrict_to_ceiling: policy.pfRestrictToCeiling,
    pf_wage_ceiling: num(policy.pfWageCeiling),
    eps_wage_ceiling: num(policy.epsWageCeiling),
    // The Labour Codes' wages rule: PF wages are at least this share of what was earned.
    wages_share_enabled: policy.wagesShareEnabled,
    wages_share_percent: num(policy.wagesSharePercent),
    esi_employee: num(policy.esiEmployeeRate),
    esi_employer: num(policy.esiEmployerRate),
    esi_threshold: num(policy.esiThreshold),
    pay_day: policy.payDay,
    payslip_lock: policy.payslipLockDay,
    // Numbers for the form to bind to, and names so a settings page can
    // render "Saturday, Sunday" without a lookup table of its own.
    weekly_off_days: policy.weeklyOffDays,
    weekly_off_day_names: policy.weeklyOffDays.map((d) => WEEKDAY_NAMES[d] ?? String(d)),
    leave_year_start_month: policy.leaveYearStartMonth,
    fiscal_year_start_month: policy.fiscalYearStartMonth,
    lop_basis: policy.lopBasis,
    sandwich_rule: policy.sandwichRule,
    tds_enabled: policy.tdsEnabled,
    overtime_enabled: policy.overtimeEnabled,
    overtime_rate: num(policy.overtimeRate),
    overtime_basis: policy.overtimeBasis,
    encashment_basis: policy.encashmentBasis,
    effective_from: fromDateColumn(policy.effectiveFrom),
  }
}

/** GET /api/settings/payroll */
export const getPolicy: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  ok(res, policyPayload(await settings.getPolicy(ctx)))
}

/** PUT /api/settings/payroll */
export const putPolicy: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(policySchema, req.body)
  const updated = await settings.updatePolicy(ctx, input)

  ok(res, policyPayload(updated))
}

type PfComponent = Awaited<ReturnType<typeof settings.listPfComponents>>[number]

const pfComponentPayload = (row: PfComponent) => ({
  id: row.id,
  code: row.code,
  label: row.label,
  // "monthly" is entered per person per month (an incentive); "fixed" is on the salary.
  entry: row.entry,
  counts_for_pf: row.countsForPf,
})

/** GET /api/settings/pf-components — the earnings, and which of them are PF wages. */
export const getPfComponents: RequestHandler = async (_req, res) => {
  ok(res, (await settings.listPfComponents(appContext(res))).map(pfComponentPayload))
}

/** PATCH /api/settings/pf-components/:id — counts it as PF wages, or stops. */
export const patchPfComponent: RequestHandler = async (req, res) => {
  const { id } = parseBody(settingsIdSchema, req.params)
  const { countsForPf } = parseBody(pfComponentSchema, req.body)
  ok(res, (await settings.setCountsForPf(appContext(res), id, countsForPf)).map(pfComponentPayload))
}

/**
 * GET /api/settings/payroll/history
 *
 * Every rate the company has ever used, with the period it applied to. This is
 * what makes "the payslip says ₹1,800 but the rate is 12% of ₹20,000" an
 * answerable question rather than an argument.
 */
export const getPolicyHistory: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await settings.listPolicyHistory(ctx)

  ok(
    res,
    rows.map((policy) => ({
      id: policy.id,
      effective_from: fromDateColumn(policy.effectiveFrom),
      effective_to: fromDateColumn(policy.effectiveTo),
      pf_employee: num(policy.pfEmployeeRate),
      pf_employer: num(policy.pfEmployerRate),
      esi_employee: num(policy.esiEmployeeRate),
      esi_employer: num(policy.esiEmployerRate),
      esi_threshold: num(policy.esiThreshold),
      pay_day: policy.payDay,
      // The Labour Codes' wages rule, as it stood in that period.
      wages_share_enabled: policy.wagesShareEnabled,
      wages_share_percent: num(policy.wagesSharePercent),
    })),
  )
}

type Geofence = Awaited<ReturnType<typeof settings.listGeofences>>[number]

function geofencePayload(row: Geofence) {
  return {
    id: row.id,
    name: row.name,
    latitude: num(row.latitude),
    longitude: num(row.longitude),
    radius_meters: row.radiusMeters,
    // The page has always worked in kilometres. Sent alongside rather than
    // instead of, so nothing has to convert to display it.
    radius_km: row.radiusMeters / 1000,
    max_accuracy_meters: row.maxAccuracyMeters,
    is_active: row.isActive,
  }
}

/** GET /api/settings/geofence */
export const getGeofences: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await settings.listGeofences(ctx)
  ok(res, rows.map(geofencePayload))
}

/** PUT /api/settings/geofence */
export const putGeofence: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(geofenceSchema, req.body)
  await settings.saveGeofence(ctx, input)

  const rows = await settings.listGeofences(ctx)
  ok(res, rows.map(geofencePayload))
}

/** DELETE /api/settings/geofence/:id */
export const deleteGeofence: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(settingsIdSchema, req.params)
  await settings.deleteGeofence(ctx, id)
  res.status(204).end()
}

function serializeLeaveType(row: {
  id: string
  name: string
  code: string
  annualQuota: Prisma.Decimal
  isPaid: boolean
  carryForward: boolean
  carryForwardCap: Prisma.Decimal
  minNoticeDays: number
  maxDaysPerRequest: Prisma.Decimal | null
  eligibleAfterDays: number
  eligibleGender: string | null
  accrual: string
  halfDayAllowed: boolean
  countsNonWorkingDays: boolean
  encashable: boolean
  encashMaxDaysPerYear: Prisma.Decimal | null
  joinerGrant: string
  usableAfterConfirmation: boolean
}) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    days: num(row.annualQuota),
    paid: row.isPaid,
    carry_forward: row.carryForward,
    carry_forward_cap: num(row.carryForwardCap),
    min_notice_days: row.minNoticeDays,
    max_days_per_request: row.maxDaysPerRequest === null ? null : num(row.maxDaysPerRequest),
    eligible_after_days: row.eligibleAfterDays,
    eligible_gender: row.eligibleGender,
    accrual: row.accrual,
    half_day_allowed: row.halfDayAllowed,
    counts_non_working_days: row.countsNonWorkingDays,
    encashable: row.encashable,
    encash_max_days_per_year: row.encashMaxDaysPerYear === null ? null : num(row.encashMaxDaysPerYear),
    joiner_grant: row.joinerGrant,
    usable_after_confirmation: row.usableAfterConfirmation,
    // Unpaid with no days a year: no limit — Loss of Pay (client, 9 Oct 2026).
    unlimited: isUnlimited(row.isPaid, Number(row.annualQuota)),
  }
}

/** GET /api/settings/leave-types */
export const getLeaveTypes: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await settings.listLeaveTypes(ctx)
  ok(res, rows.map(serializeLeaveType))
}

/** POST /api/settings/leave-types */
export const postLeaveType: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(leaveTypeSchema, req.body)
  const { row, restored } = await settings.createLeaveType(ctx, input)

  // 200 for a type brought back, and said, so the page can tell the person
  // their old type — and its history — reappeared.
  res.status(restored ? 200 : 201).json({
    data: serializeLeaveType(row),
    meta: { requestId: res.locals.requestId, restored },
  })
}

/** PATCH /api/settings/leave-types/:id */
export const patchLeaveType: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(settingsIdSchema, req.params)
  const input = parseBody(leaveTypeSchema, req.body)

  const { row, balances, thisYear } = await settings.updateLeaveType(ctx, id, input)
  // What a change of days did to balances already granted: this year's when
  // asked, and next year's when granted in advance.
  res.status(200).json({
    data: serializeLeaveType(row),
    meta: {
      requestId: res.locals.requestId,
      balances: balances ? { this_year: thisYear, people: balances.people, days: balances.days, not_taken_back: balances.short } : null,
    },
  })
}

/** DELETE /api/settings/leave-types/:id — archives, never deletes. */
export const deleteLeaveType: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(settingsIdSchema, req.params)
  await settings.archiveLeaveType(ctx, id)
  res.status(204).end()
}

/** GET /api/settings/pt-slabs */
export const getPtSlabs: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { state } = parseBody(ptSlabQuerySchema, req.query)
  const rows = await settings.listPtSlabs(ctx, state)

  ok(res, rows.map(ptSlabRow))
}

type PtSlabRow = Awaited<ReturnType<typeof settings.listPtSlabs>>[number]

function ptSlabRow(row: PtSlabRow) {
  return {
    id: row.id,
    state: row.state,
    min_gross: num(row.minGross),
    max_gross: num(row.maxGross),
    amount: num(row.amount),
    gender: row.gender,
    february_amount: row.februaryAmount == null ? null : num(row.februaryAmount),
    effective_from: fromDateColumn(row.effectiveFrom),
  }
}

/**
 * PUT /api/settings/pt-slabs
 *
 * Replaces one state's table from a date. Refuses a table that could take more
 * than the ₹2,500 a year the Constitution allows, or that leaves a salary in no
 * slab, with the reasons in words.
 */
export const putPtSlabs: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(ptTableSchema, req.body)
  const rows = await setPtTable(ctx, input)
  ok(res, rows.map(ptSlabRow))
}

