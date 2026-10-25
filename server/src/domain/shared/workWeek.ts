import { addCalendarDays, type CalendarDate } from './dates'

/**
 * The company's working week, day by day (client, 25 Oct 2026).
 *
 * Weekly offs are dated: "from 1 November, Saturday and Sunday". A day is off
 * by the rule in force ON THAT DAY — as a holiday is — so a change saved today
 * changes today and later, never a day already counted, and every screen that
 * asks about a day gets the same answer: the leave count, the calendar, the
 * month so far, payroll, the reports, the home page.
 *
 * Before this, the month's calendar and payroll went by the rule in force on
 * the 1st, while the leave count and the home page went by today's: a change
 * on the 25th made Saturday the 31st off for leave and a working day for pay.
 *
 * THIS IS THE ONE PLACE a weekly off is decided. Nothing else reads the
 * weekdays of a rule (scripts/architecture.ts, rule 9).
 */

/** Sunday is 0, matching getUTCDay(). */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6

/** From `from`, these weekdays are off — until the next rule begins. */
export interface WorkWeekRule {
  from: CalendarDate
  offDays: readonly Weekday[]
}

/**
 * The rules over time, earliest first. A plain list of weekdays is the same
 * week every day: what a test, or a leave type counted in calendar days
 * (nothing off), passes.
 */
export type WorkWeek = { readonly rules: readonly WorkWeekRule[] }

export type WeekInput = WorkWeek | readonly Weekday[]

/**
 * Sunday, when a company has no rule written at all — the column's default
 * since the working week became a setting, and the common Indian office.
 */
const NO_RULE: readonly Weekday[] = [0]

export function weekdayOf(day: CalendarDate): Weekday {
  return new Date(`${day}T00:00:00Z`).getUTCDay() as Weekday
}

/** A week from rows in any order; rules on the same day keep the last given. */
export function workWeek(rules: readonly WorkWeekRule[]): WorkWeek {
  const byDay = new Map<CalendarDate, WorkWeekRule>()
  for (const rule of rules) byDay.set(rule.from, { from: rule.from, offDays: [...new Set(rule.offDays)].sort() as Weekday[] })
  return { rules: [...byDay.values()].sort((a, b) => a.from.localeCompare(b.from)) }
}

/**
 * The weekdays off on a day: the latest rule begun by then. Before the first
 * rule, the first one — the week the company has always worked, as far as
 * anything recorded says; with none at all, Sunday.
 */
export function offDaysOn(week: WeekInput, day: CalendarDate): readonly Weekday[] {
  if (Array.isArray(week)) return week as readonly Weekday[]
  const { rules } = week as WorkWeek
  if (rules.length === 0) return NO_RULE
  let found = rules[0]!
  for (const rule of rules) {
    if (rule.from > day) break
    found = rule
  }
  return found.offDays
}

export function isWeeklyOff(week: WeekInput, day: CalendarDate): boolean {
  return offDaysOn(week, day).includes(weekdayOf(day))
}

/** The rule in force on a day, and when it began — null before the first, or with none. */
export function ruleOn(week: WorkWeek, day: CalendarDate): WorkWeekRule | null {
  let found: WorkWeekRule | null = null
  for (const rule of week.rules) {
    if (rule.from > day) break
    found = rule
  }
  return found
}

/** The rules that begin after a day: changes saved for later. */
export function scheduledAfter(week: WorkWeek, day: CalendarDate): WorkWeekRule[] {
  return week.rules.filter((rule) => rule.from > day)
}

/**
 * The week once `offDays` is saved from `from`. FROM THAT DAY ON the week is
 * this: a later change saved before is replaced by it, since "from the 1st,
 * Saturday and Sunday" says what every day after the 1st is.
 */
export function withRuleFrom(week: WorkWeek, from: CalendarDate, offDays: readonly Weekday[]): WorkWeek {
  return workWeek([...week.rules.filter((rule) => rule.from < from), { from, offDays }])
}

/** The days from `from` to `to` whose being off differs between two weeks. */
export function daysThatChange(before: WeekInput, after: WeekInput, from: CalendarDate, to: CalendarDate): CalendarDate[] {
  const changed: CalendarDate[] = []
  for (let day = from; day <= to; day = addCalendarDays(day, 1)) {
    if (isWeeklyOff(before, day) !== isWeeklyOff(after, day)) changed.push(day)
  }
  return changed
}
