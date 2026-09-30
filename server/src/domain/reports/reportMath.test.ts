import { describe, it, expect } from 'vitest'
import { attendancePercent, leaveDaysWithin, notMarkedDays, overlap } from './reportMath'

// September 2026: the 1st is a Tuesday; Sundays are the 6th, 13th, 20th, 27th.
const SUNDAYS_OFF = { weeklyOffDays: [0] as const, holidays: [] }
const SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' }

describe('attendance %', () => {
  it('counts half days as halves, over present + half + absent', () => {
    expect(attendancePercent(20, 2, 2)).toBe(87.5)
    expect(attendancePercent(10, 0, 0)).toBe(100)
  })

  it('is nothing — not 0%, not 100% — when there were no working days to count', () => {
    expect(attendancePercent(0, 0, 0)).toBeNull()
  })
})

describe('days nobody marked', () => {
  it('are working days in the window, up to today, with nothing recorded', () => {
    // 1–5 Sept: Tue–Sat, five working days; the 2nd is marked.
    expect(notMarkedDays({ from: '2026-09-01', to: '2026-09-05' }, '2026-09-30', SUNDAYS_OFF, new Set(['2026-09-02']))).toBe(4)
  })

  it('leave out weekly offs and holidays, which nobody was expected to mark', () => {
    const calendar = { weeklyOffDays: [0] as const, holidays: ['2026-09-02'] }
    expect(notMarkedDays({ from: '2026-09-01', to: '2026-09-07' }, '2026-09-30', calendar, new Set())).toBe(5)
  })

  it('do not count days that have not happened yet', () => {
    expect(notMarkedDays(SEPTEMBER, '2026-09-03', SUNDAYS_OFF, new Set())).toBe(3)
    expect(notMarkedDays({ from: '2026-10-01', to: '2026-10-31' }, '2026-09-28', SUNDAYS_OFF, new Set())).toBe(0)
  })
})

describe('leave inside a month', () => {
  it('counts only the days inside it', () => {
    // 28 Sept (Mon) – 3 Oct (Sat): Mon, Tue, Wed in September.
    expect(leaveDaysWithin({ from: '2026-09-28', to: '2026-10-03', halfDays: [] }, SEPTEMBER, SUNDAYS_OFF)).toBe(3)
  })

  it('counts a half day as half, and skips the weekly off inside the leave', () => {
    // 4 Sept (Fri) – 8 Sept (Tue), Sunday off, the 8th a half day: Fri, Sat, Mon, ½ Tue.
    expect(leaveDaysWithin({ from: '2026-09-04', to: '2026-09-08', halfDays: ['2026-09-08'] }, SEPTEMBER, SUNDAYS_OFF)).toBe(3.5)
  })

  it('is nothing for leave outside the month', () => {
    expect(leaveDaysWithin({ from: '2026-10-05', to: '2026-10-06', halfDays: [] }, SEPTEMBER, SUNDAYS_OFF)).toBe(0)
  })
})

describe('overlap', () => {
  it('is the shared stretch of two ranges, or none', () => {
    expect(overlap({ from: '2026-09-10', to: '2026-10-10' }, SEPTEMBER)).toEqual({ from: '2026-09-10', to: '2026-09-30' })
    expect(overlap({ from: '2026-10-01', to: '2026-10-10' }, SEPTEMBER)).toBeNull()
  })
})
