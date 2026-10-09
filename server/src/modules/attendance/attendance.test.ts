import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { fromDateColumn } from '../../domain/shared/dates'
import * as attendanceRepo from './attendance.repository'

/**
 * The punch flow.
 *
 * Two things the audit found are being fixed here and both are tested:
 *
 *   1. An employee could not update their own attendance row, so NOBODY COULD
 *      EVER CHECK OUT. Every day ended with an open row.
 *   2. The geofence was a client-side check against a value in localStorage,
 *      with a "Simulate GPS inside office" button next to it.
 */

const PREFIX = 'attntest'
const PASSWORD = 'CorrectHorseBattery1'

/** The office, and a 30 m fence around it. */
const OFFICE = { latitude: 18.5204303, longitude: 73.8567437 }

const app = createApp()

let orgId = ''
let appEmpId = ''
let bioEmpId = ''
const tokens: Record<string, string> = {}

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.geofenceLocation.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.shift.deleteMany({ where: org })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(
  key: string,
  role: 'super_admin' | 'employee',
  options: { withEmployee?: boolean; attendanceMode?: 'app' | 'biometric'; shiftId?: string } = {},
): Promise<string | null> {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })

  let employeeId: string | null = null
  if (options.withEmployee !== false) {
    const employee = await prisma.employee.create({
      data: {
        organizationId: orgId,
        memberships: { connect: { id: membership.id } },
        employeeCode: `${PREFIX}-${key}`,
        fullName: `${key} person`,
        attendanceMode: options.attendanceMode ?? 'app',
        shiftId: options.shiftId ?? null,
      },
    })
    employeeId = employee.id
  }

  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
  return employeeId
}

const at = (key: string) => `Bearer ${tokens[key]}`

function punchIn(key: string, body: object = {}) {
  return request(app).post('/api/attendance/punch-in').set('Authorization', at(key)).send(body)
}

function punchOut(key: string) {
  return request(app).post('/api/attendance/punch-out').set('Authorization', at(key)).send({})
}

/** A reading at the office, with the accuracy a phone would report indoors. */
const goodReading = { ...OFFICE, accuracyMeters: 12 }

beforeAll(async () => {
  await cleanup()

  const org = await prisma.organization.create({
    data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' },
  })
  orgId = org.id

  await prisma.geofenceLocation.create({
    data: {
      organizationId: orgId,
      name: 'Head Office',
      latitude: OFFICE.latitude,
      longitude: OFFICE.longitude,
      // The client's requirement: 15–30 m.
      radiusMeters: 30,
      maxAccuracyMeters: 50,
    },
  })

  const shift = await prisma.shift.create({
    data: {
      organizationId: orgId,
      name: 'General',
      startTime: '09:30',
      endTime: '18:30',
      breakMinutes: 60,
      expectedHours: 9,
    },
  })

  appEmpId = (await makeUser('app', 'employee', { attendanceMode: 'app', shiftId: shift.id }))!
  bioEmpId = (await makeUser('bio', 'employee', { attendanceMode: 'biometric' }))!
  await makeUser('operator', 'super_admin', { withEmployee: false })
})

