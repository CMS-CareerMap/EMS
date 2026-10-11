import { describe, it, expect } from 'vitest'
import { machineDays, machineHeader, matchMachineDay, mergeScans, parseMachineDate, parseMachineDateTime, parseMachineTime, type MachineLine } from './machineFile'
import type { ShiftRules } from './shiftRules'

const DAY: ShiftRules = { startTime: '09:30', endTime: '18:30', expectedHours: 9, graceMinutes: 0, lateThresholdMinutes: null, earlyLeavingMinutes: null, minFullDayHours: 8, minHalfDayHours: 4.5, overtimeAfterMinutes: 0 }
const NIGHT: ShiftRules = { ...DAY, startTime: '22:00', endTime: '06:00' }
const at = (hh: number, mm = 0) => hh * 60 + mm
const scan = (line: number, employeeId: string, date: string, minutes: number): MachineLine => ({ line, employeeId, date, checkIn: null, checkOut: null, scan: minutes })
const pair = (line: number, employeeId: string, date: string, checkIn: number | null, checkOut: number | null): MachineLine => ({ line, employeeId, date, checkIn, checkOut, scan: null })

describe('reading any machine’s file (client, 11 Oct 2026)', () => {
  it('knows the common column names', () => {
    expect(['AC-No.', 'Enroll No', 'Badgenumber', 'USERID', 'Employee Code'].map(machineHeader)).toEqual(['code', 'code', 'code', 'code', 'code'])
    expect(['Time', 'CHECKTIME', 'Punch Time', 'Date Time'].map(machineHeader)).toEqual(['time', 'time', 'time', 'time'])
    expect(['In Time', 'Out Time', 'Date', 'Name'].map(machineHeader)).toEqual(['checkIn', 'checkOut', 'date', 'name'])
  })

  it('reads dates and times as firmware writes them', () => {
    expect(['10/10/2026', '1-9-2026', '2026-10-10', '10.10.2026'].map(parseMachineDate)).toEqual(['2026-10-10', '2026-09-01', '2026-10-10', '2026-10-10'])
    expect(['31/02/2026', 'yesterday'].map(parseMachineDate)).toEqual([null, null])
    expect(['09:30', '09:30:59', '9:30 AM', '12:05 am', '12:05 PM', '9:30:15 pm'].map(parseMachineTime)).toEqual([at(9, 30), at(9, 30), at(9, 30), at(0, 5), at(12, 5), at(21, 30)])
    expect(['25:00', '13:00 PM', 'soon'].map(parseMachineTime)).toEqual([null, null, null])
    expect(parseMachineDateTime('10/10/2026 10:08:15')).toEqual({ date: '2026-10-10', minutes: at(10, 8) })
    expect(parseMachineDateTime('2026-10-10T18:31:00')).toEqual({ date: '2026-10-10', minutes: at(18, 31) })
    expect(parseMachineDateTime('10/10/2026 6:02 PM')).toEqual({ date: '2026-10-10', minutes: at(18, 2) })
    expect(parseMachineDateTime('10/10/2026')).toBeNull()
  })
})

