import { describe, it, expect } from 'vitest'
import {
  monthCalendar,
  lossOfPay,
  leaveDaysIn,
  proration,
  type AttendanceStatus,
  type LeaveDay,
  type MonthCalendar,
} from './payDays'
import type { Weekday } from '../leave/leaveDays'
import { computeSalary } from './salary'

/**
 * Days of pay.
 *
 * Every case here is one where the day count moves somebody's salary. The
 * months are real: September 2026 starts on a Tuesday and has Sundays on the
 * 6th, 13th, 20th and 27th; February 2026 starts on a Sunday; October 2026
 * starts on a Thursday and has Gandhi Jayanti on Friday the 2nd.
 */

const SUNDAY_OFF: Weekday[] = [0]
const WEEKEND_OFF: Weekday[] = [0, 6]

const september = (weeklyOffDays: Weekday[] = SUNDAY_OFF, holidays: string[] = []) =>
  monthCalendar({ year: 2026, month: 9, weeklyOffDays, holidays })

const WHOLE_SEPTEMBER = { from: '2026-09-01', to: '2026-09-30' }
/** After September, so nothing in it is still to come. */
const OCTOBER_5 = '2026-10-05'

/** Present on every working day, except the days given. */
function attendance(
  calendar: MonthCalendar,
  except: Record<string, AttendanceStatus | null> = {},
): { date: string; status: AttendanceStatus }[] {
  const rows: { date: string; status: AttendanceStatus }[] = []
  for (const day of calendar.days) {
    if (day.kind !== 'working') continue
    const status = day.date in except ? except[day.date] : 'present'
    if (status) rows.push({ date: day.date, status })
  }
  return rows
}

function lop(options: {
  calendar?: MonthCalendar
  window?: { from: string; to: string }
  except?: Record<string, AttendanceStatus | null>
  leave?: LeaveDay[]
  sandwichRule?: boolean
  today?: string
}) {
  const calendar = options.calendar ?? september()
  return lossOfPay({
    calendar,
    window: options.window ?? WHOLE_SEPTEMBER,
    attendance: attendance(calendar, options.except),
    leave: options.leave ?? [],
    sandwichRule: options.sandwichRule ?? false,
    today: options.today ?? OCTOBER_5,
  })
}

describe('the month as the company works it', () => {
  it('knows which days are off', () => {
    const cal = september()
    expect(cal.days).toHaveLength(30)
    expect(cal.workingDays).toBe(26)
    expect(cal.days.find((d) => d.date === '2026-09-06')?.kind).toBe('weekly_off')
    expect(cal.days.find((d) => d.date === '2026-09-05')?.kind).toBe('working')
  })

  it('counts a holiday on a Sunday once, as the Sunday it already was', () => {
    const cal = september(SUNDAY_OFF, ['2026-09-13'])
    expect(cal.workingDays).toBe(26)
    expect(cal.days.find((d) => d.date === '2026-09-13')?.kind).toBe('weekly_off')
  })

  it('takes a weekday holiday out of the working days', () => {
    const cal = monthCalendar({ year: 2026, month: 10, weeklyOffDays: SUNDAY_OFF, holidays: ['2026-10-02'] })
    expect(cal.days).toHaveLength(31)
    // 31 days, 4 Sundays, one holiday.
    expect(cal.workingDays).toBe(26)
    expect(cal.days.find((d) => d.date === '2026-10-02')?.kind).toBe('holiday')
  })
})

describe('loss of pay from attendance', () => {
  it('is nothing for a month fully worked', () => {
    const result = lop({})
    expect(result.lopDays).toBe(0)
    expect(result.unmarked).toEqual([])
    expect(result.days).toHaveLength(30)
  })

  it('is a day for each absence', () => {
    const result = lop({ except: { '2026-09-08': 'absent', '2026-09-09': 'absent' } })
    expect(result.lopDays).toBe(2)
    expect(result.days.find((d) => d.date === '2026-09-08')).toMatchObject({ lop: 1, reason: 'absent' })
  })

  it('is half a day for a half day', () => {
    const result = lop({ except: { '2026-09-08': 'half_day' } })
    expect(result.lopDays).toBe(0.5)
    expect(result.days.find((d) => d.date === '2026-09-08')?.reason).toBe('half_day')
  })

  it('pays Sundays and holidays inside the month — they are not absences', () => {
    const result = lop({ calendar: september(SUNDAY_OFF, ['2026-09-15']) })
    expect(result.lopDays).toBe(0)
    expect(result.days.filter((d) => d.reason === 'off_day')).toHaveLength(5)
  })
})

