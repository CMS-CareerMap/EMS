import type { AppContext } from '../../platform/context'
import { BadRequest, Forbidden } from '../../platform/errors/AppError'
import { addCalendarDays, fromDateColumn, isCalendarDate, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { companyTimezone } from '../organization/organization.service'
import * as repo from './attendance.repository'
import { notOwn } from './punchDevices.service'

/**
 * Suspicious punches (client, 11 Oct 2026), for whoever looks after other
 * people's attendance: everything worth a second look between two days, by
 * person and day — punches refused at the fence or from a computer, punches
 * with a sign they may not be what they seem, and app days the fingerprint
 * machine did not bear out. Evidence to look at, never a verdict.
 */

/** The longest stretch one look covers. */
const MAX_DAYS = 62

type Punch = Awaited<ReturnType<typeof repo.questionablePunches>>[number]
type MachineDay = Awaited<ReturnType<typeof repo.machineQuestionedDays>>[number]

export interface SuspiciousDay {
  employeeId: string
  fullName: string
  employeeCode: string
  date: CalendarDate
  punches: Punch[]
  machine: MachineDay | null
}

/**
 * One person's punches on one day — every one, accepted or refused — for the
 * roster's "Evidence": where, how precisely, from which phone and address,
 * with any flags and the selfie. Only somebody whose attendance reach covers
 * the person; nobody else's punches come back.
 *
 * Never one's own, but for the Super Admin's: a person who could read the
 * signs on their own punches could tune a fake until none showed. Their
 * punches are looked at by somebody above them.
 */
export async function dayEvidence(ctx: AppContext, employeeId: string, date: CalendarDate) {
  if (employeeId === notOwn(ctx)) throw Forbidden('Your own punches are looked at by somebody above you.')
  return repo.punchesOfDay(ctx.db, ctx.scopeFor('attendance'), employeeId, date)
}

export async function suspiciousPunches(ctx: AppContext, input: { from?: string | undefined; to?: string | undefined }) {
  const scope = ctx.scopeFor('attendance')
  if (scope.scope === 'SELF') throw Forbidden('This list is for whoever looks after other people’s attendance.')
  const own = notOwn(ctx)
  const today = zonedToday(new Date(), await companyTimezone(ctx))
  const to = input.to ?? today
  const from = input.from ?? addCalendarDays(to, -6)
  if (!isCalendarDate(from) || !isCalendarDate(to)) throw BadRequest('Give the days as YYYY-MM-DD.')
  if (from > to) throw BadRequest('The first day cannot be after the last.')
  if (addCalendarDays(from, MAX_DAYS - 1) < to) throw BadRequest(`One look covers at most ${MAX_DAYS} days.`)

  const [punches, machineDays] = await Promise.all([
    repo.questionablePunches(ctx.db, scope, from, to, own),
    repo.machineQuestionedDays(ctx.db, scope, from, to, own),
  ])

  const days = new Map<string, SuspiciousDay>()
  const dayOf = (employeeId: string, date: CalendarDate, who: { fullName: string; employeeCode: string }) => {
    const key = `${employeeId}|${date}`
    const day = days.get(key) ?? { employeeId, fullName: who.fullName, employeeCode: who.employeeCode, date, punches: [], machine: null }
    days.set(key, day)
    return day
  }
  for (const p of punches) dayOf(p.employeeId, fromDateColumn(p.date), p.employee).punches.push(p)
  for (const m of machineDays) dayOf(m.employeeId, fromDateColumn(m.date), m.employee).machine = m

  return {
    from,
    to,
    days: [...days.values()].sort((a, b) => b.date.localeCompare(a.date) || a.fullName.localeCompare(b.fullName)),
  }
}