beforeEach(async () => {
  await prisma.attendance.deleteMany({ where: { organization: { name: { startsWith: PREFIX } } } })
  await prisma.leaveRequest.deleteMany({ where: { organization: { name: { startsWith: PREFIX } } } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('punching in', () => {
  it('creates today row for an employee standing at the office', async () => {
    const res = await punchIn('app', goodReading)

    expect(res.status).toBe(201)
    expect(res.body.data.check_in).toEqual(expect.any(String))
    expect(res.body.data.geofence.verified).toBe(true)
    expect(res.body.data.geofence.distance_meters).toBeLessThan(30)
  })

  it('refuses a second check-in on the same day', async () => {
    await punchIn('app', goodReading)
    const again = await punchIn('app', goodReading)

    // One punch pair per day, and the unique index backs it up — a
    // double-tapped button cannot create two rows.
    expect(again.status).toBe(409)
    expect(again.body.error.message).toMatch(/already checked in/i)
  })

  it('answers a double tap with the same sentence, not a server error', async () => {
    // The race, made certain rather than hoped for: the first tap has written
    // today's row, and the second read before it did — so its check finds
    // nothing and its insert meets the unique index. That used to be a 500.
    await punchIn('app', goodReading)
    const readBeforeTheOtherWrote = vi.spyOn(attendanceRepo, 'findDay').mockResolvedValueOnce(null)
    try {
      const second = await punchIn('app', goodReading)
      expect(second.status).toBe(409)
      expect(second.body.error.message).toMatch(/already checked in/i)
    } finally {
      readBeforeTheOtherWrote.mockRestore()
    }
  })

  it('stores the evidence, not just the verdict', async () => {
    await punchIn('app', goodReading)

    const row = await prisma.attendance.findFirst({ where: { employeeId: appEmpId } })

    expect(row?.checkInLatitude).not.toBeNull()
    expect(row?.checkInDistanceMeters).toEqual(expect.any(Number))
    // The accuracy is what makes the distance meaningful later. Without it,
    // "25 m away" cannot be defended in an argument.
    expect(row?.checkInAccuracyMeters).toBe(12)
    expect(row?.source).toBe('punch')
  })
})

describe('the geofence, now on the server', () => {
  it('refuses somebody across the road', async () => {
    const away = { latitude: 18.5234303, longitude: 73.8567437, accuracyMeters: 10 }
    const res = await punchIn('app', away)

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/from the office/i)
  })

  it('refuses to decide on a vague reading, in different words', async () => {
    const vague = { ...OFFICE, accuracyMeters: 200 }
    const res = await punchIn('app', vague)

    expect(res.status).toBe(403)
    // Different advice from "you are too far": one means go to the office, the
    // other means move near a window. Collapsing them helps nobody.
    expect(res.body.error.message).toMatch(/near a window/i)
    expect(res.body.error.message).not.toMatch(/from the office/i)
  })

  it('FAILS CLOSED when no location is sent at all', async () => {
    const res = await punchIn('app', {})

    // Otherwise the geofence is bypassed by declining the browser's permission
    // prompt, which is one click.
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/location is required/i)

    expect(await prisma.attendance.count({ where: { employeeId: appEmpId } })).toBe(0)
  })

  it('writes nothing when it refuses', async () => {
    await punchIn('app', { latitude: 18.5234303, longitude: 73.8567437, accuracyMeters: 10 })
    expect(await prisma.attendance.count({ where: { employeeId: appEmpId } })).toBe(0)
  })

  it('refuses an app check-in from somebody on the biometric machine', async () => {
    // Their day comes off the machine. An app punch from them would carry no
    // location check at all — from home it would read as a day at the office.
    const res = await punchIn('bio', {})

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/biometric machine/)
    expect(await prisma.attendance.count({ where: { employeeId: bioEmpId } })).toBe(0)
  })
})

describe('punching out — the thing that never worked', () => {
  it('lets an employee close their own day', async () => {
    await punchIn('app', goodReading)
    const res = await punchOut('app')

    // The audit found RLS blocked exactly this, so every day ended with an
    // open row that HR had to fix by hand.
    expect(res.status).toBe(200)
    expect(res.body.data.check_out).toEqual(expect.any(String))
  })

  it('computes and STORES hours worked, minus the break', async () => {
    await punchIn('app', goodReading)

    // Backdate the check-in so there is a real duration to measure.
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: appEmpId } })
    await prisma.attendance.update({
      where: { id: row.id },
      data: { checkIn: new Date(Date.now() - 9 * 60 * 60 * 1000) },
    })

    const res = await punchOut('app')

    // Nine hours elapsed, minus a sixty-minute break.
    expect(res.body.data.hours_worked).toBeCloseTo(8, 1)

    const stored = await prisma.attendance.findFirstOrThrow({ where: { id: row.id } })
    // Stored, not derived on read — changing the shift's break minutes later
    // must not silently rewrite last month's totals.
    expect(Number(stored.hoursWorked)).toBeCloseTo(8, 1)
  })

  it('classifies a short day as half, and a very short one as absent', async () => {
    await punchIn('app', goodReading)
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: appEmpId } })

    // 6 hours elapsed minus a 1 hour break = 5 worked, against a 9 hour shift.
    await prisma.attendance.update({
      where: { id: row.id },
      data: { checkIn: new Date(Date.now() - 6 * 60 * 60 * 1000) },
    })

    const res = await punchOut('app')
    expect(res.body.data.status).toBe('half_day')
  })

  it("grades a check-out by the client's day: no break taken off, 8 h present, under 8 h a half day (8 Oct 2026)", async () => {
    const general = await prisma.shift.findFirstOrThrow({ where: { organizationId: orgId, name: 'General' } })
    await prisma.shift.update({ where: { id: general.id }, data: { breakMinutes: 0, minFullDayHours: 8, minHalfDayHours: 4.5 } })
    try {
      const day = async (hoursIn: number) => {
        await prisma.attendance.deleteMany({ where: { employeeId: appEmpId } })
        await punchIn('app', goodReading)
        const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: appEmpId } })
        await prisma.attendance.update({ where: { id: row.id }, data: { checkIn: new Date(Date.now() - hoursIn * 60 * 60 * 1000) } })
        return (await punchOut('app')).body.data
      }

      // While at work, the card is told a full day needs eight hours.
      await prisma.attendance.deleteMany({ where: { employeeId: appEmpId } })
      await punchIn('app', goodReading)
      expect((await request(app).get('/api/attendance/me/today').set('Authorization', at('app'))).body.data.full_day_hours).toBe(8)

      const full = await day(8.05)
      expect(full.hours_worked).toBeCloseTo(8.05, 1) // the whole stay: no break comes off
      expect(full.break_minutes).toBe(0)
      expect(full.status).toBe('present')

      expect((await day(7.9)).status).toBe('half_day')
      expect((await day(4.55)).status).toBe('half_day')
      expect((await day(4.4)).status).toBe('absent')
    } finally {
      await prisma.shift.update({ where: { id: general.id }, data: { breakMinutes: 60, minFullDayHours: null, minHalfDayHours: null } })
    }
  })

  it('refuses a check-out with no check-in', async () => {
    const res = await punchOut('app')

    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/not checked in/i)
  })

  it('refuses a second check-out', async () => {
    await punchIn('app', goodReading)
    await punchOut('app')
    const again = await punchOut('app')

    expect(again.status).toBe(409)
  })

  it('does NOT run the geofence on the way out', async () => {
    await punchIn('app', goodReading)

    // No reading sent, and the employee may well be at the bus stop by now.
    // Refusing here would leave a row with no check-out, which looks like they
    // never left and has to be corrected by hand.
    const res = await punchOut('app')
    expect(res.status).toBe(200)
  })
})

