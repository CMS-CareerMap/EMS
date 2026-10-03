import { describe, it, expect } from 'vitest'
import { addMonths, defaultLastDay, defaultProbationEnd, isOnRoll, stageOf, type LifecycleFacts } from './lifecycle'

/** The employee lifecycle (client §43), without a database. */

const TODAY = '2026-10-03'
const facts = (over: Partial<LifecycleFacts> = {}): LifecycleFacts => ({
  dateOfJoining: '2026-01-05',
  onboardedOn: '2026-01-09',
  confirmedOn: null,
  lastWorkingDate: null,
  left: false,
  resignation: null,
  ...over,
})

describe('where somebody stands', () => {
  it('walks the client’s order: joining soon, onboarding, probation, confirmed', () => {
    expect(stageOf(facts({ dateOfJoining: '2026-11-02', onboardedOn: null }), TODAY)).toBe('joining_soon')
    expect(stageOf(facts({ onboardedOn: null }), TODAY)).toBe('onboarding')
    expect(stageOf(facts(), TODAY)).toBe('probation')
    expect(stageOf(facts({ confirmedOn: '2026-07-05' }), TODAY)).toBe('confirmed')
  })

  it('puts a resignation ahead of probation or confirmation', () => {
    expect(stageOf(facts({ resignation: { status: 'submitted' } }), TODAY)).toBe('resigned')
    expect(stageOf(facts({ confirmedOn: '2026-07-05', resignation: { status: 'accepted' }, lastWorkingDate: '2026-10-31' }), TODAY)).toBe('notice_period')
  })

  it('counts the last working day itself as still working, and the day after as exit due', () => {
    expect(stageOf(facts({ resignation: { status: 'accepted' }, lastWorkingDate: TODAY }), TODAY)).toBe('notice_period')
    expect(stageOf(facts({ resignation: { status: 'accepted' }, lastWorkingDate: '2026-10-02' }), TODAY)).toBe('exit_due')
  })

  it('leaves somebody with a contract end date where they are until it passes', () => {
    expect(stageOf(facts({ lastWorkingDate: '2026-12-31' }), TODAY)).toBe('probation')
    expect(stageOf(facts({ onboardedOn: null, lastWorkingDate: '2026-12-31' }), TODAY)).toBe('onboarding')
    expect(stageOf(facts({ confirmedOn: '2026-07-05', lastWorkingDate: '2026-12-31' }), TODAY)).toBe('confirmed')
    expect(stageOf(facts({ lastWorkingDate: '2026-10-02' }), TODAY)).toBe('exit_due')
  })

  it('says left for somebody archived, whatever else is set', () => {
    expect(stageOf(facts({ left: true, resignation: { status: 'accepted' }, lastWorkingDate: '2026-09-30' }), TODAY)).toBe('left')
    expect(isOnRoll('left')).toBe(false)
    expect(isOnRoll('exit_due')).toBe(false)
    expect(isOnRoll('notice_period')).toBe(true)
  })

  it('has somebody with no joining date in onboarding until HR finishes it', () => {
    expect(stageOf(facts({ dateOfJoining: null, onboardedOn: null }), TODAY)).toBe('onboarding')
  })
})

describe('the dates the company’s settings give', () => {
  it('ends probation the company’s months after joining, clamped to a shorter month', () => {
    expect(defaultProbationEnd('2026-01-05', 6)).toBe('2026-07-05')
    expect(addMonths('2026-08-31', 6)).toBe('2027-02-28')
    expect(addMonths('2027-08-31', 6)).toBe('2028-02-29')
    expect(addMonths('2026-11-15', 3)).toBe('2027-02-15')
  })

  it('asks for the notice period from the day a resignation is handed in', () => {
    expect(defaultLastDay('2026-10-01', 30)).toBe('2026-10-31')
    expect(defaultLastDay('2026-10-01', 0)).toBe('2026-10-01')
  })
})