describe('a person’s day on the machine', () => {
  it('one line a scan: the first scan is the check-in, the last the check-out', () => {
    const days = machineDays([scan(2, 'priya', '2026-10-10', at(10, 8)), scan(3, 'priya', '2026-10-10', at(13, 2)), scan(4, 'priya', '2026-10-10', at(18, 40)), scan(5, 'priya', '2026-10-10', at(14, 0))], () => DAY)
    expect(days).toEqual([{ employeeId: 'priya', date: '2026-10-10', first: at(10, 8), last: at(18, 40), scans: 4, lines: [2, 3, 4, 5], nightMoved: false }])
  })

  it('one scan alone is a check-in with no check-out', () => {
    expect(machineDays([scan(2, 'ravi', '2026-10-10', at(9, 55))], () => DAY)).toEqual([{ employeeId: 'ravi', date: '2026-10-10', first: at(9, 55), last: null, scans: 1, lines: [2], nightMoved: false }])
  })

  it('one line a day reads as always; two lines for the same day are one day, first and last', () => {
    const days = machineDays([pair(2, 'priya', '2026-10-10', at(9, 40), at(13, 0)), pair(3, 'priya', '2026-10-10', at(14, 0), at(18, 35))], () => DAY)
    expect(days).toEqual([{ employeeId: 'priya', date: '2026-10-10', first: at(9, 40), last: at(18, 35), scans: 4, lines: [2, 3], nightMoved: false }])
  })

  it('a night shift: the morning’s scan belongs to the night before', () => {
    const days = machineDays([scan(2, 'raju', '2026-10-09', at(21, 55)), scan(3, 'raju', '2026-10-10', at(6, 5)), scan(4, 'raju', '2026-10-10', at(21, 58))], () => NIGHT)
    expect(days.map((d) => [d.date, d.first, d.last])).toEqual([['2026-10-09', at(21, 55), 1440 + at(6, 5)], ['2026-10-10', at(21, 58), null]])
    // The same morning scan for somebody on days is that morning.
    expect(machineDays([scan(2, 'priya', '2026-10-10', at(6, 5))], () => DAY).map((d) => d.date)).toEqual(['2026-10-10'])
    // One line a day for a night: out at or before in is the next morning, on the line's own day.
    expect(machineDays([pair(2, 'raju', '2026-10-09', at(22, 0), at(6, 0))], () => NIGHT).map((d) => [d.date, d.first, d.last])).toEqual([['2026-10-09', at(22, 0), 1440 + at(6, 0)]])
    // Which days took a moved scan: the import judges a night cut by the file's first day by it.
    expect(days.map((d) => d.nightMoved)).toEqual([true, false])
  })

  it('a line a day with only a check-out stays a check-out: no check-in made up', () => {
    expect(machineDays([pair(2, 'neha', '2026-10-10', null, at(18, 30))], () => DAY)).toEqual([{ employeeId: 'neha', date: '2026-10-10', first: null, last: at(18, 30), scans: 1, lines: [2], nightMoved: false }])
    // With a check-in elsewhere that day, the first and the last as always.
    expect(machineDays([pair(2, 'neha', '2026-10-10', null, at(18, 30)), pair(3, 'neha', '2026-10-10', at(9, 30), null)], () => DAY).map((d) => [d.first, d.last])).toEqual([[at(9, 30), at(18, 30)]])
  })
})

describe('a night cut by the file’s edge, made whole', () => {
  it('this file’s morning with the evening an earlier file recorded', () => {
    expect(mergeScans({ first: 1440 + at(5, 55), last: null }, [at(22, 0), null])).toEqual({ first: at(22, 0), last: 1440 + at(5, 55) })
    // Imported again: the same night, nothing new.
    expect(mergeScans({ first: 1440 + at(5, 55), last: null }, [at(22, 0), 1440 + at(5, 55)])).toEqual({ first: at(22, 0), last: 1440 + at(5, 55) })
  })

  it('a check-out alone stays one, with nothing recorded to join it', () => {
    expect(mergeScans({ first: null, last: at(18, 30) }, [null, null])).toEqual({ first: null, last: at(18, 30) })
    expect(mergeScans({ first: null, last: at(18, 30) }, [at(9, 30), null])).toEqual({ first: at(9, 30), last: at(18, 30) })
  })
})

describe('matching the app’s day against the machine’s', () => {
  it('any scan confirms the day; a couple of minutes apart is nothing', () => {
    // Finger at 10:08 to open the gate, phone check-in at 10:10 (Devesh, 11 Oct 2026).
    expect(matchMachineDay({ checkIn: at(10, 10), checkOut: at(18, 30) }, { first: at(10, 8), last: null }, 30)).toEqual({ result: 'confirmed', inDiff: 2, outDiff: null })
    expect(matchMachineDay({ checkIn: at(10, 10), checkOut: at(18, 30) }, { first: at(10, 8), last: at(18, 32) }, 30).result).toBe('confirmed')
  })

  it('more than the minutes allowed apart is a note, never absent', () => {
    expect(matchMachineDay({ checkIn: at(11, 20), checkOut: null }, { first: at(10, 8), last: null }, 30)).toEqual({ result: 'time_differs', inDiff: 72, outDiff: null })
    expect(matchMachineDay({ checkIn: at(10, 10), checkOut: at(18, 30) }, { first: at(10, 8), last: at(17, 0) }, 30).result).toBe('time_differs')
    // Exactly at the limit is within it.
    expect(matchMachineDay({ checkIn: at(10, 38), checkOut: null }, { first: at(10, 8), last: null }, 30).result).toBe('confirmed')
  })

  it('no scan at all: not on the machine', () => {
    expect(matchMachineDay({ checkIn: at(10, 0), checkOut: at(18, 0) }, null, 30)).toEqual({ result: 'not_on_machine', inDiff: null, outDiff: null })
  })

  it('a machine day with only a check-out is held against the check-out alone', () => {
    expect(matchMachineDay({ checkIn: at(10, 0), checkOut: at(18, 0) }, { first: null, last: at(18, 10) }, 30)).toEqual({ result: 'confirmed', inDiff: null, outDiff: 10 })
  })
})
