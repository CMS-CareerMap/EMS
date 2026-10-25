import type { AppContext } from '../../platform/context'
import type { ScopedDb } from '../../platform/db/scoped'
import { withTransaction, type TxDb } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { BadRequest, NotFound } from '../../platform/errors/AppError'
import { logger } from '../../platform/logger'
import {
  addCalendarDays,
  dayLabel,
  fromDateColumn,
  monthKey,
  monthOfDay,
  monthsBetween,
  toDateColumn,
  zonedToday,
  type CalendarDate,
} from '../../domain/shared/dates'
import { isWeeklyOff } from '../../domain/shared/workWeek'
import { judgedThrough, verdictFor, type DayStatus, type NoCheckInRule, type PersonWindow, type Verdict } from '../../domain/attendance/noCheckIn'
import { workWeekOf } from '../settings/workWeek.repository'
import { closedMonthKeysFor } from '../payroll/payrollLock.service'
import { audit, auditSystem } from '../audit/audit.service'
import type { NoticeActor } from '../notifications/notify.service'
import { tellAbsent } from './attendanceNotices'
import * as repo from './absentRule.repository'

/**
 * No check-in means Absent (client, 25 Oct 2026) — Settings → Attendance
 * Security, and the step of the nightly job that keeps it.
 *
 * ONE STEP PUTS THE DAYS RIGHT: for every month whose payroll is still open,
 * it makes the rows the rule wrote match what the rule says now — it writes
 * the days that are due and takes back the ones that are not. So it can be
 * switched on from any day, switched off, started later or earlier, and run
 * after a holiday or a change of the working week, and the days always end up
 * the same. A month whose payroll is approved or paid is never touched. What
 * each day should be is decided in domain/attendance/noCheckIn; this reads
 * the facts and writes the answer.
 *
 * Run nightly (scripts/maintenance.ts) and right after anything that changes
 * which days are due: the rule's own settings, the working week, a holiday.
 */

export interface AbsentRule {
  on: boolean
  from: CalendarDate | null
  waitDays: number
}

export interface RuleRun {
  /** Days made Absent, and of them half days of leave whose other half was. */
  marked: number
  /** Days the rule wrote that it took back. */
  removed: number
  /** People with a day marked. */
  people: number
  /** Months left as they are because their payroll is closed ("YYYY-MM"). */
  closedMonths: string[]
}

/** How far back the rule looks: a month still open after a year is left as it is. */
const LOOK_BACK_MONTHS = 12

/** After every day: somebody on the app with no login is never judged. */
const NEVER: CalendarDate = '9999-12-31'

function monthsBack(day: CalendarDate, months: number): CalendarDate {
  const { year, month } = monthOfDay(day)
  const index = year * 12 + (month - 1) - months
  return `${monthKey(Math.floor(index / 12), (index % 12) + 1)}-01`
}

function lastOfMonth(year: number, month: number): CalendarDate {
  return `${monthKey(year, month)}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`
}

/** The rule as saved. */
export async function ruleOf(db: ScopedDb | TxDb, organizationId: string): Promise<AbsentRule & { timezone: string }> {
  const row = await repo.ruleOf(db, organizationId)
  if (!row) throw NotFound('Company not found')
  return { on: row.absentWithoutCheckIn, from: fromDateColumn(row.absentWithoutCheckInFrom), waitDays: row.absentWaitDays, timezone: row.timezone }
}

/**
 * Puts the days right. `apply: false` counts what it would do and writes
 * nothing — the preview. `rule` is the rule to count by when it is not the
 * one saved (the preview of a change). `actor` is who caused the run: nobody
 * (the nightly job), or the person whose change it follows.
 */
