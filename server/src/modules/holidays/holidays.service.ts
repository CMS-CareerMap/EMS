import type { HolidayType } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { NotFound, Conflict } from '../../platform/errors/AppError'
import { toDateColumn, fromDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { logger } from '../../platform/logger'
import * as repo from './holidays.repository'
import { withAudit } from '../audit/audit.service'
import { assertDaysOpen } from '../payroll/payrollLock.service'

/**
 * The holiday calendar.
 *
 * Seeded with the three holidays whose dates never move; everything else —
 * Diwali, Holi, Eid, the state holidays — moves every year and has to be
 * entered. Until this existed nobody could enter it, so leave was charged for
 * Diwali and attendance expected people in on it.
 *
 * A PUBLIC holiday is off for everybody: leave is not charged for it. An
 * OPTIONAL one is each employee's choice from a short list, so it does not
 * make the day free for anyone automatically.
 *
 * WHAT A CHANGE DOES NOT DO: leave already approved was charged on the
 * calendar as it stood. Adding a holiday inside somebody's approved leave does
 * not hand the day back by itself — the count of such requests is returned so
 * the page can say so, and the day can be credited deliberately.
 */

export interface HolidayInput {
  date: CalendarDate
  name: string
  type: 'public' | 'optional'
}

export async function list(ctx: AppContext, year?: number) {
  return repo.listForYear(ctx.db, year)
}

async function approvedLeaveOn(ctx: AppContext, date: Date) {
  return repo.countApprovedLeaveCovering(ctx.db, date)
}

export async function add(ctx: AppContext, input: HolidayInput) {
  const date = toDateColumn(input.date)
  const name = input.name.trim()

  const same = await repo.findSame(ctx.db, date, name)
  if (same) throw Conflict(`"${same.name}" is already on ${input.date}`)

  // A holiday decides which days are paid as days off.
  await assertDaysOpen(ctx, [input.date], 'a holiday on that day')

  const holiday = await withAudit(
    ctx,
    (tx) => repo.create(tx, ctx.organizationId, { date, name, type: input.type as HolidayType }),
    (row) => ({ action: 'holiday.added', entityType: 'holiday', entityId: row.id, details: { date: input.date, name, type: input.type } }),
  )
  logger.info('Holiday added', { by: ctx.userId, date: input.date, type: input.type })

  return { holiday, approvedLeaveAffected: await approvedLeaveOn(ctx, date) }
}

export async function edit(ctx: AppContext, id: string, input: Partial<HolidayInput>) {
  const existing = await repo.findById(ctx.db, id)
  if (!existing) throw NotFound('That holiday does not exist')

  const date = input.date ? toDateColumn(input.date) : existing.date
  const name = input.name !== undefined ? input.name.trim() : existing.name

  const same = await repo.findSame(ctx.db, date, name)
  if (same && same.id !== id) throw Conflict(`"${same.name}" is already on that day`)

  // Both days: the one it leaves and the one it moves to.
  await assertDaysOpen(ctx, [fromDateColumn(existing.date), fromDateColumn(date)], 'moving this holiday')

  const holiday = await withAudit(
    ctx,
    (tx) =>
      repo.update(tx, id, {
        ...(input.date ? { date } : {}),
        ...(input.name !== undefined ? { name } : {}),
        ...(input.type ? { type: input.type as HolidayType } : {}),
      }),
    (row) => ({
      action: 'holiday.changed',
      entityType: 'holiday',
      entityId: id,
      details: {
        from: { date: fromDateColumn(existing.date), name: existing.name, type: existing.type },
        to: { date: fromDateColumn(row.date), name: row.name, type: row.type },
      },
    }),
  )
  logger.info('Holiday changed', { by: ctx.userId, id })

  return { holiday, approvedLeaveAffected: await approvedLeaveOn(ctx, date) }
}

/**
 * Removes a holiday outright. A calendar entry is configuration, not a record
 * anybody's pay is computed from after the fact — leave already approved keeps
 * the count it was charged.
 */
export async function remove(ctx: AppContext, id: string) {
  const existing = await repo.findById(ctx.db, id)
  if (!existing) throw NotFound('That holiday does not exist')

  await assertDaysOpen(ctx, [fromDateColumn(existing.date)], 'removing this holiday')

  await withAudit(
    ctx,
    (tx) => repo.remove(tx, id),
    () => ({ action: 'holiday.removed', entityType: 'holiday', entityId: id, details: { date: fromDateColumn(existing.date), name: existing.name, type: existing.type } }),
  )
  logger.info('Holiday removed', { by: ctx.userId, id })

  return { approvedLeaveAffected: await approvedLeaveOn(ctx, existing.date) }
}