describe('loss of pay from leave', () => {
  const unpaid = (date: string, portion = 1): LeaveDay => ({ date, portion, paid: false })
  const paid = (date: string, portion = 1): LeaveDay => ({ date, portion, paid: true })

  it('docks a day of unpaid leave and pays a day of paid leave', () => {
    const result = lop({
      except: { '2026-09-08': 'on_leave', '2026-09-09': 'on_leave' },
      leave: [unpaid('2026-09-08'), paid('2026-09-09')],
    })
    expect(result.lopDays).toBe(1)
    expect(result.days.find((d) => d.date === '2026-09-08')?.reason).toBe('unpaid_leave')
    expect(result.days.find((d) => d.date === '2026-09-09')?.reason).toBe('paid_leave')
  })

  it('makes a whole day of a half day worked and half a day of paid leave', () => {
    const result = lop({ except: { '2026-09-08': 'half_day' }, leave: [paid('2026-09-08', 0.5)] })
    expect(result.lopDays).toBe(0)
  })

  it('docks half a day for a half day worked and half a day of unpaid leave', () => {
    const result = lop({ except: { '2026-09-08': 'half_day' }, leave: [unpaid('2026-09-08', 0.5)] })
    expect(result.lopDays).toBe(0.5)
  })

  it('pays the other half of a half-day leave, which is the half they worked', () => {
    // Approval writes an on_leave row for the day even when only half of it is
    // leave; the rest of the day is theirs.
    const result = lop({ except: { '2026-09-08': 'on_leave' }, leave: [paid('2026-09-08', 0.5)] })
    expect(result.lopDays).toBe(0)
    expect(result.markedLeave).toEqual([])
  })

  it('pays somebody who came in on a day of approved unpaid leave', () => {
    const result = lop({ except: { '2026-09-08': 'present' }, leave: [unpaid('2026-09-08')] })
    expect(result.lopDays).toBe(0)
    expect(result.days.find((d) => d.date === '2026-09-08')?.reason).toBe('worked')
  })

  it('treats an absence on a day of approved paid leave as the leave', () => {
    const result = lop({ except: { '2026-09-08': 'absent' }, leave: [paid('2026-09-08')] })
    expect(result.lopDays).toBe(0)
  })

  it('docks approved unpaid leave that is still to come — it is already decided', () => {
    const result = lop({ except: { '2026-09-29': null }, leave: [unpaid('2026-09-29')], today: '2026-09-25' })
    expect(result.days.find((d) => d.date === '2026-09-29')?.lop).toBe(1)
  })
})

describe('days nobody recorded', () => {
  it('pays a passed working day with no attendance, and lists it', () => {
    const result = lop({ except: { '2026-09-08': null, '2026-09-09': null } })
    expect(result.lopDays).toBe(0)
    expect(result.unmarked).toEqual(['2026-09-08', '2026-09-09'])
  })

  it('pays days from today on as not yet happened, not as unmarked', () => {
    const result = lop({
      except: { '2026-09-25': null, '2026-09-26': null, '2026-09-28': null, '2026-09-29': null, '2026-09-30': null },
      today: '2026-09-25',
    })
    expect(result.lopDays).toBe(0)
    expect(result.unmarked).toEqual([])
    expect(result.notYet).toEqual(['2026-09-25', '2026-09-26', '2026-09-28', '2026-09-29', '2026-09-30'])
  })

  it('pays "on leave" typed in by hand with no leave behind it, and flags it', () => {
    const result = lop({ except: { '2026-09-08': 'on_leave' } })
    expect(result.lopDays).toBe(0)
    expect(result.markedLeave).toEqual(['2026-09-08'])
  })

  it('pays a working day HR marked as a holiday for this person', () => {
    const result = lop({ except: { '2026-09-08': 'holiday' } })
    expect(result.lopDays).toBe(0)
    expect(result.days.find((d) => d.date === '2026-09-08')?.reason).toBe('marked_off')
  })
})