describe('a night shift, checked out of the next morning (client §34)', () => {
  // 22:00 to 06:00. The day is 9 Sep; the check-out is on the 10th.
  let nightEmpId = ''
  let nightShiftId = ''
  let generalShiftId = ''

  beforeAll(async () => {
    const night = await prisma.shift.create({
      data: { organizationId: orgId, name: 'Night', startTime: '22:00', endTime: '06:00', breakMinutes: 0, expectedHours: 8 },
    })
    nightShiftId = night.id
    nightEmpId = (await makeUser('night', 'employee', { attendanceMode: 'app', shiftId: night.id }))!
    generalShiftId = (await prisma.shift.findFirstOrThrow({ where: { organizationId: orgId, name: 'General' } })).id
  })

  /** A day of the night employee's on 9 Sep, checked in at `checkIn` (IST) and open unless `checkOut` is given. */
  const dayOn9th = (shiftId: string, checkIn = '22:05', checkOut: string | null = null) =>
    prisma.attendance.create({
      data: {
        organizationId: orgId, employeeId: nightEmpId, date: new Date(Date.UTC(2026, 8, 9)),
        checkIn: new Date(`2026-09-09T${checkIn}:00+05:30`), status: 'present', source: 'punch', expectedHours: 8, shiftId,
        ...(checkOut ? { checkOut: new Date(`2026-09-10T${checkOut}:00+05:30`), hoursWorked: 8 } : {}),
      },
    })

  /** A request made at an IST wall-clock time on 10 Sep. */
  async function at10Sep<T>(time: string, call: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`2026-09-10T${time}:00+05:30`))
    try {
      return await call()
    } finally {
      vi.useRealTimers()
    }
  }

  it('closes last night’s day at 06:00, not "not checked in today"', async () => {
    const row = await dayOn9th(nightShiftId)

    const res = await at10Sep('06:10', () => punchOut('night'))

    expect(res.status).toBe(200)
    expect(res.body.data.date).toBe('2026-09-09')
    // 22:05 to 06:10, no break.
    expect(res.body.data.hours_worked).toBeCloseTo(8.08, 1)
    const stored = await prisma.attendance.findFirstOrThrow({ where: { id: row.id } })
    expect(stored.checkOut?.getTime()).toBe(new Date('2026-09-10T06:10:00+05:30').getTime())
    // Nothing was filed under the 10th.
    expect(await prisma.attendance.count({ where: { employeeId: nightEmpId, date: new Date(Date.UTC(2026, 8, 10)) } })).toBe(0)
  })

  it('shows last night’s open day as the one to check out of', async () => {
    await dayOn9th(nightShiftId)

    const res = await at10Sep('05:00', () => request(app).get('/api/attendance/me/today').set('Authorization', at('night')))

    expect(res.status).toBe(200)
    expect(res.body.data.date).toBe('2026-09-09')
    expect(res.body.data.check_out).toBeNull()
  })

  it('refuses a new check-in while last night’s day is open', async () => {
    await dayOn9th(nightShiftId)

    const res = await at10Sep('05:00', () => punchIn('night', goodReading))

    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/still checked in from 9 Sep/i)
  })

  it('after checking out in the morning, shows the night done — a Check In then cannot take tonight’s place', async () => {
    await dayOn9th(nightShiftId, '22:05', '06:05')

    const today = await at10Sep('06:30', () => request(app).get('/api/attendance/me/today').set('Authorization', at('night')))
    expect(today.body.data.date).toBe('2026-09-09')
    expect(today.body.data.check_out).toEqual(expect.any(String))

    const early = await at10Sep('06:30', () => punchIn('night', goodReading))
    expect(early.status).toBe(409)
    expect(early.body.error.message).toMatch(/night shift of 9 Sep 2026 is checked out\. The next check-in opens at 18:00/)

    // Tonight's check-in is free.
    const tonight = await at10Sep('21:55', () => punchIn('night', goodReading))
    expect(tonight.status).toBe(201)
    expect(tonight.body.data.date).toBe('2026-09-10')
  })

  it('files a check-in after midnight under last night’s shift, so tonight’s is still free', async () => {
    const late = await at10Sep('00:20', () => punchIn('night', goodReading))
    expect(late.status).toBe(201)
    expect(late.body.data.date).toBe('2026-09-09')
    // 140 minutes after 22:00, on the 9th's clock.
    expect(late.body.data.late_minutes).toBe(140)

    const out = await at10Sep('06:00', () => punchOut('night'))
    expect(out.status).toBe(200)
    expect(out.body.data.date).toBe('2026-09-09')

    const tonight = await at10Sep('21:58', () => punchIn('night', goodReading))
    expect(tonight.status).toBe(201)
    expect(tonight.body.data.date).toBe('2026-09-10')
  })

  it('leaves a forgotten day alone once twenty hours have passed', async () => {
    await dayOn9th(nightShiftId)

    // 22:05 on the 9th to 18:30 on the 10th: a day somebody forgot to close, for HR to correct.
    const res = await at10Sep('18:30', () => punchOut('night'))

    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/not checked in/i)
  })

  it('does not carry over yesterday’s day shift left open, and today starts afresh', async () => {
    await dayOn9th(generalShiftId, '09:31')

    // Checked in 22½ hours ago: not today's.
    const out = await at10Sep('08:00', () => punchOut('night'))
    expect(out.status).toBe(400)
    const res = await at10Sep('08:00', () => punchIn('night', goodReading))
    expect(res.status).toBe(201)
    expect(res.body.data.date).toBe('2026-09-10')
  })

  it('never blocks the next morning’s check-in with a short day left open — even begun in the afternoon', async () => {
    // A morning on leave, in at 13:30, never checked out: under twenty hours later, still not today's.
    await dayOn9th(generalShiftId, '13:30')
    const res = await at10Sep('09:00', () => punchIn('night', goodReading))
    expect(res.status).toBe(201)
    expect(res.body.data.date).toBe('2026-09-10')
  })

  it('lets a long day that ran past midnight be checked out of', async () => {
    await dayOn9th(generalShiftId, '09:30')

    const res = await at10Sep('01:00', () => punchOut('night'))

    expect(res.status).toBe(200)
    expect(res.body.data.date).toBe('2026-09-09')
  })
})

