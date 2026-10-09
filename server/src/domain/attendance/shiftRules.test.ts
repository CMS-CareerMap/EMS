import { describe, it, expect } from 'vitest'
import { forWorkedHalf, fullDayHoursFor, measureDay, minutesLabel, nextCheckInOpens, openDayCarries, overnightDayOpen, stillAtWork, type ShiftRules } from './shiftRules'

/** A day against its shift (client §34–35). Times are minutes from the date's midnight. */

const GENERAL: ShiftRules = {
  startTime: '09:00', endTime: '18:00', expectedHours: 8,
  graceMinutes: 10, lateThresholdMinutes: 120, earlyLeavingMinutes: 60,
  minFullDayHours: null, minHalfDayHours: null, overtimeAfterMinutes: 30,
}
const at = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))

describe('a day against its shift', () => {
  it('measures nothing without a shift — as before shifts had rules', () => {
    expect(measureDay({ rules: null, checkIn: at('11:00'), checkOut: at('20:00'), hoursWorked: 8 })).toEqual({
      lateMinutes: null, earlyLeavingMinutes: null, overtimeMinutes: null, classification: null, reason: null,
    })
  })

  it('forgives the grace either side, and counts every minute past it', () => {
    expect(measureDay({ rules: GENERAL, checkIn: at('09:10'), checkOut: at('17:50'), hoursWorked: 7.67 })).toMatchObject({ lateMinutes: 0, earlyLeavingMinutes: 0 })
    expect(measureDay({ rules: GENERAL, checkIn: at('09:11'), checkOut: at('17:49'), hoursWorked: 7.63 })).toMatchObject({ lateMinutes: 11, earlyLeavingMinutes: 11 })
  })

  it('makes a long enough day a half day when late or early past the threshold', () => {
    const late = measureDay({ rules: GENERAL, checkIn: at('11:01'), checkOut: at('20:30'), hoursWorked: 8.48 })
    expect(late).toMatchObject({ lateMinutes: 121, reason: 'late', classification: { status: 'half_day' } })
    const early = measureDay({ rules: GENERAL, checkIn: at('07:00'), checkOut: at('16:59'), hoursWorked: 8.98 })
    expect(early).toMatchObject({ earlyLeavingMinutes: 61, reason: 'early', classification: { status: 'half_day' } })
    // No threshold: marked, never costs the day.
    const lenient = measureDay({ rules: { ...GENERAL, lateThresholdMinutes: null }, checkIn: at('11:01'), checkOut: at('20:30'), hoursWorked: 8.48 })
    expect(lenient).toMatchObject({ lateMinutes: 121, reason: null, classification: { status: 'present' } })
  })

  it('counts overtime once past the threshold — then all of it', () => {
    expect(measureDay({ rules: GENERAL, checkIn: at('09:00'), checkOut: at('19:29'), hoursWorked: 8.48 }).overtimeMinutes).toBe(0)
    expect(measureDay({ rules: GENERAL, checkIn: at('09:00'), checkOut: at('19:30'), hoursWorked: 8.5 }).overtimeMinutes).toBe(30)
    expect(measureDay({ rules: GENERAL, checkIn: at('09:00'), checkOut: at('21:00'), hoursWorked: 11 }).overtimeMinutes).toBe(180)
  })

  it('takes the shift’s own minimum hours over the fractions', () => {
    const rules = { ...GENERAL, minFullDayHours: 7.5, minHalfDayHours: 3 }
    expect(measureDay({ rules, checkIn: at('09:00'), checkOut: at('16:00'), hoursWorked: 7 }).classification?.status).toBe('half_day')
    expect(measureDay({ rules, checkIn: at('09:00'), checkOut: at('12:30'), hoursWorked: 3.5 }).classification?.status).toBe('half_day')
    expect(measureDay({ rules, checkIn: at('09:00'), checkOut: at('11:00'), hoursWorked: 2 }).classification?.status).toBe('absent')
    // Without them: three quarters of 8 is 6, so 7 hours is a full day.
    expect(measureDay({ rules: { ...GENERAL, earlyLeavingMinutes: null }, checkIn: at('09:00'), checkOut: at('16:00'), hoursWorked: 7 }).classification?.status).toBe('present')
  })

  it('measures a night shift across midnight', () => {
    const night: ShiftRules = { ...GENERAL, startTime: '22:00', endTime: '06:00' }
    // In at 22:20, out at 06:00 the next morning — 1440 + 360.
    expect(measureDay({ rules: night, checkIn: at('22:20'), checkOut: 1440 + at('06:00'), hoursWorked: 6.67 })).toMatchObject({ lateMinutes: 20, earlyLeavingMinutes: 0 })
  })

  it('does not call a time half a day away late or early', () => {
    expect(measureDay({ rules: GENERAL, checkIn: at('23:30'), checkOut: null, hoursWorked: null }).lateMinutes).toBeNull()
  })

  it('keeps a night shift’s day open into the next morning, and a day shift’s never', () => {
    const night: ShiftRules = { ...GENERAL, startTime: '22:00', endTime: '06:00' }
    const on = (instant: string) => overnightDayOpen({ rules: night, date: '2026-10-03', timezone: 'Asia/Kolkata', now: new Date(instant) })
    // The evening it began is still "today": nothing to carry over.
    expect(on('2026-10-03T23:00:00+05:30')).toBe(false)
    // The next morning, at the end and well after it.
    expect(on('2026-10-04T06:00:00+05:30')).toBe(true)
    expect(on('2026-10-04T17:59:00+05:30')).toBe(true)
    // Twelve hours past the end it is a day nobody closed; the next shift starts afresh — at 18:00 itself.
    expect(on('2026-10-04T18:00:00+05:30')).toBe(false)
    expect(on('2026-10-05T05:00:00+05:30')).toBe(false)
    // A day shift left open yesterday is not today's.
    expect(overnightDayOpen({ rules: GENERAL, date: '2026-10-03', timezone: 'Asia/Kolkata', now: new Date('2026-10-04T02:00:00+05:30') })).toBe(false)
    expect(overnightDayOpen({ rules: null, date: '2026-10-03', timezone: 'Asia/Kolkata', now: new Date('2026-10-04T02:00:00+05:30') })).toBe(false)
  })

  it('opens the next night’s check-in in time for a long night shift', () => {
    // 20:00–08:00: twelve hours past the end would be 20:00, the start itself — so two hours before it.
    expect(nextCheckInOpens({ ...GENERAL, startTime: '20:00', endTime: '08:00' })).toBe('18:00')
    expect(nextCheckInOpens({ ...GENERAL, startTime: '22:00', endTime: '06:00' })).toBe('18:00')
    expect(nextCheckInOpens(GENERAL)).toBeNull()
  })

  it('carries a day shift left open only through the small hours', () => {
    const open = (instant: string, rules: ShiftRules | null = { ...GENERAL, startTime: '09:30' }) =>
      openDayCarries({ rules, date: '2026-10-03', timezone: 'Asia/Kolkata', now: new Date(instant) })
    // Worked past midnight: checked out of at 01:00.
    expect(open('2026-10-04T01:00:00+05:30')).toBe(true)
    // From three hours before the shift starts again, a new day: 06:30 for 09:30.
    expect(open('2026-10-04T06:29:00+05:30')).toBe(true)
    expect(open('2026-10-04T06:30:00+05:30')).toBe(false)
    expect(open('2026-10-04T09:00:00+05:30')).toBe(false)
    // No shift: until 06:00.
    expect(open('2026-10-04T05:59:00+05:30', null)).toBe(true)
    expect(open('2026-10-04T06:00:00+05:30', null)).toBe(false)
  })

  it('says the hours a full day needs, as check-out grades it — for the card to count down to (client, 9 Oct 2026)', () => {
    const client: ShiftRules = { ...GENERAL, startTime: '09:30', endTime: '18:30', expectedHours: 9, minFullDayHours: 8, minHalfDayHours: 4.5 }
    expect(fullDayHoursFor(client, 9, null)).toBe(8)
    // Half the day on leave: half of it.
    expect(fullDayHoursFor(client, 9, 'first_half')).toBe(4)
    expect(fullDayHoursFor(client, 9, 'second_half')).toBe(4)
    // A shift with no minimums of its own: three quarters of the hours it was expected to be.
    expect(fullDayHoursFor({ ...client, minFullDayHours: null, minHalfDayHours: null }, 9, null)).toBe(6.75)
    // Graded against the hours frozen on the day, not the shift's now.
    expect(fullDayHoursFor({ ...client, minFullDayHours: null, minHalfDayHours: null }, 8, null)).toBe(6)
    // No shift, or no hours recorded: nothing grades the day.
    expect(fullDayHoursFor(null, 9, null)).toBeNull()
    expect(fullDayHoursFor(client, null, null)).toBeNull()
  })

  it('says who is still at work, by the rule their own card counts by (client, 9 Oct 2026)', () => {
    const day = { ...GENERAL, startTime: '09:30', endTime: '18:30' }
    const night: ShiftRules = { ...GENERAL, startTime: '22:00', endTime: '06:00' }
    const atWork = (o: { date: string; checkIn: string | null; checkOut?: string | null; now: string; rules?: ShiftRules | null; checkedInToday?: boolean }) =>
      stillAtWork({
        date: o.date, today: o.now.slice(0, 10), checkIn: o.checkIn ? new Date(o.checkIn) : null, checkOut: o.checkOut ? new Date(o.checkOut) : null,
        rules: o.rules === undefined ? day : o.rules, timezone: 'Asia/Kolkata', now: new Date(o.now), checkedInToday: o.checkedInToday ?? false,
      })
    // Today, checked in and not out: at work. Out, or never in: not.
    expect(atWork({ date: '2026-10-09', checkIn: '2026-10-09T09:31:00+05:30', now: '2026-10-09T11:00:00+05:30' })).toBe(true)
    expect(atWork({ date: '2026-10-09', checkIn: '2026-10-09T09:31:00+05:30', checkOut: '2026-10-09T18:40:00+05:30', now: '2026-10-09T19:00:00+05:30' })).toBe(false)
    expect(atWork({ date: '2026-10-09', checkIn: null, now: '2026-10-09T11:00:00+05:30' })).toBe(false)
    // A night shift begun yesterday at 22:00: at work at 03:00 — unless they have checked in today.
    expect(atWork({ date: '2026-10-08', checkIn: '2026-10-08T22:00:00+05:30', now: '2026-10-09T03:00:00+05:30', rules: night })).toBe(true)
    expect(atWork({ date: '2026-10-08', checkIn: '2026-10-08T22:00:00+05:30', now: '2026-10-09T03:00:00+05:30', rules: night, checkedInToday: true })).toBe(false)
    // A day shift left open: carried through the small hours, then forgotten.
    expect(atWork({ date: '2026-10-08', checkIn: '2026-10-08T09:31:00+05:30', now: '2026-10-09T01:00:00+05:30' })).toBe(true)
    expect(atWork({ date: '2026-10-08', checkIn: '2026-10-08T09:31:00+05:30', now: '2026-10-09T08:00:00+05:30' })).toBe(false)
    // Never past twenty hours, even while the shift would carry it.
    expect(atWork({ date: '2026-10-08', checkIn: '2026-10-08T05:00:00+05:30', now: '2026-10-09T02:00:00+05:30', rules: null })).toBe(false)
    // A check-in typed for later today has not happened yet.
    expect(atWork({ date: '2026-10-09', checkIn: '2026-10-09T18:00:00+05:30', now: '2026-10-09T10:00:00+05:30' })).toBe(false)
    // Older days are forgotten check-outs.
    expect(atWork({ date: '2026-10-07', checkIn: '2026-10-07T09:31:00+05:30', now: '2026-10-09T01:00:00+05:30' })).toBe(false)
  })

  it('measures the worked half of a half day of leave from its own start or end', () => {
    const shift: ShiftRules = { ...GENERAL, startTime: '09:30', endTime: '18:30', expectedHours: 9 }
    // Morning on leave: the day starts at 14:00, so arriving then is on time.
    expect(forWorkedHalf(shift, 'first_half')).toMatchObject({ startTime: '14:00', endTime: '18:30', expectedHours: 4.5 })
    // Afternoon on leave: it ends at 14:00, so leaving then is not early.
    expect(forWorkedHalf(shift, 'second_half')).toMatchObject({ startTime: '09:30', endTime: '14:00' })
    const morningOff = measureDay({ rules: forWorkedHalf(shift, 'first_half'), checkIn: at('14:00'), checkOut: at('18:30'), hoursWorked: 4.5 })
    expect(morningOff.lateMinutes).toBe(0)
  })

  it('says minutes as people do', () => {
    expect(minutesLabel(150)).toBe('2h 30m')
    expect(minutesLabel(60)).toBe('1h')
    expect(minutesLabel(45)).toBe('45m')
  })
})
