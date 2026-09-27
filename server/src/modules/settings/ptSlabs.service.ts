import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict } from '../../platform/errors/AppError'
import { ptTableProblems, ptTableRows, type PtSlabDraft } from '../../domain/payroll/statutory'
import { toDateColumn, fromDateColumn, addCalendarDays, type CalendarDate } from '../../domain/shared/dates'
import { logger } from '../../platform/logger'
import * as repo from './settings.repository'

/**
 * Setting a state's professional-tax table.
 *
 * PT is per state, and only Maharashtra is seeded. An employee who works in
 * Karnataka had no slabs to match and paid no PT, with a warning on every
 * calculation and no way to act on it. This is the way to act on it.
 *
 * The table is replaced as a whole, from a date — the same rule as salaries
 * and rates: a later date closes the old table the day before, the same date
 * corrects it, an earlier one is refused. A state's slabs are one decision; a
 * half-edited table in force for a day would charge somebody the wrong amount.
 */

export interface PtTableInput {
  state: string
  effectiveFrom: CalendarDate
  slabs: PtSlabDraft[]
}

export async function setPtTable(ctx: AppContext, input: PtTableInput) {
  const problems = ptTableProblems(input.slabs)
  if (problems.length > 0) throw BadRequest(problems.join(' '), problems)

  const typed = input.state.trim()
  const open = await repo.listOpenPtSlabsForState(ctx.db, typed)
  // Keep the spelling already on record, so "maharashtra" typed in lower case
  // revises Maharashtra's table instead of starting a second one.
  const state = open[0]?.state ?? typed
  const openFrom = open.length > 0 ? fromDateColumn(open[0]!.effectiveFrom) : null

  const rows = ptTableRows(input.slabs).map((row) => ({
    gender: row.gender,
    minGross: row.wageFrom,
    maxGross: row.wageTo,
    amount: row.amount,
    februaryAmount: row.februaryAmount,
  }))

  let kind: 'first' | 'revision' | 'correction'
  if (!openFrom) {
    kind = 'first'
    await repo.replacePtTable(ctx.db, ctx.organizationId, {
      state, effectiveFrom: toDateColumn(input.effectiveFrom), deleteIds: [], closeIds: [], closeOn: null, rows,
    })
  } else if (input.effectiveFrom === openFrom) {
    kind = 'correction'
    await repo.replacePtTable(ctx.db, ctx.organizationId, {
      state, effectiveFrom: toDateColumn(input.effectiveFrom), deleteIds: open.map((s) => s.id), closeIds: [], closeOn: null, rows,
    })
  } else if (input.effectiveFrom > openFrom) {
    kind = 'revision'
    await repo.replacePtTable(ctx.db, ctx.organizationId, {
      state,
      effectiveFrom: toDateColumn(input.effectiveFrom),
      deleteIds: [],
      closeIds: open.map((s) => s.id),
      closeOn: toDateColumn(addCalendarDays(input.effectiveFrom, -1)),
      rows,
    })
  } else {
    throw Conflict(
      `${state}'s current table started on ${openFrom}. A new one cannot start before it — correct the current table (same date), or start the new one after it.`,
    )
  }

  logger.info('PT table set', { by: ctx.userId, state, kind, effectiveFrom: input.effectiveFrom })
  return repo.listPtSlabs(ctx.db, state)
}