describe('the employment window', () => {
  it('only counts the days they were employed', () => {
    // Joined Wednesday 16 September. Absences recorded before it — an import
    // mistake, say — are not theirs to be docked for.
    const result = lop({
      window: { from: '2026-09-16', to: '2026-09-30' },
      except: { '2026-09-08': 'absent' },
    })
    expect(result.days).toHaveLength(15)
    expect(result.lopDays).toBe(0)
  })
})

describe('the sandwich rule', () => {
  const absentSaturdayAndMonday = { '2026-09-05': 'absent', '2026-09-07': 'absent' } as const

  it('is off by default: the Sunday between two absences is paid', () => {
    expect(lop({ except: absentSaturdayAndMonday }).lopDays).toBe(2)
  })

  it('when on, docks the Sunday between two absences as well', () => {
    const result = lop({ except: absentSaturdayAndMonday, sandwichRule: true })
    expect(result.lopDays).toBe(3)
    expect(result.days.find((d) => d.date === '2026-09-06')).toMatchObject({ lop: 1, reason: 'sandwiched' })
  })

  it('takes the whole weekend when both days of it are off', () => {
    const cal = september(WEEKEND_OFF)
    const result = lop({
      calendar: cal,
      except: { '2026-09-04': 'absent', '2026-09-07': 'absent' },
      sandwichRule: true,
    })
    expect(result.lopDays).toBe(4)
  })

  it('covers a holiday between two absences', () => {
    const cal = monthCalendar({ year: 2026, month: 10, weeklyOffDays: SUNDAY_OFF, holidays: ['2026-10-02'] })
    const result = lossOfPay({
      calendar: cal,
      window: { from: '2026-10-01', to: '2026-10-31' },
      attendance: attendance(cal, { '2026-10-01': 'absent', '2026-10-03': 'absent' }),
      leave: [],
      sandwichRule: true,
      today: '2026-11-05',
    })
    // Thursday, the holiday, Saturday. Sunday the 4th is not sandwiched:
    // Monday the 5th was worked.
    expect(result.lopDays).toBe(3)
  })

  it('needs a full day lost on both sides — a half day is not enough', () => {
    const result = lop({ except: { '2026-09-05': 'half_day', '2026-09-07': 'absent' }, sandwichRule: true })
    expect(result.lopDays).toBe(1.5)
  })

  it('does not reach past the edge of the window', () => {
    // Their last day is Sunday the 27th, absent the Saturday before. There is
    // no day after the Sunday for it to be sandwiched against.
    const result = lop({
      window: { from: '2026-09-01', to: '2026-09-27' },
      except: { '2026-09-26': 'absent' },
      sandwichRule: true,
    })
    expect(result.lopDays).toBe(1)
  })
})

describe('approved leave, day by day', () => {
  it('counts only the days a leave charges, and only this month’s', () => {
    // Monday 28 September to Saturday 3 October, the Saturday a half day,
    // with Gandhi Jayanti on the Friday.
    const request = { from: '2026-09-28', to: '2026-10-03', halfDays: ['2026-10-03'], paid: false }

    const inSeptember = leaveDaysIn([request], september(), SUNDAY_OFF)
    expect(inSeptember.map((d) => d.date)).toEqual(['2026-09-28', '2026-09-29', '2026-09-30'])

    const october = monthCalendar({ year: 2026, month: 10, weeklyOffDays: SUNDAY_OFF, holidays: ['2026-10-02'] })
    const inOctober = leaveDaysIn([request], october, SUNDAY_OFF)
    expect(inOctober).toEqual([
      { date: '2026-10-01', portion: 1, paid: false },
      { date: '2026-10-03', portion: 0.5, paid: false },
    ])
  })
})

