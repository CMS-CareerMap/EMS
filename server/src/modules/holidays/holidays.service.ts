import type { HolidayType } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { NotFound, Conflict } from '../../platform/errors/AppError'
import { toDateColumn, type CalendarDate } from '../../domain/shared/dates'
import { logger } from '../../platform/logger'
import * as repo from './holidays.repository'

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

  const holiday = await repo.create(ctx.db, ctx.organizationId, { date, name, type: input.type as HolidayType })
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

  const holiday = await repo.update(ctx.db, id, {
    ...(input.date ? { date } : {}),
    ...(input.name !== undefined ? { name } : {}),
    ...(input.type ? { type: input.type as HolidayType } : {}),
  })
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

  await repo.remove(ctx.db, id)
  logger.info('Holiday removed', { by: ctx.userId, id })

  return { approvedLeaveAffected: await approvedLeaveOn(ctx, existing.date) }
}
