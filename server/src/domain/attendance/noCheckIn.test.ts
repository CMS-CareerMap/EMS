import { describe, it, expect } from 'vitest'
import { dayEndsAt, isDue, judgedThrough, verdictFor, type DayFacts, type NoCheckInRule, type PersonWindow } from './noCheckIn'

/**
 * No check-in means Absent (client, 25 Oct 2026): what one day of one person
 * should be. The rule writes only where nothing is, and takes back only what
 * it wrote.
 */

const on: NoCheckInRule = { on: true, from: '2026-10-26' }
const off: NoCheckInRule = { on: false, from: '2026-10-26' }
const person: PersonWindow = { joined: '2026-01-01', left: null, judgedThrough: '2026-10-28' }
const day = (date: string, facts: Partial<DayFacts> = {}): DayFacts => ({ date, off: false, leave: null, row: null, ...facts })
const systemRow = { status: 'absent' as const, source: 'system', checkedIn: false, statusBeforeSystem: null }
const halfLeaveRow = { status: 'on_leave' as const, source: 'leave', checkedIn: false, statusBeforeSystem: null }

describe('a working day with nothing in it', () => {
  it('is made Absent once it is over, from the day the rule starts', () => {
    expect(verdictFor(on, person, day('2026-10-27'))).toBe('create')
  })

  it('is left alone before the rule starts, with the rule off, and before the day is over', () => {
    expect(verdictFor(on, person, day('2026-10-25'))).toBe('none')
    expect(verdictFor(off, person, day('2026-10-27'))).toBe('none')
    expect(verdictFor(on, person, day('2026-10-29'))).toBe('none')
  })

  it('is never Absent on a weekly off or a holiday', () => {
    expect(verdictFor(on, person, day('2026-10-27', { off: true }))).toBe('none')
  })

  it('is never Absent before they joined or after their last day', () => {
    expect(verdictFor(on, { ...person, joined: '2026-10-28' }, day('2026-10-27'))).toBe('none')
    expect(verdictFor(on, { ...person, left: '2026-10-26' }, day('2026-10-27'))).toBe('none')
  })

  it('is not Absent under a whole day of approved leave; under half a day it is — the other half was not worked', () => {
    expect(verdictFor(on, person, day('2026-10-27', { leave: 'full' }))).toBe('none')
    expect(verdictFor(on, person, day('2026-10-27', { leave: 'half' }))).toBe('create')
  })
})

describe('a day somebody has said something about', () => {
  it('stands, whatever it is: a punch, a mark, a correction, the machine', () => {
    for (const row of [
      { status: 'present' as const, source: 'punch', checkedIn: true, statusBeforeSystem: null },
      { status: 'absent' as const, source: 'manual', checkedIn: false, statusBeforeSystem: null },
      { status: 'present' as const, source: 'correction', checkedIn: true, statusBeforeSystem: null },
      { status: 'absent' as const, source: 'biometric', checkedIn: false, statusBeforeSystem: null },
      { status: 'weekly_off' as const, source: 'manual', checkedIn: false, statusBeforeSystem: null },
    ]) {
      expect(verdictFor(on, person, day('2026-10-27', { row }))).toBe('none')
      expect(verdictFor(off, person, day('2026-10-27', { row }))).toBe('none')
    }
  })

  it('makes a half-day leave with no punch Absent for the other half — and leaves one with a punch', () => {
    expect(verdictFor(on, person, day('2026-10-27', { leave: 'half', row: halfLeaveRow }))).toBe('convert')
    expect(verdictFor(on, person, day('2026-10-27', { leave: 'half', row: { ...halfLeaveRow, checkedIn: true } }))).toBe('none')
  })
})