describe('what a day is worth — the LOP basis', () => {
  const feb = monthCalendar({ year: 2026, month: 2, weeklyOffDays: SUNDAY_OFF, holidays: [] })
  const oct = monthCalendar({ year: 2026, month: 10, weeklyOffDays: SUNDAY_OFF, holidays: [] })
  const WHOLE_FEB = { from: '2026-02-01', to: '2026-02-28' }
  const WHOLE_OCT = { from: '2026-10-01', to: '2026-10-31' }

  it('calendar days: the days the month has', () => {
    const p = proration({ lopBasis: 'calendar_days', calendar: september(), window: WHOLE_SEPTEMBER, lopDays: 2 })
    expect(p).toMatchObject({ payBasisDays: 30, payableDays: 28, paidDays: 28, employmentDays: 30 })
  })

  it('fixed 30: a whole February is the whole salary, not 28 thirtieths of it', () => {
    const p = proration({ lopBasis: 'fixed_30', calendar: feb, window: WHOLE_FEB, lopDays: 0 })
    expect(p).toMatchObject({ payBasisDays: 30, payableDays: 30, paidDays: 28 })
  })

  it('fixed 30: a day of loss of pay costs a thirtieth in every month', () => {
    expect(proration({ lopBasis: 'fixed_30', calendar: feb, window: WHOLE_FEB, lopDays: 2 }).payableDays).toBe(28)
    expect(proration({ lopBasis: 'fixed_30', calendar: oct, window: WHOLE_OCT, lopDays: 1 }).payableDays).toBe(29)
  })

  it('fixed 30: a joiner is paid the days employed, out of 30', () => {
    const p = proration({ lopBasis: 'fixed_30', calendar: oct, window: { from: '2026-10-16', to: '2026-10-31' }, lopDays: 0 })
    expect(p).toMatchObject({ payBasisDays: 30, payableDays: 16, employmentDays: 16 })
  })

  it('fixed 30: a February spent on unpaid leave pays nothing, not two days', () => {
    const p = proration({ lopBasis: 'fixed_30', calendar: feb, window: WHOLE_FEB, lopDays: 28 })
    expect(p.payableDays).toBe(0)
  })

  it('working days: the month’s working days, less the days lost', () => {
    const p = proration({ lopBasis: 'working_days', calendar: september(), window: WHOLE_SEPTEMBER, lopDays: 2 })
    expect(p).toMatchObject({ payBasisDays: 26, payableDays: 24, paidDays: 28 })
  })

  it('working days: a joiner is paid the working days employed', () => {
    // Wednesday 16th to Wednesday 30th: 15 days, two of them Sundays.
    const p = proration({ lopBasis: 'working_days', calendar: september(), window: { from: '2026-09-16', to: '2026-09-30' }, lopDays: 0 })
    expect(p).toMatchObject({ payBasisDays: 26, payableDays: 13 })
  })

  it('working days: a month with none falls back to calendar days rather than paying nothing', () => {
    const closed = september([0, 1, 2, 3, 4, 5], ['2026-09-05', '2026-09-12', '2026-09-19', '2026-09-26'])
    expect(closed.workingDays).toBe(0)
    const p = proration({ lopBasis: 'working_days', calendar: closed, window: WHOLE_SEPTEMBER, lopDays: 0 })
    expect(p).toMatchObject({ lopBasis: 'calendar_days', payBasisDays: 30, payableDays: 30, fellBackToCalendar: true })
  })

  it('reaches the engine: ₹30,000 on a fixed 30 with two days lost is ₹28,000 in any month', () => {
    const pay = (calendar: MonthCalendar, window: { from: string; to: string }, month: number, days: number) => {
      const p = proration({ lopBasis: 'fixed_30', calendar, window, lopDays: 2 })
      return computeSalary({
        components: [{ code: 'BASIC', label: 'Basic', amount: 30_000, type: 'earning', countsForPf: false }],
        paidDays: p.paidDays,
        daysInMonth: days,
        proration: { payable: p.payableDays, basis: p.payBasisDays },
        month,
        year: 2026,
        pf: { applicable: false, employeeRate: 12, employerRate: 12, restrictToCeiling: true, wageCeiling: 15_000, epsWageCeiling: 15_000, epsMember: true },
        esi: { covered: false, employeeRate: 0.75, employerRate: 3.25 },
        pt: { state: null, gender: 'any', slabs: [] },
        tds: 0,
      }).grossEarnings
    }

    expect(pay(feb, WHOLE_FEB, 2, 28)).toBe(28_000)
    expect(pay(oct, WHOLE_OCT, 10, 31)).toBe(28_000)
  })
})
