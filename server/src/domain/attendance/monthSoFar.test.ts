import { describe, it, expect } from 'vitest'
import { monthSoFar, type SoFarInput, type SoFarRow } from './monthSoFar'

/**
 * The month so far (client, 15 Oct 2026): opened on the 15th, the 1st to the
 * 15th. October 2026 starts on a Thursday; Sundays are the weekly off, and the
 * 2nd is a holiday (Gandhi Jayanti).
 */
const SUNDAYS = ['2026-10-04', '2026-10-11', '2026-10-18', '2026-10-25']
const daysOff = [{ date: '2026-10-02', kind: 'holiday' as const }, ...SUNDAYS.map((date) => ({ date, kind: 'weekly_off' as const }))]
const row = (date: string, status: string | null, hoursWorked: number | null = null, lateMinutes: number | null = null, checkedIn = status === 'present' || status === 'half_day'): SoFarRow =>
  ({ date, status, hoursWorked, lateMinutes, checkedIn })
const base: SoFarInput = { year: 2026, month: 10, today: '2026-10-15', joined: '2025-01-06', left: null, daysOff, rows: [], expectedPerDay: 9 }

describe('the month so far (client, 15 Oct 2026)', () => {
  it('opened on the 15th counts the 1st to the 15th: working days, offs, holidays', () => {
    const r = monthSoFar(base)
    expect([r.from, r.to, r.ongoing]).toEqual(['2026-10-01', '2026-10-15', true])
    // 15 days: the 2nd a holiday, the 4th and 11th Sundays.
    expect([r.workingDays, r.holidays, r.weeklyOffs]).toEqual([12, 1, 2])
    // Nothing said of the 11 working days before today: not marked — today is not over.
    expect(r.notMarked).toBe(11)
  })

  it('counts each day by what it was, the hours of the days closed, late arrivals and the hours expected', () => {
    const r = monthSoFar({
      ...base,
      rows: [
        row('2026-10-01', 'present', 8.5, 0),
        row('2026-10-03', 'present', 9, 12),
        row('2026-10-05', 'half_day', 4.75),
        row('2026-10-06', 'absent'),
        row('2026-10-07', 'on_leave'),
        row('2026-10-08', 'on_leave'),
        // Today, checked in and still at work: present, no hours yet.
        row('2026-10-15', 'present', null, 0),
      ],
    })
    expect([r.present, r.halfDays, r.absent, r.onLeave]).toEqual([3, 1, 1, 2])
    expect(r.hoursWorked).toBe(22.25)
    expect([r.daysWorked, r.averageHours]).toEqual([3, 7.42])
    expect([r.arrivals, r.lateDays]).toEqual([4, 1])
    // 2 present days closed + half of 1 half day, at 9 hours a day — today counts once it is closed, as its hours do.
    expect(r.expectedHours).toBe(22.5)
    // 12 working days − 7 recorded (today among them) = the 9th, 10th, 12th, 13th and 14th not marked.
    expect(r.notMarked).toBe(5)
  })

  it('joined mid-month: counted from the day they joined', () => {
    const r = monthSoFar({ ...base, joined: '2026-10-12' })
    expect([r.from, r.workingDays, r.weeklyOffs, r.holidays]).toEqual(['2026-10-12', 4, 0, 0])
  })

  it('left mid-month: counted to their last day; a month after they left counts nothing', () => {
    const r = monthSoFar({ ...base, left: '2026-10-06' })
    expect([r.to, r.ongoing, r.workingDays]).toEqual(['2026-10-06', false, 4])
    expect(monthSoFar({ ...base, year: 2026, month: 11, today: '2026-11-20', left: '2026-10-06' }).from).toBeNull()
  })

  it('a past month is the whole month; a month not begun counts nothing', () => {
    const past = monthSoFar({ ...base, today: '2026-11-03' })
    expect([past.from, past.to, past.ongoing, past.workingDays]).toEqual(['2026-10-01', '2026-10-31', false, 26])
    const ahead = monthSoFar({ ...base, month: 12 })
    expect([ahead.from, ahead.workingDays, ahead.hoursWorked]).toEqual([null, 0, 0])
  })

  it('no shift: no hours expected, never a made-up figure', () => {
    expect(monthSoFar({ ...base, expectedPerDay: null }).expectedHours).toBeNull()
  })

  it('a worked weekly off counts as present, and still as a weekly off — never as not marked', () => {
    const r = monthSoFar({ ...base, rows: [row('2026-10-04', 'present', 6)] })
    expect([r.present, r.weeklyOffs, r.hoursWorked]).toEqual([1, 2, 6])
    expect(r.notMarked).toBe(11)
  })

  it('a working day marked a holiday or a weekly off for this person is a day off, as payroll pays it — never not marked', () => {
    const r = monthSoFar({ ...base, rows: [row('2026-10-05', 'holiday'), row('2026-10-06', 'weekly_off')] })
    expect([r.workingDays, r.holidays, r.weeklyOffs]).toEqual([10, 2, 3])
    expect(r.notMarked).toBe(9)
  })
})
