import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { forOrg } from '../../platform/db/scoped'
import { storage } from '../../platform/storage'
import { purgeOldPunchPhotos } from './punchPhotos.service'
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
  role: 'super_admin' | 'hr' | 'employee',
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
/** A phone, as its browser describes itself: an office punch is from phones only (client, 11 Oct 2026). */
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36'
const phone = (key: string) => ({ Authorization: at(key), 'User-Agent': PHONE_UA })

/**
 * A punch as the app makes it (client, 11 Oct 2026): started first, its token
 * carried back. A start that is refused is the answer the person sees.
 */
async function punch(key: string, action: 'in' | 'out', body: object) {
  const start = await request(app).post('/api/attendance/punch-start').set(phone(key)).send({ action })
  if (start.status !== 200) return start
  return request(app).post(`/api/attendance/punch-${action}`).set(phone(key)).send({ token: start.body.data.token, ...asBurst(body) })
}

/**
 * The page sends a burst, each reading with its time: one reading written
 * loose here (latitude, longitude, accuracy) is sent as a burst of one, read
 * now; readings with no time are given now's.
 */
function asBurst(body: object): object {
  const { latitude, longitude, accuracyMeters, readings, ...rest } = body as Record<string, unknown> & { readings?: Record<string, unknown>[] }
  if (latitude !== undefined) return { ...rest, readings: [{ latitude, longitude, accuracyMeters, at: Date.now() }] }
  if (readings) return { ...rest, readings: readings.map((r) => ({ at: Date.now(), ...r })) }
  return rest
}

/** A reading at the office, with the accuracy a phone would report indoors. */
const goodReading = { ...OFFICE, accuracyMeters: 12 }

function punchIn(key: string, body: object = {}) {
  return punch(key, 'in', body)
}

/** At the office, by default: an office day's check-out is checked too. */
function punchOut(key: string, body: object = goodReading) {
  return punch(key, 'out', body)
}

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
  await prisma.punchEvidence.deleteMany({ where: { organization: { name: { startsWith: PREFIX } } } })
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

