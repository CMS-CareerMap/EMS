import { addCalendarDays, parseWallClock, zonedDayStart, type CalendarDate } from '../shared/dates'

/**
 * No check-in means Absent (client, 25 Oct 2026).
 *
 * "Punch nahi rhega to absent hi mana jayega": a working day that ends with no
 * punch, no leave and nobody's mark is Absent — for everybody, from the day the
 * company chooses. Before this, such a day stayed "not marked" and was paid.
 *
 * Pure: what one day of one person should be, from the facts about it. The
 * service reads the facts, asks this for every day it may write, and writes
 * what this says — so the nightly job, a change of settings, a new holiday and
 * the preview all decide the same way.
 *
 * THE RULE ONLY EVER CHANGES WHAT IT WROTE. A day with a punch, a leave, a
 * correction, HR's mark or the machine's file is somebody's word about it,
 * and stands. Two things are its own:
 *   - a day it wrote: no row at all, now Absent with the source `system`;
 *   - a day of half-day leave with no punch for the other half, made Absent —
 *     half paid as leave, half loss of pay — with what it was kept
 *     (`statusBeforeSystem`), so it can be put back.
 * When a day is no longer due — the rule switched off or started later, the
 * day made a holiday or a weekly off, leave approved for all of it, the
 * person's employment moved — the rule takes back what it wrote.
 */

export type DayStatus = 'present' | 'half_day' | 'absent' | 'on_leave' | 'holiday' | 'weekly_off'

export interface NoCheckInRule {
  on: boolean
  /** The first day the rule applies to. Null with the rule off. */
  from: CalendarDate | null
}

export interface PersonWindow {
  /** Their first and last day here; null when not recorded. */
  joined: CalendarDate | null
  left: CalendarDate | null
  /**
   * The last day that can be judged for them now: a day is judged once it is
   * over — their shift ended (a night shift the next morning), or, for days
   * that come from the fingerprint machine's file or HR's marking, once the
   * days of waiting for them have passed. Worked out by the caller.
   */
  judgedThrough: CalendarDate
}

export interface DayRow {
  status: DayStatus
  source: string
  checkedIn: boolean
  statusBeforeSystem: DayStatus | null
}

export interface DayFacts {
  date: CalendarDate
  /** A weekly off by the week in force on it, or a holiday for everybody. */
  off: boolean
  /** Approved leave on the day: all of it, half of it, or none. */
  leave: 'full' | 'half' | null
  row: DayRow | null
}

export type Verdict =
  /** Nothing to do. */
  | 'none'
  /** No row: write Absent, "no check-in". */
  | 'create'
  /** A half-day leave row with no punch: make it Absent, keeping what it was. */
  | 'convert'
  /** A row the rule wrote, no longer due: remove it. */
  | 'remove'
  /** A row the rule wrote, now covered by leave for the whole day: it says leave. */
  | 'to_leave'
  /** A half-day leave row the rule made Absent, no longer due: put it back. */
  | 'restore'
  /** A row somebody else has written since the rule touched it: forget what it was. */
  | 'forget'

/** Whether the rule makes this day Absent, rows apart. */
export function isDue(rule: NoCheckInRule, person: PersonWindow, day: DayFacts): boolean {
  if (!rule.on || rule.from === null || day.date < rule.from) return false
  if (person.joined && day.date < person.joined) return false
  if (person.left && day.date > person.left) return false
  if (day.date > person.judgedThrough) return false
  return !day.off && day.leave !== 'full'
}

export function verdictFor(rule: NoCheckInRule, person: PersonWindow, day: DayFacts): Verdict {
  const due = isDue(rule, person, day)
  const row = day.row
  if (!row) return due ? 'create' : 'none'

  if (row.source === 'system') {
    if (due) return 'none'
    // All of it on leave now — two halves approved one by one, which approving does not take over.
    return day.leave === 'full' && !day.off ? 'to_leave' : 'remove'
  }

  if (row.statusBeforeSystem !== null) {
    if (row.status !== 'absent' || row.checkedIn) return 'forget'
    return due && day.leave === 'half' ? 'none' : 'restore'
  }

  // Half a day on leave, and nothing for the other half: that half is absent.
  if (row.status === 'on_leave' && row.source === 'leave' && !row.checkedIn && day.leave === 'half') {
    return due ? 'convert' : 'none'
  }
  return 'none'
}

/**
 * When a day is over for somebody: the end of their shift — the next morning
 * for a night shift, which may be checked into after midnight — or, with no
 * shift (or one whose times cannot be read), midnight. Until then they can
 * still check in, so the day is not judged.
 */
export function dayEndsAt(day: CalendarDate, shift: { startTime: string; endTime: string } | null, timezone: string): Date {
  const midnight = zonedDayStart(addCalendarDays(day, 1), timezone)
  if (!shift) return midnight
  const start = parseWallClock(shift.startTime)
  const end = parseWallClock(shift.endTime)
  if (start === null || end === null) return midnight
  const minutes = end <= start ? end + 1440 : end
  return new Date(zonedDayStart(day, timezone).getTime() + minutes * 60_000)
}

/**
 * The last day that can be judged for somebody now. On the app: the latest of
 * the last few days whose shift has ended. From the machine's file or HR's
 * marking: the days of waiting the company gave them (at least one), so a day
 * is not called absent before its file or its mark could come.
 */
export function judgedThrough(input: {
  mode: 'app' | 'biometric' | 'manual'
  shift: { startTime: string; endTime: string } | null
  today: CalendarDate
  now: Date
  timezone: string
  waitDays: number
}): CalendarDate {
  if (input.mode !== 'app') return addCalendarDays(input.today, -Math.max(1, input.waitDays))
  for (let back = 0; back <= 2; back++) {
    const day = addCalendarDays(input.today, -back)
    if (input.now.getTime() >= dayEndsAt(day, input.shift, input.timezone).getTime()) return day
  }
  return addCalendarDays(input.today, -3)
}

/**
 * Checked in and never out, and no longer their day (client, 25 Oct 2026: "No
 * out" on the roster, and in its export). The day stays present; HR puts the
 * check-out in. Not while they are still at work; a day of today only once its
 * shift has ended. A day HR typed is as HR left it — the form fills in a
 * check-in by itself, so "present, no times" is not a check-out forgotten.
 */
export function noCheckOut(day: {
  checkedIn: boolean
  checkedOut: boolean
  hoursWorked: number | null
  source: string
  atWork: boolean
  isToday: boolean
  dayOver: boolean
}): boolean {
  return day.checkedIn && !day.checkedOut && !day.atWork && day.hoursWorked === null && day.source !== 'manual' && (!day.isToday || day.dayOver)
}