describe('a day of approved leave', () => {
  // The app employee's General shift: 09:30 to 18:30, an hour's break, 9 hours.
  let leaveTypeId = ''
  const tenth = new Date(Date.UTC(2026, 8, 10))

  beforeAll(async () => {
    leaveTypeId = (await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })).id
  })

  /** Leave on 10 Sep, approved, with the row approval writes — the whole day, or half of it (and which half). */
  async function leaveOn10th(half: boolean, session: 'first_half' | 'second_half' | null = null) {
    await prisma.leaveRequest.create({
      data: {
        organizationId: orgId, employeeId: appEmpId, leaveTypeId, fromDate: tenth, toDate: tenth,
        halfDayDates: half ? ['2026-09-10'] : [], days: half ? 0.5 : 1, leaveYear: 2026, reason: 'Test', status: 'approved',
        ...(session ? { halfDaySessions: { '2026-09-10': session } } : {}),
      },
    })
    await prisma.attendance.create({ data: { organizationId: orgId, employeeId: appEmpId, date: tenth, status: 'on_leave', source: 'leave' } })
  }

  async function at10Sep<T>(time: string, call: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(`2026-09-10T${time}:00+05:30`))
    try {
      return await call()
    } finally {
      vi.useRealTimers()
    }
  }

  it('refuses a check-in on a whole day of it: the leave is reversed first', async () => {
    await leaveOn10th(false)

    const res = await at10Sep('09:30', () => punchIn('app', goodReading))

    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/approved leave/)
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: appEmpId, date: tenth } })
    expect(row.status).toBe('on_leave')
  })

  it('grades the worked half of a half day as a half — not as a short full day, which was absent', async () => {
    await leaveOn10th(true)

    expect((await at10Sep('09:30', () => punchIn('app', goodReading))).status).toBe(201)
    // 09:30 to 14:00 less the hour's break: 3½ hours, enough for half of 9.
    const out = await at10Sep('14:00', () => punchOut('app'))

    expect(out.status).toBe(200)
    expect(out.body.data.hours_worked).toBeCloseTo(3.5, 1)
    expect(out.body.data.status).toBe('half_day')
  })

  it('measures a morning on leave from the middle of the shift: in at 14:00 is on time, not hours late', async () => {
    await leaveOn10th(true, 'first_half')

    const inAt = await at10Sep('14:00', () => punchIn('app', goodReading))
    expect(inAt.status).toBe(201)
    expect(inAt.body.data.late_minutes).toBe(0)
    const out = await at10Sep('18:30', () => punchOut('app'))
    expect(out.body.data.status).toBe('half_day')
  })
})