describe('check-in security (client, 11 Oct 2026)', () => {
  /** A point this many metres due north of the office. */
  const north = (metres: number, accuracyMeters = 5) => ({ latitude: OFFICE.latitude + metres / 111_194.93, longitude: OFFICE.longitude, accuracyMeters })

  it('needs the start token: none, the other way\'s, or somebody else\'s is refused', async () => {
    const send = (token: string | undefined, path = 'punch-in') =>
      request(app).post(`/api/attendance/${path}`).set(phone('app')).send({ ...(token ? { token } : {}), ...asBurst(goodReading) })
    expect((await send(undefined)).body.error.message).toMatch(/not started properly/)
    const out = (await request(app).post('/api/attendance/punch-start').set(phone('app')).send({ action: 'out' })).status
    expect(out).toBe(400) // nothing to check out of yet
    await prisma.attendance.create({ data: { organizationId: orgId, employeeId: appEmpId, date: new Date(Date.UTC(2020, 0, 6)), status: 'present' } })
    const otherWay = await request(app).post('/api/attendance/punch-start').set(phone('app')).send({ action: 'in' })
    expect((await send(otherWay.body.data.token, 'punch-out')).body.error.message).toMatch(/not started properly/)
    expect((await send(`${otherWay.body.data.token}x`)).body.error.message).toMatch(/not started properly/)
    expect(await prisma.attendance.count({ where: { employeeId: appEmpId, checkIn: { not: null } } })).toBe(0)
  })

  it('refuses a token older than two minutes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const start = await request(app).post('/api/attendance/punch-start').set(phone('app')).send({ action: 'in' })
      vi.setSystemTime(Date.now() + 121_000)
      const late = await request(app).post('/api/attendance/punch-in').set(phone('app')).send({ token: start.body.data.token, ...asBurst(goodReading) })
      expect(late.status).toBe(403)
      expect(late.body.error.message).toMatch(/took too long/)
    } finally {
      vi.useRealTimers()
    }
  })

  it('says at the start what the punch needs: the location, the radius and the accuracy', async () => {
    const start = await request(app).post('/api/attendance/punch-start').set(phone('app')).send({ action: 'in' })
    // The office is stored as 30 m and ±50 m; what is applied is the client's 20 and 20.
    expect(start.body.data).toMatchObject({ location_needed: true, radius_meters: 20, accuracy_meters: 20, expires_in_seconds: 120 })
  })

  it('is exact at the edge, whatever wider fence is stored: 20 m in, 21 m out', async () => {
    expect((await punchIn('app', north(21))).status).toBe(403)
    expect((await punchIn('app', north(25, 3))).body.error.message).toMatch(/25 m from the office\. Check in is allowed within 20 m/)
    expect((await punchIn('app', north(20))).status).toBe(201)
  })

  it('judges the most precise of the readings the phone took — chosen by the server', async () => {
    const readings = [
      { ...north(300), accuracyMeters: 60, at: 1_000 },
      { ...north(8), accuracyMeters: 9, at: 2_000 },
      { ...north(150), accuracyMeters: 18, at: 3_000 },
    ]
    const res = await punchIn('app', { readings })
    expect(res.status).toBe(201)
    expect(res.body.data.geofence.distance_meters).toBe(8)
    const kept = await prisma.punchEvidence.findFirstOrThrow({ where: { employeeId: appEmpId, action: 'in' } })
    expect([kept.accuracyMeters, kept.distanceMeters, kept.fenceApplied, kept.refusedFor, (kept.readings as unknown[]).length]).toEqual([9, 8, true, null, 3])
    expect(kept.attendanceId).toEqual(expect.any(String))
    expect(kept.ip).toEqual(expect.any(String))
  })

  it('keeps a refused punch as evidence — where, how precise, and why', async () => {
    await punchIn('app', north(2000, 10))
    await punchIn('app', { ...OFFICE, accuracyMeters: 90 })
    const tries = await prisma.punchEvidence.findMany({ where: { employeeId: appEmpId }, orderBy: { at: 'asc' } })
    expect(tries.map((t) => [t.action, t.refusedFor, t.attendanceId])).toEqual([['in', 'outside', null], ['in', 'unreliable', null]])
    expect(tries[0]!.distanceMeters).toBe(2000)
  })

  it('still reads the single reading an older page sends', async () => {
    const res = await punchIn('app', { latitude: OFFICE.latitude, longitude: OFFICE.longitude, accuracyMeters: 7 })
    expect(res.status).toBe(201)
    expect((await prisma.punchEvidence.findFirstOrThrow({ where: { employeeId: appEmpId } })).accuracyMeters).toBe(7)
  })

  it('FAILS CLOSED with no office set: nobody checks in at the office unconfirmed', async () => {
    await prisma.geofenceLocation.updateMany({ where: { organizationId: orgId }, data: { isActive: false } })
    try {
      const start = await request(app).post('/api/attendance/punch-start').set(phone('app')).send({ action: 'in' })
      expect(start.status).toBe(403)
      expect(start.body.error.message).toMatch(/office location is not set yet/)
      // And no way round it by skipping the start's answer.
      const workplace = await request(app).get('/api/attendance/me/workplace').set(phone('app'))
      expect(workplace.body.data.location_needed).toBe(true)
    } finally {
      await prisma.geofenceLocation.updateMany({ where: { organizationId: orgId }, data: { isActive: true } })
    }
  })

  it('asks nothing of somebody who works remotely', async () => {
    await prisma.employee.update({ where: { id: appEmpId }, data: { workArrangement: 'remote' } })
    try {
      const start = await request(app).post('/api/attendance/punch-start').set(phone('app')).send({ action: 'in' })
      expect(start.body.data).toMatchObject({ location_needed: false, radius_meters: null })
      expect((await punchIn('app', {})).status).toBe(201)
      expect((await punchOut('app', {})).status).toBe(200)
    } finally {
      await prisma.employee.update({ where: { id: appEmpId }, data: { workArrangement: 'office' } })
    }
  })

  it('refuses an app check-out from somebody on the biometric machine', async () => {
    const res = await request(app).post('/api/attendance/punch-start').set(phone('bio')).send({ action: 'out' })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/biometric machine, not checked out on the app/)
  })
})

