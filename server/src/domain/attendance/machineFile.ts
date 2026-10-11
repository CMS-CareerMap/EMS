/**
 * The fingerprint machine's file (client, 11 Oct 2026), read whatever the
 * machine is — and matched against the app's days.
 *
 * Pure: lines in, days and verdicts out. No database, no time zone; minutes
 * are counted from the day's midnight on the company's clock, and run past
 * 1440 into the next morning for a night shift.
 *
 * Two shapes of file are read, and may be mixed:
 *   - ONE LINE A DAY: code, date, in, out — what the import always read;
 *   - ONE LINE A SCAN: code and a time (the date in its own column or in the
 *     same one), as many lines a day as the finger touched the machine.
 * Either way, a person's day is its scans together: THE FIRST IS THE CHECK-IN
 * AND THE LAST IS THE CHECK-OUT (Devesh, 11 Oct 2026). One scan alone is a
 * check-in with no check-out.
 */
import { addCalendarDays, isCalendarDate, parseWallClock, type CalendarDate } from '../shared/dates'
import { scanBelongsToNightBefore, type ShiftRules } from './shiftRules'

/** What a machine calls each column, as read (lower case, spaces and dashes as underscores, other signs dropped). */
export const MACHINE_HEADERS: Record<'code' | 'date' | 'checkIn' | 'checkOut' | 'time', readonly string[]> = {
  code: ['employee_code', 'employee_id', 'emp_code', 'emp_id', 'code', 'user_id', 'userid', 'ac_no', 'acno', 'enroll_no', 'enrollno', 'enroll_number', 'badgenumber', 'badge_number', 'emp_no', 'empno', 'employee_no', 'machine_id', 'id_no', 'person_id'],
  date: ['date', 'att_date', 'attendance_date', 'punch_date', 'log_date'],
  checkIn: ['check_in', 'in_time', 'in', 'punch_in', 'first_in', 'intime'],
  checkOut: ['check_out', 'out_time', 'out', 'punch_out', 'last_out', 'outtime'],
  // One scan: a time alone, or the date and time together.
  time: ['time', 'punch_time', 'log_time', 'logtime', 'checktime', 'check_time', 'datetime', 'date_time', 'timestamp', 'att_time', 'scan_time', 'punch'],
}

export function machineHeader(header: string): string {
  const cleaned = header
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .replace(/[^a-z0-9_]/g, '')
  for (const [field, aliases] of Object.entries(MACHINE_HEADERS)) {
    if (aliases.includes(cleaned)) return field
  }
  return cleaned
}

/** DD/MM/YYYY, DD-MM-YYYY or YYYY-MM-DD. */
export function parseMachineDate(value: string): CalendarDate | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return isCalendarDate(trimmed) ? trimmed : null
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(trimmed)
  if (!dmy) return null
  const [, d, m, y] = dmy
  const iso = `${y}-${m!.padStart(2, '0')}-${d!.padStart(2, '0')}`
  return isCalendarDate(iso) ? iso : null
}

/**
 * Minutes past midnight, from what firmware writes: "09:30", "09:30:00",
 * "9:30 AM", "9:30:15 pm" — sometimes all in one file. Seconds are dropped.
 */
export function parseMachineTime(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const ampm = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)$/i.exec(trimmed)
  if (ampm) {
    let hours = Number(ampm[1])
    const minutes = Number(ampm[2])
    if (hours < 1 || hours > 12 || minutes > 59) return null
    if (hours === 12) hours = 0
    if (ampm[3]!.toUpperCase() === 'PM') hours += 12
    return hours * 60 + minutes
  }
  const plain = /^(\d{1,2}):(\d{2})(?::\d{2})?$/.exec(trimmed)
  return plain ? parseWallClock(`${plain[1]}:${plain[2]}`) : null
}

/** A scan's date and time from one column — "10/10/2026 10:08:15", "2026-10-10 10:08", "2026-10-10T10:08:00". */
export function parseMachineDateTime(value: string): { date: CalendarDate; minutes: number } | null {
  const match = /^(\S+?)[T\s]+(.+)$/.exec(value.trim())
  if (!match) return null
  const date = parseMachineDate(match[1]!)
  const minutes = parseMachineTime(match[2]!)
  return date && minutes !== null ? { date, minutes } : null
}

/** One line of the file, read: whose, which day it says, and the times on it. */
export interface MachineLine {
  line: number
  /** Whose: the employee it was matched to. */
  employeeId: string
  date: CalendarDate
  /** One line a day: its in and out. One line a scan: its one time, as `scan`. */
  checkIn: number | null
  checkOut: number | null
  scan: number | null
}

/**
 * A person's day on the machine: the first scan and — with two or more — the
 * last. A day whose only line is a check-out with no check-in (one line a day)
 * has no first: what the machine said, and nothing made up.
 */