export async function reconcileAbsent(
  db: ScopedDb,
  organizationId: string,
  options: { apply: boolean; rule?: AbsentRule; now?: Date; actor?: AppContext | null; trigger: string },
): Promise<RuleRun> {
  const saved = await ruleOf(db, organizationId)
  const rule = options.rule ?? saved
  const now = options.now ?? new Date()
  const today = zonedToday(now, saved.timezone)
  const floor = monthsBack(today, LOOK_BACK_MONTHS)

  const createFrom = rule.on && rule.from ? (rule.from > floor ? rule.from : floor) : null
  const managedFrom = await repo.earliestManaged(db, floor).then((d) => fromDateColumn(d))
  const starts = [createFrom, managedFrom].filter((d): d is CalendarDate => d !== null && d <= today).sort()
  const result: RuleRun = { marked: 0, removed: 0, people: 0, closedMonths: [] }
  if (starts.length === 0) return result
  const scanFrom = starts[0]!

  const marked = new Map<string, CalendarDate[]>()
  const domainRule: NoCheckInRule = { on: rule.on, from: rule.from }

  for (const { year, month } of monthsBetween(scanFrom, today)) {
    const key = monthKey(year, month)
    const from = `${key}-01` < scanFrom ? scanFrom : `${key}-01`
    const last = lastOfMonth(year, month)
    const to = last > today ? today : last

    await withTransaction(db, async (tx) => {
      // One run at a time — the night's and one a change set off — then the month's payroll lock, last.
      if (options.apply) await lockFor(tx, `absent-rule:${organizationId}`)
      const closed = await closedMonthKeysFor(tx, organizationId, options.apply ? [key] : [])
      if (closed.has(key)) {
        result.closedMonths.push(key)
        return
      }

      const [people, rows, leave, daysOff, week] = await Promise.all([
        repo.peopleBetween(tx, from, to),
        repo.rowsBetween(tx, from, to),
        repo.approvedLeaveBetween(tx, from, to),
        repo.daysOffBetween(tx, from, to),
        workWeekOf(tx),
      ])
      const holidays = new Set(daysOff.map((d) => fromDateColumn(d.date)))
      const rowOf = new Map(rows.map((r) => [`${r.employeeId}|${fromDateColumn(r.date)}`, r]))
      const leaveOf = new Map<string, 'full' | 'half'>()
      for (const request of leave) {
        for (let d = fromDateColumn(request.fromDate); d <= fromDateColumn(request.toDate); d = addCalendarDays(d, 1)) {
          if (d < from || d > to) continue
          const k = `${request.employeeId}|${d}`
          // Two halves on one day are the whole day, as approvedLeaveOn decides it.
          leaveOf.set(k, leaveOf.has(k) || !request.halfDayDates.includes(d) ? 'full' : 'half')
        }
      }

      const actions: Record<Exclude<Verdict, 'none'>, { id?: string; employeeId: string; date: CalendarDate; was?: DayStatus }[]> = {
        create: [], convert: [], remove: [], to_leave: [], restore: [], forget: [],
      }
      for (const person of people) {
        // Judged from the latest of: the day they joined; the day their record was made — added
        // late, with a joining day gone by, they could not have checked in before it; and, on the
        // app, the day their first login was made — with none, never (they cannot check in).
        const login = person.memberships[0] ? zonedToday(person.memberships[0].createdAt, saved.timezone) : NEVER
        const since = [fromDateColumn(person.dateOfJoining), zonedToday(person.createdAt, saved.timezone), person.attendanceMode === 'app' ? login : null]
          .filter((d): d is CalendarDate => d !== null).sort().at(-1) ?? null
        const window: PersonWindow = {
          joined: since,
          left: fromDateColumn(person.lastWorkingDate),
          judgedThrough: judgedThrough({ mode: person.attendanceMode, shift: person.shift, today, now, timezone: saved.timezone, waitDays: rule.waitDays }),
        }
        for (let d = from; d <= to; d = addCalendarDays(d, 1)) {
          const k = `${person.id}|${d}`
          const row = rowOf.get(k)
          const verdict = verdictFor(domainRule, window, {
            date: d,
            off: isWeeklyOff(week, d) || holidays.has(d),
            leave: leaveOf.get(k) ?? null,
            row: row ? { status: row.status, source: row.source, checkedIn: row.checkIn !== null, statusBeforeSystem: row.statusBeforeSystem } : null,
          })
          if (verdict === 'none') continue
          actions[verdict].push({ ...(row ? { id: row.id } : {}), employeeId: person.id, date: d, ...(row?.statusBeforeSystem ? { was: row.statusBeforeSystem } : {}) })
        }
      }
      // A row the rule wrote for somebody no longer among a month's people (their joining moved past it): taken back.
      const here = new Set(people.map((p) => p.id))
      for (const row of rows) {
        if (here.has(row.employeeId)) continue
        if (row.source === 'system') actions.remove.push({ id: row.id, employeeId: row.employeeId, date: fromDateColumn(row.date) })
        else if (row.statusBeforeSystem && row.status === 'absent' && !row.checkIn) actions.restore.push({ id: row.id, employeeId: row.employeeId, date: fromDateColumn(row.date), was: row.statusBeforeSystem })
      }

      const ids = (list: { id?: string }[]) => list.map((a) => a.id!).filter(Boolean)
      if (!options.apply) {
        result.marked += actions.create.length + actions.convert.length
        result.removed += actions.remove.length + actions.to_leave.length + actions.restore.length
        for (const a of [...actions.create, ...actions.convert]) marked.set(a.employeeId, [...(marked.get(a.employeeId) ?? []), a.date])
        return
      }

      const created = await repo.createAbsent(tx, organizationId, actions.create.map((a) => ({ employeeId: a.employeeId, date: a.date })))
      const converted = await repo.convertHalfLeave(tx, ids(actions.convert))
      result.marked += created + converted
      result.removed += (await repo.removeAbsent(tx, ids(actions.remove)))
        + (await repo.absentToLeave(tx, ids(actions.to_leave)))
        + (await repo.restoreHalfLeave(tx, actions.restore.map((a) => ({ id: a.id!, to: a.was ?? 'on_leave' }))))
      await repo.forgetBefore(tx, ids(actions.forget))

      // Each person told once for the month, with every day newly absent — and how to undo it. Read
      // back first: a day somebody wrote a moment ago (a late check-in) was not marked, and is not told.
      const nowAbsent = new Set((await repo.rowsBetween(tx, from, to))
        .filter((r) => r.source === 'system' || (r.status === 'absent' && r.statusBeforeSystem !== null))
        .map((r) => `${r.employeeId}|${fromDateColumn(r.date)}`))
      const newly = new Map<string, CalendarDate[]>()
      for (const a of [...actions.create, ...actions.convert]) {
        if (nowAbsent.has(`${a.employeeId}|${a.date}`)) newly.set(a.employeeId, [...(newly.get(a.employeeId) ?? []), a.date])
      }
      const actor: NoticeActor = options.actor ?? { userId: '', organizationId }
      for (const [employeeId, days] of newly) {
        await tellAbsent(actor, tx, employeeId, days, { includeActor: true, noCheckIn: true })
        marked.set(employeeId, [...(marked.get(employeeId) ?? []), ...days])
      }
    }, { timeout: 60_000 })
  }

  result.people = marked.size
  if (options.apply && (result.marked > 0 || result.removed > 0)) {
    const entry = {
      action: 'attendance.absent_rule' as const,
      entityType: 'organization',
      entityId: organizationId,
      details: { trigger: options.trigger, marked: result.marked, removed: result.removed, people: result.people },
    }
    if (options.actor) await audit(options.actor, entry)
    else await withTransaction(db, (tx) => auditSystem(tx, organizationId, entry))
  }
  logger.info('No-check-in rule run', { organizationId, trigger: options.trigger, apply: options.apply, ...result })
  return result
}