describe('phones, flags, the selfie and one phone (client, 11 Oct 2026)', () => {
  const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36'
  /** The smallest JPEG there is: a selfie, as far as the server can tell. */
  const SELFIE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
  const as = (key: string, ua: string) => ({ Authorization: at(key), 'User-Agent': ua })
  const start = (key: string, body: object = {}, ua = PHONE_UA) => request(app).post('/api/attendance/punch-start').set(as(key, ua)).send({ action: 'in', ...body })
  const security = (data: object) => prisma.organization.update({ where: { id: orgId }, data })
  const lastEvidence = () => prisma.punchEvidence.findFirstOrThrow({ where: { employeeId: appEmpId }, orderBy: { at: 'desc' } })

  afterEach(async () => {
    await security({ punchPhoneOnly: true, punchSelfie: false, punchSelfieKeepDays: 60, punchOneDevice: false })
    await prisma.punchDevice.deleteMany({ where: { organizationId: orgId } })
    await prisma.employee.update({ where: { id: appEmpId }, data: { workArrangement: 'office' } })
  })

  it('phones only: an office punch from a computer is refused at its start — and kept as evidence', async () => {
    const refused = await start('app', {}, DESKTOP_UA)
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toMatch(/Check in from your phone/)
    expect(await lastEvidence()).toMatchObject({ refusedFor: 'not_phone', flags: ['not_a_phone'], userAgent: DESKTOP_UA })
    // Somebody remote is not asked where they are, so not asked what they punch from either.
    await prisma.employee.update({ where: { id: appEmpId }, data: { workArrangement: 'remote' } })
    expect((await start('app', {}, DESKTOP_UA)).status).toBe(200)
  })

  it('with phones-only off, a computer’s punch is taken — and flagged', async () => {
    await security({ punchPhoneOnly: false })
    const begun = await start('app', {}, DESKTOP_UA)
    expect(begun.status).toBe(200)
    const res = await request(app).post('/api/attendance/punch-in').set(as('app', DESKTOP_UA)).send({ token: begun.body.data.token, ...asBurst(goodReading) })
    expect(res.status).toBe(201)
    expect((await lastEvidence()).flags).toEqual(['not_a_phone'])
  })

  it('flags a burst that never moves, a reading too precise or too old, and the very same spot as an earlier day', async () => {
    const yesterday = new Date(Date.now() - 86_400_000)
    await prisma.punchEvidence.create({ data: { organizationId: orgId, employeeId: appEmpId, date: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())), action: 'in', startedAt: yesterday, at: yesterday, latitude: OFFICE.latitude, longitude: OFFICE.longitude } })
    const old = Date.now() - 10 * 60_000
    const frozen = [0, 1, 2].map((n) => ({ ...OFFICE, accuracyMeters: 1, at: old + n }))
    expect((await punchIn('app', { readings: frozen })).status).toBe(201)
    expect((await lastEvidence()).flags.sort()).toEqual(['frozen_readings', 'repeated_spot', 'stale_reading', 'too_precise'])
  })

  it('lists punches worth a second look — for whoever looks after others, never one’s own reach only', async () => {
    await punchIn('app', { latitude: OFFICE.latitude + 0.01, longitude: OFFICE.longitude, accuracyMeters: 5 })
    const list = await request(app).get('/api/attendance/suspicious').set(phone('operator'))
    expect(list.status).toBe(200)
    const mine = list.body.data.days.find((d: { employee_id: string }) => d.employee_id === appEmpId)
    expect(mine.punches[0]).toMatchObject({ action: 'in', refused_for: 'outside', distance_meters: expect.any(Number) })
    expect((await request(app).get('/api/attendance/suspicious').set(phone('app'))).status).toBe(403)
    expect((await request(app).get('/api/attendance/suspicious?from=2026-01-01&to=2026-12-31').set(phone('operator'))).status).toBe(400)
  })

  it('selfie: asked for at the start; a punch without one refused; with one, kept and shown — and deleted when its days are up', async () => {
    await security({ punchSelfie: true })
    expect((await start('app')).body.data.photo_needed).toBe(true)
    const none = await punchIn('app', goodReading)
    expect(none.status).toBe(403)
    expect(none.body.error.message).toMatch(/with your photo/)
    expect((await lastEvidence()).refusedFor).toBe('no_photo')

    expect((await punchIn('app', { ...goodReading, photo: SELFIE })).status).toBe(201)
    const kept = await lastEvidence()
    expect(kept.photoKey).toMatch(/attendance-photo/)
    expect(await storage().exists(kept.photoKey!)).toBe(true)
    const day = fromDateColumn(kept.date)
    const shown = await request(app).get(`/api/attendance/evidence?employeeId=${appEmpId}&date=${day}`).set(phone('operator'))
    expect(shown.body.data.find((p: { id: string }) => p.id === kept.id)).toMatchObject({ has_photo: true, refused_for: null })
    const photo = await request(app).get(`/api/attendance/evidence/${kept.id}/photo`).set(phone('operator'))
    expect([photo.status, photo.headers['content-type']]).toEqual([200, 'image/jpeg'])
    // Somebody whose reach does not cover her: nothing.
    expect((await request(app).get(`/api/attendance/evidence/${kept.id}/photo`).set(phone('bio'))).status).toBe(404)
    // Not a picture at all: refused before anything is kept.
    expect((await punchOut('app', { ...goodReading, photo: 'data:image/jpeg;base64,bm90IGEgcGljdHVyZQ==' })).status).toBe(400)

    // Its days up (60, to start): the nightly job deletes it, and the punch says so.
    await prisma.punchEvidence.update({ where: { id: kept.id }, data: { at: new Date(Date.now() - 61 * 86_400_000) } })
    const purged = await purgeOldPunchPhotos(forOrg(orgId), orgId, { apply: true })
    expect(purged.deleted).toBeGreaterThanOrEqual(1)
    expect((await prisma.punchEvidence.findUniqueOrThrow({ where: { id: kept.id } })).photoKey).toBeNull()
    expect(await storage().exists(kept.photoKey!)).toBe(false)
  })

  it('one phone: the first is theirs; another waits for HR, who is told; approving it takes the old one off', async () => {
    await security({ punchOneDevice: true })
    const A = 'phone-a-0123456789abcdef'
    const B = 'phone-b-0123456789abcdef'
    expect((await start('app', { deviceKey: A })).status).toBe(200)
    const other = await start('app', { deviceKey: B })
    expect(other.status).toBe(403)
    expect(other.body.error.message).toMatch(/not the one registered for you/)
    expect((await start('app', {})).body.error.message).toMatch(/cannot keep its registration/)
    const operator = await prisma.membership.findFirstOrThrow({ where: { organizationId: orgId, role: 'super_admin' } })
    expect(await prisma.notification.count({ where: { userId: operator.userId, event: 'attendance.device_waiting' } })).toBe(1)

    const waiting = (await request(app).get('/api/attendance/devices').set(phone('operator'))).body.data
    expect(waiting.map((d: { status: string; full_name: string }) => `${d.status} ${d.full_name}`)).toEqual(['waiting app person'])
    expect((await request(app).post(`/api/attendance/devices/${waiting[0].id}/approve`).set(phone('operator'))).status).toBe(200)
    expect((await start('app', { deviceKey: B })).status).toBe(200)
    // The old phone, taken off by the approval: it waits again — and HR is told.
    expect((await start('app', { deviceKey: A })).status).toBe(403)
    expect(await prisma.notification.count({ where: { userId: operator.userId, event: 'attendance.device_waiting' } })).toBe(2)
    const appLogin = await prisma.membership.findFirstOrThrow({ where: { employeeId: appEmpId } })
    expect(await prisma.notification.count({ where: { userId: appLogin.userId, event: 'attendance.device_approved' } })).toBe(1)

    // Taken off by HR, it waits again — and HR is told again.
    expect((await request(app).post(`/api/attendance/devices/${waiting[0].id}/retire`).set(phone('operator'))).status).toBe(200)
    expect((await start('app', { deviceKey: B })).status).toBe(403)
    expect(await prisma.notification.count({ where: { userId: operator.userId, event: 'attendance.device_waiting' } })).toBe(3)
    // Nobody but whoever corrects attendance decides phones.
    expect((await request(app).get('/api/attendance/devices').set(phone('app'))).status).toBe(403)
  })

  it('another phone is only flagged while one phone is off', async () => {
    const yesterday = new Date(Date.now() - 86_400_000)
    await prisma.punchEvidence.create({ data: { organizationId: orgId, employeeId: appEmpId, date: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())), action: 'in', startedAt: yesterday, at: yesterday, deviceKeyHash: 'f'.repeat(64) } })
    expect((await punchIn('app', { ...goodReading, deviceKey: 'a-new-phone-0123456789' })).status).toBe(201)
    expect((await lastEvidence()).flags).toContain('new_device')
  })
})