describe('today, for the app to know which button to show', () => {
  it('returns null before anybody punches', async () => {
    const res = await request(app)
      .get('/api/attendance/me/today')
      .set('Authorization', at('app'))

    expect(res.status).toBe(200)
    expect(res.body.data).toBeNull()
  })

  it('returns the open row after check-in', async () => {
    await punchIn('app', goodReading)

    const res = await request(app)
      .get('/api/attendance/me/today')
      .set('Authorization', at('app'))

    expect(res.body.data.check_in).toEqual(expect.any(String))
    expect(res.body.data.check_out).toBeNull()
  })

  it('says the break the day\'s own shift takes off, and the server\'s clock to count the time at work by', async () => {
    await punchIn('app', goodReading)
    const before = Date.now()
    const res = await request(app)
      .get('/api/attendance/me/today')
      .set('Authorization', at('app'))

    // The General shift of this file: a 60-minute break.
    expect(res.body.data.break_minutes).toBe(60)
    // No minimums of its own: a full day is three quarters of its nine hours — the card counts down to it.
    expect(res.body.data.full_day_hours).toBe(6.75)
    const serverNow = Date.parse(res.body.data.server_now)
    expect(serverNow).toBeGreaterThanOrEqual(before - 1000)
    expect(serverNow).toBeLessThanOrEqual(Date.now() + 1000)
  })
})

describe('people attendance does not apply to', () => {
  it('tells an operator with no employee record why, rather than failing', async () => {
    const res = await punchIn('operator', goodReading)

    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/no employee record/i)
  })

  it('refuses an unauthenticated punch', async () => {
    const res = await request(app).post('/api/attendance/punch-in').send(goodReading)
    expect(res.status).toBe(401)
  })
})

describe('the date a punch is filed under', () => {
  it('uses the company timezone, not the server clock', async () => {
    await punchIn('app', goodReading)

    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: appEmpId } })

    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())

    // Between 18:30 and 23:59 UTC these two disagree, and a server-clock date
    // would file an evening punch under yesterday.
    expect(fromDateColumn(row.date)).toBe(expected)
  })
})
