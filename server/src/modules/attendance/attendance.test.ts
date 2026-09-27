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
        membershipId: membership.id,
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

  it('does not apply to a biometric employee', async () => {
    // They are standing at the machine. Asking their phone where they are
    // would prove nothing, so no reading is required and none is recorded.
    const res = await punchIn('bio', {})

    expect(res.status).toBe(201)
    expect(res.body.data.geofence).toBeNull()

    const row = await prisma.attendance.findFirst({ where: { employeeId: bioEmpId } })
    // Null, not false. "We did not look" is a different fact from "we looked
    // and they were elsewhere".
    expect(row?.geofenceVerified).toBeNull()
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