/**
 * What the independent review of check-in security found (11 Oct 2026), each
 * closed — and kept closed by these.
 */
describe('check-in security, as the review left it (11 Oct 2026)', () => {
  const SELFIE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='
  const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15'
  const away = { latitude: OFFICE.latitude + 0.01, longitude: OFFICE.longitude, accuracyMeters: 5 }
  const start = (key: string, body: object = {}) => request(app).post('/api/attendance/punch-start').set(phone(key)).send({ action: 'in', ...body })
  const security = (data: object) => prisma.organization.update({ where: { id: orgId }, data })
  const lastEvidence = (employeeId = appEmpId) => prisma.punchEvidence.findFirstOrThrow({ where: { employeeId }, orderBy: { at: 'desc' } })
  let hrA: string
  let hrB: string

  beforeAll(async () => {
    // Two HR people, each punching on the app too: fellow reviewers of each other's attendance.
    hrA = (await makeUser('hra', 'hr', { attendanceMode: 'app' }))!
    hrB = (await makeUser('hrb', 'hr', { attendanceMode: 'app' }))!
  })

  afterEach(async () => {
    await security({ punchSelfie: false, punchOneDevice: false })
    await prisma.punchDevice.deleteMany({ where: { organizationId: orgId } })
  })

  it('one phone: once HR has taken a phone off, a new one waits — clearing the browser never registers again by itself', async () => {
    await security({ punchOneDevice: true })
    expect((await start('app', { deviceKey: 'phone-a-0123456789abcdef' })).status).toBe(200)
    const first = await prisma.punchDevice.findFirstOrThrow({ where: { employeeId: appEmpId } })
    expect((await request(app).post(`/api/attendance/devices/${first.id}/retire`).set(phone('operator'))).status).toBe(200)
    // No approved phone left, yet a fresh key is not theirs by itself.
    const fresh = await start('app', { deviceKey: 'phone-c-0123456789abcdef' })
    expect(fresh.status).toBe(403)
    expect(fresh.body.error.message).toMatch(/not the one registered for you/)
    expect(await prisma.punchDevice.count({ where: { employeeId: appEmpId, status: 'waiting' } })).toBe(1)
  })

  it('phones go up the tree: never one’s own, nor a fellow HR’s', async () => {
    await security({ punchOneDevice: true })
    expect((await start('hrb', { deviceKey: 'hrb-phone-a-0123456789' })).status).toBe(200)
    expect((await start('hrb', { deviceKey: 'hrb-phone-b-0123456789' })).status).toBe(403)
    const waiting = await prisma.punchDevice.findFirstOrThrow({ where: { employeeId: hrB, status: 'waiting' } })
    const fellow = await request(app).post(`/api/attendance/devices/${waiting.id}/approve`).set(phone('hra'))
    expect(fellow.status).toBe(403)
    // Their own: not in what they look after, and not theirs to decide.
    expect((await start('hra', { deviceKey: 'hra-phone-a-0123456789' })).status).toBe(200)
    const own = await prisma.punchDevice.findFirstOrThrow({ where: { employeeId: hrA } })
    const listed = (await request(app).get('/api/attendance/devices?status=all').set(phone('hra'))).body.data as { employee_id: string; status: string }[]
    expect(listed.some((d) => d.employee_id === hrA)).toBe(false)
    expect((await request(app).post(`/api/attendance/devices/${own.id}/retire`).set(phone('hra'))).status).toBe(403)
    // The Super Admin decides it; waiting ones listed first.
    expect((await request(app).get('/api/attendance/devices?status=all').set(phone('operator'))).body.data[0].status).toBe('waiting')
    expect((await request(app).post(`/api/attendance/devices/${waiting.id}/approve`).set(phone('operator'))).status).toBe(200)
  })

  it('evidence: never one’s own — the signs on it could be tuned away — but the Super Admin’s', async () => {
    expect((await punchIn('hra', away)).status).toBe(403)
    const day = fromDateColumn((await lastEvidence(hrA)).date)
    expect((await request(app).get(`/api/attendance/evidence?employeeId=${hrA}&date=${day}`).set(phone('hra'))).status).toBe(403)
    const theirs = (await request(app).get('/api/attendance/suspicious').set(phone('hra'))).body.data.days as { employee_id: string }[]
    expect(theirs.some((d) => d.employee_id === hrA)).toBe(false)
    const operators = (await request(app).get('/api/attendance/suspicious').set(phone('operator'))).body.data.days as { employee_id: string }[]
    expect(operators.some((d) => d.employee_id === hrA)).toBe(true)
    // An employee, of their own day: refused.
    expect((await punchIn('app', away)).status).toBe(403)
    expect((await request(app).get(`/api/attendance/evidence?employeeId=${appEmpId}&date=${day}`).set(phone('app'))).status).toBe(403)
    // HR, of somebody else's: shown.
    expect((await request(app).get(`/api/attendance/evidence?employeeId=${appEmpId}&date=${day}`).set(phone('hra'))).status).toBe(200)
  })

  it('the selfie is kept only when the company asks; with a refusal only the first three a day; the very same photo again is flagged', async () => {
    // Off: a photo sent anyway is not stored.
    expect((await punchIn('app', { ...goodReading, photo: SELFIE })).status).toBe(201)
    expect((await lastEvidence()).photoKey).toBeNull()
    await prisma.punchEvidence.deleteMany({ where: { employeeId: appEmpId } })
    await prisma.attendance.deleteMany({ where: { employeeId: appEmpId } })

    await security({ punchSelfie: true })
    for (let i = 0; i < 4; i += 1) expect((await punchIn('app', { ...away, photo: SELFIE })).status).toBe(403)
    expect(await prisma.punchEvidence.count({ where: { employeeId: appEmpId, refusedFor: 'outside' } })).toBe(4)
    expect(await prisma.punchEvidence.count({ where: { employeeId: appEmpId, refusedFor: 'outside', photoKey: { not: null } } })).toBe(3)
    // Taken at last with the same file: not a repeat of a refusal's.
    expect((await punchIn('app', { ...goodReading, photo: SELFIE })).status).toBe(201)
    expect((await lastEvidence()).flags).not.toContain('repeated_photo')
    // …but the same file again on the way out is: a camera never gives the same photo twice.
    expect((await punchOut('app', { ...goodReading, photo: SELFIE })).status).toBe(200)
    expect((await lastEvidence()).flags).toContain('repeated_photo')
  })

  it('only the burst the page sends: each reading with its time; a key left out is a sign once there are earlier ones', async () => {
    const begun = await start('app')
    const loose = await request(app).post('/api/attendance/punch-in').set(phone('app')).send({ token: begun.body.data.token, ...goodReading })
    expect(loose.status).toBe(422)
    const untimed = await request(app).post('/api/attendance/punch-in').set(phone('app')).send({ token: begun.body.data.token, readings: [goodReading] })
    expect(untimed.status).toBe(422)
    const yesterday = new Date(Date.now() - 86_400_000)
    await prisma.punchEvidence.create({ data: { organizationId: orgId, employeeId: appEmpId, date: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())), action: 'in', startedAt: yesterday, at: yesterday, deviceKeyHash: 'e'.repeat(64) } })
    expect((await punchIn('app', goodReading)).status).toBe(201)
    expect((await lastEvidence()).flags).toContain('new_device')
  })

  it('a Mac that says it has a touch screen — an iPad, or a laptop told to say so — is taken, and said', async () => {
    const begun = await request(app).post('/api/attendance/punch-start').set({ Authorization: at('app'), 'User-Agent': MAC_UA }).send({ action: 'in', touchPoints: 5 })
    expect(begun.status).toBe(200)
    const res = await request(app).post('/api/attendance/punch-in').set({ Authorization: at('app'), 'User-Agent': MAC_UA }).send({ token: begun.body.data.token, touchPoints: 5, ...asBurst(goodReading) })
    expect(res.status).toBe(201)
    expect((await lastEvidence()).flags).toContain('mac_with_touch')
  })

  it('two taps at once on a day that already has a row check in once', async () => {
    const day = new Date(`${new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })}T00:00:00Z`)
    await prisma.attendance.create({ data: { organizationId: orgId, employeeId: appEmpId, date: day, status: 'absent', source: 'manual' } })
    const both = await Promise.all([punchIn('app', goodReading), punchIn('app', goodReading)])
    expect(both.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await prisma.punchEvidence.count({ where: { employeeId: appEmpId, action: 'in', refusedFor: null } })).toBe(1)
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
      expect((await request(app).get('/api/attendance/me/today').set(phone('app'))).body.data.full_day_hours).toBe(8)

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

  it('runs the geofence on the way out too, when the company says so (client, 11 Oct 2026)', async () => {
    await punchIn('app', goodReading)

    const away = await punchOut('app', { latitude: 18.5234303, longitude: 73.8567437, accuracyMeters: 10 })
    expect(away.status).toBe(403)
    expect(away.body.error).toMatchObject({ code: 'LOCATION_REFUSED', details: { action: 'out', reason: 'outside' } })
    expect(away.body.error.message).toMatch(/Check out is allowed within 20 m/)
    expect(await prisma.attendance.count({ where: { employeeId: appEmpId, checkOut: { not: null } } })).toBe(0)

    const none = await punchOut('app', {})
    expect(none.status).toBe(403)
    expect(none.body.error.message).toMatch(/Location is required to check out/)

    expect((await punchOut('app')).status).toBe(200)
  })

  it('with the check turned off, takes a check-out from anywhere — and keeps where it was', async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { punchCheckOutLocation: false } })
    try {
      await punchIn('app', goodReading)
      const res = await punchOut('app', { latitude: 18.5234303, longitude: 73.8567437, accuracyMeters: 10 })
      expect(res.status).toBe(200)
      const kept = await prisma.punchEvidence.findFirstOrThrow({ where: { employeeId: appEmpId, action: 'out' }, orderBy: { at: 'desc' } })
      expect([kept.fenceApplied, kept.refusedFor, kept.accuracyMeters]).toEqual([false, null, 10])
      expect((await punchOut('app', {})).status).toBe(409)
    } finally {
      await prisma.organization.update({ where: { id: orgId }, data: { punchCheckOutLocation: true } })
    }
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

    const res = await at10Sep('05:00', () => request(app).get('/api/attendance/me/today').set(phone('night')))

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

    const today = await at10Sep('06:30', () => request(app).get('/api/attendance/me/today').set(phone('night')))
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
      .set(phone('app'))

    expect(res.status).toBe(200)
    expect(res.body.data).toBeNull()
  })

  it('returns the open row after check-in', async () => {
    await punchIn('app', goodReading)

    const res = await request(app)
      .get('/api/attendance/me/today')
      .set(phone('app'))

    expect(res.body.data.check_in).toEqual(expect.any(String))
    expect(res.body.data.check_out).toBeNull()
  })

  it('says the break the day\'s own shift takes off, and the server\'s clock to count the time at work by', async () => {
    await punchIn('app', goodReading)
    const before = Date.now()
    const res = await request(app)
      .get('/api/attendance/me/today')
      .set(phone('app'))

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
