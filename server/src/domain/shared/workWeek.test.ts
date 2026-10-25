import { describe, it, expect } from 'vitest'
import { daysThatChange, isWeeklyOff, offDaysOn, ruleOn, scheduledAfter, withRuleFrom, workWeek } from './workWeek'
import { workingDays } from '../leave/leaveDays'
import { monthCalendar } from '../payroll/payDays'

/**
 * The working week, day by day (client, 25 Oct 2026): every count of a day —
 * leave, the month's calendar, payroll — asks the week in force ON THAT DAY.
 */

// Sundays until Sunday 25 Oct 2026; Saturday and Sunday from then.
const week = workWeek([
  { from: '2021-04-01', offDays: [0] },
  { from: '2026-10-25', offDays: [0, 6] },
])

describe('which weekdays are off on a day', () => {
  it('goes by the rule begun by then', () => {
    expect(offDaysOn(week, '2026-10-24')).toEqual([0])
    expect(offDaysOn(week, '2026-10-25')).toEqual([0, 6])
    expect(offDaysOn(week, '2027-01-01')).toEqual([0, 6])
  })

  it('takes the first rule for a day before it — the week as far back as anything says', () => {
    expect(offDaysOn(week, '2019-01-01')).toEqual([0])
  })

  it('is Sunday with no rule at all, as the column always defaulted', () => {
    expect(offDaysOn(workWeek([]), '2026-10-31')).toEqual([0])
  })

  it('treats a plain list as the same week every day — what a type counted in calendar days passes', () => {
    expect(isWeeklyOff([], '2026-10-25')).toBe(false)
    expect(isWeeklyOff([6], '2026-10-31')).toBe(true)
  })

  it('keeps Saturday the 24th a working day and makes Saturday the 31st off', () => {
    expect(isWeeklyOff(week, '2026-10-24')).toBe(false)
    expect(isWeeklyOff(week, '2026-10-31')).toBe(true)
  })

  it('sorts rules given in any order, and keeps the last of two on one day', () => {
    const w = workWeek([{ from: '2026-11-01', offDays: [6, 0] }, { from: '2026-01-01', offDays: [0] }, { from: '2026-11-01', offDays: [5] }])
    expect(w.rules.map((r) => r.from)).toEqual(['2026-01-01', '2026-11-01'])
    expect(offDaysOn(w, '2026-11-02')).toEqual([5])
  })
})

describe('a change from a day', () => {
  it('replaces everything saved from that day on — from the 1st, the week is this', () => {
    const scheduled = workWeek([{ from: '2021-04-01', offDays: [0] }, { from: '2026-12-01', offDays: [0, 6] }])
    const changed = withRuleFrom(scheduled, '2026-11-01', [5, 6])
    expect(changed.rules).toEqual([{ from: '2021-04-01', offDays: [0] }, { from: '2026-11-01', offDays: [5, 6] }])
  })

  it('names the days whose being off differs', () => {
    const after = withRuleFrom(workWeek([{ from: '2021-04-01', offDays: [0] }]), '2026-10-25', [0, 6])
    expect(daysThatChange(workWeek([{ from: '2021-04-01', offDays: [0] }]), after, '2026-10-01', '2026-10-31')).toEqual(['2026-10-31'])
  })

  it('knows the rule in force and the changes saved for later', () => {
    expect(ruleOn(week, '2026-10-30')).toEqual({ from: '2026-10-25', offDays: [0, 6] })
    expect(ruleOn(week, '2019-01-01')).toBeNull()
    expect(scheduledAfter(week, '2026-10-20').map((r) => r.from)).toEqual(['2026-10-25'])
  })
})

describe('every count of a day agrees', () => {
  it('leave is not charged for Saturday the 31st, and is for Saturday the 24th', () => {
    const counted = workingDays({ from: '2026-10-23', to: '2026-10-31', weeklyOffDays: week, holidays: [] })
    const reason = (d: string) => counted.breakdown.find((b) => b.date === d)?.reason
    expect(reason('2026-10-24')).toBe('working')
    expect(reason('2026-10-31')).toBe('weekly_off')
    // Fri 23, Sat 24, Mon 26–Fri 30: seven days; Sundays 25 and Saturday 31 off.
    expect(counted.days).toBe(7)
  })

  it('payroll’s month says the same of the same days', () => {
    const october = monthCalendar({ year: 2026, month: 10, weeklyOffDays: week, holidays: ['2026-10-02'] })
    const kind = (d: string) => october.days.find((x) => x.date === d)?.kind
    expect(kind('2026-10-24')).toBe('working')
    expect(kind('2026-10-31')).toBe('weekly_off')
    // 31 days, four Sundays, Saturday the 31st, and Gandhi Jayanti.
    expect(october.workingDays).toBe(31 - 4 - 1 - 1)
  })
})
