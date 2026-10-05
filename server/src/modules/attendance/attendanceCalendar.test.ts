import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { toDateColumn } from '../../domain/shared/dates'

/**
 * The attendance calendar's days off, and the Timings an employee reads on
 * their Attendance page.
 *
 * Nobody marks a holiday or a weekly off, so a calendar drawn only from
 * attendance rows left those days blank — as if the person had not come in.
 * GET /attendance/calendar names them: the working week's days off, any
 * weekly-off day kept in the holiday list, and public holidays by name.
 */

const PREFIX = 'attcal'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
let otherOrgId = ''
const tokens: Record<string, string> = {}

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.holiday.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.shift.deleteMany({ where: org })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function login(key: string, role: 'hr' | 'employee', shiftId: string | null = null, joined: string | null = null) {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  await prisma.employee.create({
    data: {
      organizationId: orgId,
      memberships: { connect: { id: membership.id } },
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key} person`,
      attendanceMode: 'app',
      shiftId,
      dateOfJoining: joined ? toDateColumn(joined) : null,
    },
  })
  tokens[key] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
}

const get = (path: string, key: string) =>
  request(app).get(`/api/attendance${path}`).set('Authorization', `Bearer ${tokens[key]}`)

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  otherOrgId = (await prisma.organization.create({ data: { name: `${PREFIX}-other`, timezone: 'Asia/Kolkata' } })).id

  // Sundays off. April 2026 starts on a Wednesday: its Sundays are the 5th, 12th, 19th and 26th.
  await prisma.organizationPolicy.create({
    data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), weeklyOffDays: [0] },
  })
  await prisma.holiday.createMany({
    data: [
      // On a Sunday: the holiday's name wins over "weekly off".
      { organizationId: orgId, date: toDateColumn('2026-04-05'), name: 'Easter Sunday', type: 'public' },
      // A Saturday kept off in the holiday list.
      { organizationId: orgId, date: toDateColumn('2026-04-11'), name: 'Second Saturday', type: 'weekly_off' },
      { organizationId: orgId, date: toDateColumn('2026-04-14'), name: 'Ambedkar Jayanti', type: 'public' },
      // Each person's own choice: it frees nobody's day, so it is not a day off.
      { organizationId: orgId, date: toDateColumn('2026-04-03'), name: 'Good Friday', type: 'optional' },
      // Another company's holiday is not this company's.
      { organizationId: otherOrgId, date: toDateColumn('2026-04-20'), name: 'Their Holiday', type: 'public' },
    ],
  })

  const shift = await prisma.shift.create({
    data: { organizationId: orgId, name: 'General', startTime: '09:30', endTime: '18:30', breakMinutes: 60, expectedHours: 9 },
  })
  await login('hr', 'hr')
  await login('emp', 'employee', shift.id, '2026-03-16')
  await login('noshift', 'employee')
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the month calendar — days off nobody marks', () => {
  it('names every day off in the month, a holiday over a weekly off', async () => {
    const res = await get('/calendar?year=2026&month=4', 'hr')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({
      year: 2026,
      month: 4,
      weekly_off_days: [0],
      days_off: [
        { date: '2026-04-05', kind: 'holiday', name: 'Easter Sunday' },
        { date: '2026-04-11', kind: 'weekly_off', name: null },
        { date: '2026-04-12', kind: 'weekly_off', name: null },
        { date: '2026-04-14', kind: 'holiday', name: 'Ambedkar Jayanti' },
        { date: '2026-04-19', kind: 'weekly_off', name: null },
        { date: '2026-04-26', kind: 'weekly_off', name: null },
      ],
    })
  })

  it('is the same for an employee reading only their own attendance', async () => {
    const res = await get('/calendar?year=2026&month=4', 'emp')
    expect(res.status).toBe(200)
    expect(res.body.data.days_off).toHaveLength(6)
  })

  it('ends on the last day of a short month', async () => {
    // February 2026 starts on a Sunday: the 1st, 8th, 15th and 22nd.
    const res = await get('/calendar?year=2026&month=2', 'emp')
    expect(res.status).toBe(200)
    expect(res.body.data.days_off.map((d: { date: string }) => d.date)).toEqual(['2026-02-01', '2026-02-08', '2026-02-15', '2026-02-22'])
  })

  it('refuses a month that is not one', async () => {
    expect((await get('/calendar?year=2026&month=13', 'hr')).status).toBe(422)
    expect((await get('/calendar?year=2026', 'hr')).status).toBe(422)
  })

  it('needs a sign-in', async () => {
    expect((await request(app).get('/api/attendance/calendar?year=2026&month=4')).status).toBe(401)
  })
})

describe('the workplace — the Timings card', () => {
  it('carries the shift with its break, and the working week’s days off', async () => {
    const res = await get('/me/workplace', 'emp')
    expect(res.status).toBe(200)
    expect(res.body.data.shift).toEqual({ name: 'General', start_time: '09:30', end_time: '18:30', break_minutes: 60 })
    expect(res.body.data.weekly_off_days).toEqual([0])
    // Their log starts on the day they joined.
    expect(res.body.data.date_of_joining).toBe('2026-03-16')
  })

  it('says no shift, rather than inventing one', async () => {
    const res = await get('/me/workplace', 'noshift')
    expect(res.status).toBe(200)
    expect(res.body.data.shift).toBeNull()
    expect(res.body.data.weekly_off_days).toEqual([0])
    expect(res.body.data.date_of_joining).toBeNull()
  })
})

describe('a working week that changed', () => {
  it('draws each month by the rules in force then — September before Saturdays were added, October after', async () => {
    // Saturdays off too, from 1 Oct 2026: the policy in force until then ends on 30 Sep.
    const before = await prisma.organizationPolicy.findFirstOrThrow({ where: { organizationId: orgId, effectiveTo: null } })
    await prisma.organizationPolicy.update({ where: { id: before.id }, data: { effectiveTo: toDateColumn('2026-09-30') } })
    const added = await prisma.organizationPolicy.create({
      data: { organizationId: orgId, effectiveFrom: toDateColumn('2026-10-01'), weeklyOffDays: [0, 6] },
    })
    try {
      const september = await get('/calendar?year=2026&month=9', 'hr')
      const days = september.body.data.days_off.map((d: { date: string }) => d.date)
      // Sundays only: the 6th, 13th, 20th and 27th — not Saturday the 5th.
      expect(days).toEqual(['2026-09-06', '2026-09-13', '2026-09-20', '2026-09-27'])
      expect(september.body.data.weekly_off_days).toEqual([0])

      const october = await get('/calendar?year=2026&month=10', 'hr')
      expect(october.body.data.days_off.map((d: { date: string }) => d.date)).toContain('2026-10-03')
      expect(october.body.data.weekly_off_days).toEqual([0, 6])
    } finally {
      await prisma.organizationPolicy.delete({ where: { id: added.id } })
      await prisma.organizationPolicy.update({ where: { id: before.id }, data: { effectiveTo: null } })
    }
  })
})

describe('a company with no working week written yet', () => {
  it('takes Sunday off, as leave is counted', async () => {
    await prisma.organizationPolicy.deleteMany({ where: { organizationId: orgId } })
    try {
      const res = await get('/calendar?year=2026&month=2', 'hr')
      expect(res.body.data.weekly_off_days).toEqual([0])
      expect(res.body.data.days_off).toHaveLength(4)
    } finally {
      await prisma.organizationPolicy.create({
        data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), weeklyOffDays: [0] },
      })
    }
  })
})