describe('what the rule wrote, when it is no longer due', () => {
  it('keeps it while it is due', () => {
    expect(verdictFor(on, person, day('2026-10-27', { row: systemRow }))).toBe('none')
  })

  it('takes it back: the rule off, a holiday, before the start, outside their employment', () => {
    expect(verdictFor(off, person, day('2026-10-27', { row: systemRow }))).toBe('remove')
    expect(verdictFor(on, person, day('2026-10-27', { row: systemRow, off: true }))).toBe('remove')
    expect(verdictFor({ on: true, from: '2026-10-28' }, person, day('2026-10-27', { row: systemRow }))).toBe('remove')
    expect(verdictFor(on, { ...person, left: '2026-10-26' }, day('2026-10-27', { row: systemRow }))).toBe('remove')
  })

  it('says leave when the whole day is on leave now — two halves approved one by one', () => {
    expect(verdictFor(on, person, day('2026-10-27', { row: systemRow, leave: 'full' }))).toBe('to_leave')
  })

  it('puts a half-day leave back as it was', () => {
    const converted = { status: 'absent' as const, source: 'leave', checkedIn: false, statusBeforeSystem: 'on_leave' as const }
    expect(verdictFor(on, person, day('2026-10-27', { row: converted, leave: 'half' }))).toBe('none')
    expect(verdictFor(off, person, day('2026-10-27', { row: converted, leave: 'half' }))).toBe('restore')
    expect(verdictFor(on, person, day('2026-10-27', { row: converted, leave: 'full' }))).toBe('restore')
    expect(verdictFor(on, person, day('2026-10-27', { row: converted, leave: 'half', off: true }))).toBe('restore')
  })

  it('forgets what it kept once somebody else has written the day', () => {
    const marked = { status: 'present' as const, source: 'manual', checkedIn: false, statusBeforeSystem: 'on_leave' as const }
    expect(verdictFor(on, person, day('2026-10-27', { row: marked, leave: 'half' }))).toBe('forget')
  })
})

describe('when a day is over', () => {
  const tz = 'Asia/Kolkata'

  it('ends at the end of the shift — a night shift the next morning', () => {
    expect(dayEndsAt('2026-10-27', { startTime: '10:00', endTime: '19:00' }, tz).getTime()).toBe(Date.parse('2026-10-27T13:30:00Z'))
    expect(dayEndsAt('2026-10-27', { startTime: '22:00', endTime: '06:00' }, tz).getTime()).toBe(Date.parse('2026-10-28T00:30:00Z'))
  })

  it('ends at midnight with no shift, or one that cannot be read', () => {
    expect(dayEndsAt('2026-10-27', null, tz).getTime()).toBe(Date.parse('2026-10-27T18:30:00Z'))
    expect(dayEndsAt('2026-10-27', { startTime: '', endTime: 'x' }, tz).getTime()).toBe(Date.parse('2026-10-27T18:30:00Z'))
  })

  it('on the app: today once the shift has ended, else yesterday — or the day before for a night shift', () => {
    const day = { startTime: '10:00', endTime: '19:00' }
    const night = { startTime: '22:00', endTime: '06:00' }
    const at = (iso: string, shift: typeof day | null) => judgedThrough({ mode: 'app', shift, today: '2026-10-27', now: new Date(iso), timezone: tz, waitDays: 3 })
    expect(at('2026-10-27T14:00:00Z', day)).toBe('2026-10-27') // 19:30 IST
    expect(at('2026-10-27T05:00:00Z', day)).toBe('2026-10-26') // 10:30 IST
    expect(at('2026-10-26T21:30:00Z', night)).toBe('2026-10-25') // 03:00 IST on the 27th: the 26th's shift runs till 06:00
  })

  it('from the machine or HR: after the days of waiting, one at least', () => {
    expect(judgedThrough({ mode: 'biometric', shift: null, today: '2026-10-27', now: new Date(), timezone: tz, waitDays: 3 })).toBe('2026-10-24')
    expect(judgedThrough({ mode: 'manual', shift: null, today: '2026-10-27', now: new Date(), timezone: tz, waitDays: 0 })).toBe('2026-10-26')
  })

  it('is what isDue checks against', () => {
    expect(isDue(on, { ...person, judgedThrough: '2026-10-26' }, day('2026-10-27'))).toBe(false)
  })
})
