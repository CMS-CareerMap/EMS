import { describe, it, expect } from 'vitest'
import { measureDay, minutesLabel, type ShiftRules } from './shiftRules'

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

  it('says minutes as people do', () => {
    expect(minutesLabel(150)).toBe('2h 30m')
    expect(minutesLabel(60)).toBe('1h')
    expect(minutesLabel(45)).toBe('45m')
  })
})
