import type { AppContext } from '../../platform/context'
import { NotFound, Conflict, BadRequest } from '../../platform/errors/AppError'
import { zonedToday, toDateColumn, fromDateColumn, addCalendarDays } from '../../domain/shared/dates'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import * as repo from './settings.repository'

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
  dateFormat?: string | undefined
  country?: string | undefined
  currency?: string | undefined
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

  const updated = await repo.updateOrganization(ctx.db, ctx.organizationId, data)

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
  esiEmployeeRate?: number | undefined
  esiEmployerRate?: number | undefined
  esiThreshold?: number | undefined
  payDay?: number | undefined
  payslipLockDay?: number | null | undefined
  weeklyOffDays?: number[] | undefined
  leaveYearStartMonth?: number | undefined
  fiscalYearStartMonth?: number | undefined
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

  return ctx.db.organizationPolicy.create({
    data: {
      organizationId: ctx.organizationId,
      effectiveFrom: await companyToday(ctx),
      createdByUserId: ctx.userId,
    },
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

  const policyId = await withTransaction(ctx.db, async (tx) => {
    const current = await tx.organizationPolicy.findFirst({
      where: { effectiveTo: null },
      orderBy: { effectiveFrom: 'desc' },
    })

    if (!current) {
      const created = await tx.organizationPolicy.create({
        data: {
          organizationId: ctx.organizationId,
          effectiveFrom: from,
          createdByUserId: ctx.userId,
          ...data,
        },
      })
      return created.id
    }

    if (current.effectiveFrom.getTime() === from.getTime()) {
      await tx.organizationPolicy.update({ where: { id: current.id }, data })
      return current.id
    }

    // Close yesterday, open today. The old row keeps every number it had, so
    // a payslip from that period is still explainable.
    await tx.organizationPolicy.update({
      where: { id: current.id },
      data: { effectiveTo: toDateColumn(addCalendarDays(fromDateColumn(from), -1)) },
    })

    const created = await tx.organizationPolicy.create({
      data: {
        organizationId: ctx.organizationId,
        effectiveFrom: from,
        createdByUserId: ctx.userId,
        // Carry forward everything that was not explicitly changed, or the new
        // period would silently reset untouched rates to their defaults.
        pfEmployeeRate: current.pfEmployeeRate,
        pfEmployerRate: current.pfEmployerRate,
        pfRestrictToCeiling: current.pfRestrictToCeiling,
        pfWageCeiling: current.pfWageCeiling,
        esiEmployeeRate: current.esiEmployeeRate,
        esiEmployerRate: current.esiEmployerRate,
        esiThreshold: current.esiThreshold,
        payDay: current.payDay,
        payslipLockDay: current.payslipLockDay,
        weeklyOffDays: current.weeklyOffDays,
        leaveYearStartMonth: current.leaveYearStartMonth,
        fiscalYearStartMonth: current.fiscalYearStartMonth,
        ...data,
      },
    })

    return created.id
  })

  logger.info('Statutory policy updated', { by: ctx.userId, fields: Object.keys(data) })

  const policy = await ctx.db.organizationPolicy.findFirst({ where: { id: policyId } })
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
  const existing = await ctx.db.geofenceLocation.findFirst({ where: { name: input.name } })

  const data = {
    latitude: input.latitude,
    longitude: input.longitude,
    radiusMeters: input.radiusMeters,
    ...(input.maxAccuracyMeters === undefined ? {} : { maxAccuracyMeters: input.maxAccuracyMeters }),
    ...(input.isActive === undefined ? {} : { isActive: input.isActive }),
  }

  const saved = existing
    ? await ctx.db.geofenceLocation.update({ where: { id: existing.id }, data })
    : await ctx.db.geofenceLocation.create({
        data: { organizationId: ctx.organizationId, name: input.name, ...data },
      })

  logger.info('Geofence saved', { by: ctx.userId, name: input.name })
  return saved
}

export async function deleteGeofence(ctx: AppContext, id: string) {
  const existing = await ctx.db.geofenceLocation.findFirst({ where: { id } })
  if (!existing) throw NotFound('Location not found')
  await ctx.db.geofenceLocation.delete({ where: { id } })
}

export interface LeaveTypeInput {
  name?: string | undefined
  code?: string | undefined
  annualQuota?: number | undefined
  isPaid?: boolean | undefined
  carryForward?: boolean | undefined
  carryForwardCap?: number | undefined
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
  const values = {
    name,
    code,
    annualQuota: input.annualQuota ?? 0,
    isPaid: input.isPaid ?? true,
    carryForward: input.carryForward ?? false,
    carryForwardCap: input.carryForwardCap ?? 0,
  }

  const matches = await repo.findLeaveTypesLike(ctx.db, code, name)
  const active = matches.find((t) => !t.archivedAt)
  if (active) throw Conflict(`A leave type called ${active.name} (${active.code}) already exists`)

  if (matches.length > 1) {
    throw Conflict('An archived leave type already uses that name, and another that code. Add it back under its own name and code.')
  }

  if (matches.length === 1) {
    const restored = await ctx.db.leaveType.update({
      where: { id: matches[0]!.id },
      data: { ...values, archivedAt: null },
    })
    logger.info('Leave type restored', { by: ctx.userId, id: restored.id })
    return { row: restored, restored: true }
  }

  const row = await ctx.db.leaveType.create({ data: { organizationId: ctx.organizationId, ...values } })
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

  if (Object.keys(data).length === 0) throw BadRequest('Nothing to update')

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

  return ctx.db.leaveType.update({ where: { id }, data })
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

  await ctx.db.leaveType.update({ where: { id }, data: { archivedAt: new Date() } })
  logger.info('Leave type archived', { by: ctx.userId, id })
}

export async function listPtSlabs(ctx: AppContext, state?: string) {
  return repo.listPtSlabs(ctx.db, state)
}