export interface MachineDay {
  employeeId: string
  date: CalendarDate
  /** Minutes from the day's midnight; past 1440 is the next morning. */
  first: number | null
  last: number | null
  scans: number
  lines: number[]
  /** Whether a scan of the next morning was moved to this night (`scanBelongsToNightBefore`). */
  nightMoved: boolean
}

/**
 * Lines into days. A line a day keeps its own date, its out at or before its
 * in being the next morning (a night shift, as the import always read it), and
 * an out with no in stays an out. A line a scan goes to its own date — or, for
 * somebody on a night shift, an early-morning scan to the night before
 * (`scanBelongsToNightBefore`).
 */
export function machineDays(lines: readonly MachineLine[], shiftOf: (employeeId: string) => ShiftRules | null): MachineDay[] {
  const days = new Map<string, { employeeId: string; date: CalendarDate; times: number[]; outsOnly: number[]; lines: number[]; nightMoved: boolean }>()
  const dayOf = (employeeId: string, date: CalendarDate, line: number) => {
    const key = `${employeeId}|${date}`
    const day = days.get(key) ?? { employeeId, date, times: [], outsOnly: [], lines: [], nightMoved: false }
    if (!day.lines.includes(line)) day.lines.push(line)
    days.set(key, day)
    return day
  }
  for (const l of lines) {
    if (l.scan !== null) {
      const night = scanBelongsToNightBefore(shiftOf(l.employeeId), l.scan)
      const day = dayOf(l.employeeId, night ? addCalendarDays(l.date, -1) : l.date, l.line)
      day.times.push(night ? l.scan + 1440 : l.scan)
      if (night) day.nightMoved = true
      continue
    }
    if (l.checkIn !== null) dayOf(l.employeeId, l.date, l.line).times.push(l.checkIn)
    if (l.checkOut !== null) {
      const day = dayOf(l.employeeId, l.date, l.line)
      if (l.checkIn !== null) day.times.push(l.checkOut <= l.checkIn ? l.checkOut + 1440 : l.checkOut)
      else day.outsOnly.push(l.checkOut)
    }
  }
  return [...days.values()]
    .filter((d) => d.times.length + d.outsOnly.length > 0)
    .map((d) => {
      const lines = d.lines.sort((a, b) => a - b)
      const scans = d.times.length + d.outsOnly.length
      // Only check-outs, no check-in anywhere that day: the latest is the check-out.
      if (d.times.length === 0) return { employeeId: d.employeeId, date: d.date, first: null, last: Math.max(...d.outsOnly), scans, lines, nightMoved: d.nightMoved }
      const times = [...new Set([...d.times, ...d.outsOnly])].sort((a, b) => a - b)
      return { employeeId: d.employeeId, date: d.date, first: times[0]!, last: times.length > 1 ? times[times.length - 1]! : null, scans, lines, nightMoved: d.nightMoved }
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.employeeId.localeCompare(b.employeeId))
}

/**
 * A night cut by the file's edge, made whole: the scans the file has for it
 * and the times already recorded for it — an earlier file's evening, this
 * file's morning. The first is the earliest, the last the latest.
 */
export function mergeScans(day: { first: number | null; last: number | null }, recorded: readonly (number | null)[]): { first: number | null; last: number | null } {
  const times = [...new Set([day.first, day.last, ...recorded].filter((t): t is number => t !== null))].sort((a, b) => a - b)
  if (times.length === 0) return { first: null, last: null }
  if (day.first === null && recorded.every((t) => t === null)) return { first: null, last: day.last }
  return { first: times[0]!, last: times.length > 1 ? times[times.length - 1]! : null }
}

export type MachineMatchResult = 'confirmed' | 'time_differs' | 'not_on_machine'

/**
 * An app day against the machine's. Any scan that day confirms the person was
 * there; the times only add a note: the first scan more than `tolerance`
 * minutes from the app's check-in — or, with a later scan and an app check-out,
 * the last from the check-out — is "time differs". Never absent for a time. No
 * scan at all is "not on the machine".
 */
export function matchMachineDay(app: { checkIn: number | null; checkOut: number | null }, machine: { first: number | null; last: number | null } | null, tolerance: number): { result: MachineMatchResult; inDiff: number | null; outDiff: number | null } {
  if (!machine) return { result: 'not_on_machine', inDiff: null, outDiff: null }
  const inDiff = app.checkIn !== null && machine.first !== null ? Math.abs(app.checkIn - machine.first) : null
  const outDiff = app.checkOut !== null && machine.last !== null ? Math.abs(app.checkOut - machine.last) : null
  const differs = (inDiff !== null && inDiff > tolerance) || (outDiff !== null && outDiff > tolerance)
  return { result: differs ? 'time_differs' : 'confirmed', inDiff, outDiff }
}