/**
 * After a change that moves which days are due — the working week, a holiday —
 * the days are put right at once. A failure here does not undo the change
 * that was saved: it is logged, and the nightly run puts the days right.
 */
export async function reconcileAfter(ctx: AppContext, trigger: string): Promise<void> {
  try {
    await reconcileAbsent(ctx.db, ctx.organizationId, { apply: true, actor: ctx, trigger })
  } catch (err) {
    logger.error('No-check-in rule could not run after a change; the nightly run will', { organizationId: ctx.organizationId, trigger, err })
  }
}

// ── The setting ──────────────────────────────────────────────────────────────

export interface AbsentRuleView extends AbsentRule {
  today: CalendarDate
  /** The earliest day the rule may start from: the 1st of last month. */
  earliestFrom: CalendarDate
}

export async function getAbsentRule(ctx: AppContext): Promise<AbsentRuleView> {
  const rule = await ruleOf(ctx.db, ctx.organizationId)
  const today = zonedToday(new Date(), rule.timezone)
  return { on: rule.on, from: rule.from, waitDays: rule.waitDays, today, earliestFrom: monthsBack(today, 1) }
}

/**
 * The rule as it may be saved. A start day is checked against "the 1st of last
 * month" unless the rule stays on from the day it had: a rule on since
 * September keeps its day in November, and its wait can still be changed —
 * but switched back on, it starts again, and from a recent day.
 */
function checked(input: AbsentRule, today: CalendarDate, saved: { on: boolean; from: CalendarDate | null }): AbsentRule {
  if (!Number.isInteger(input.waitDays) || input.waitDays < 1 || input.waitDays > 14) throw BadRequest('Wait between 1 and 14 days.')
  if (!input.on) return input
  if (!input.from) throw BadRequest('Choose the day the rule starts from.')
  const earliest = monthsBack(today, 1)
  if (!(saved.on && input.from === saved.from) && input.from < earliest) throw BadRequest(`The rule can start on ${dayLabel(earliest)} at the earliest: the 1st of last month.`)
  if (input.from > addCalendarDays(today, 366)) throw BadRequest('The rule can start at most a year from today.')
  return input
}

/** What saving would do — nothing written. */
export async function previewAbsentRule(ctx: AppContext, input: AbsentRule): Promise<RuleRun> {
  const view = await getAbsentRule(ctx)
  return reconcileAbsent(ctx.db, ctx.organizationId, { apply: false, rule: checked(input, view.today, view), trigger: 'preview' })
}

/** Saves the rule, audited, and puts the days right by it at once. */
export async function saveAbsentRule(ctx: AppContext, input: AbsentRule): Promise<{ rule: AbsentRuleView; run: RuleRun }> {
  const before = await getAbsentRule(ctx)
  const next = checked(input, before.today, before)
  const changes = Object.fromEntries(
    (['on', 'from', 'waitDays'] as const).filter((k) => next[k] !== before[k]).map((k) => [k, { from: before[k], to: next[k] }]),
  )
  if (Object.keys(changes).length > 0) {
    await withTransaction(ctx.db, async (tx) => {
      await repo.saveRule(tx, ctx.organizationId, {
        absentWithoutCheckIn: next.on,
        absentWithoutCheckInFrom: next.from ? toDateColumn(next.from) : null,
        absentWaitDays: next.waitDays,
      })
      await audit(ctx, { action: 'absent_rule.updated', entityType: 'organization', entityId: ctx.organizationId, details: { changes } }, tx)
    })
  }
  const run = await reconcileAbsent(ctx.db, ctx.organizationId, { apply: true, actor: ctx, trigger: 'settings' })
  return { rule: await getAbsentRule(ctx), run }
}

