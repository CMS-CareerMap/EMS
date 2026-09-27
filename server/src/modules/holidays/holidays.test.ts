import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { toDateColumn } from '../../domain/shared/dates'

/**
 * The holiday calendar: readable by everybody who applies for leave, kept by
 * Super Admin and HR — and a public holiday really is a day leave is not
 * charged for.
 */

const PREFIX = 'holtest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

let orgId = ''
let otherOrgId = ''
let leaveTypeId = ''
const tokens: Record<string, string> = {}
const employeeIds: Record<string, string> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.holiday.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function login(key: string, role: 'hr' | 'employee' | 'manager') {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  employeeIds[key] = (
    await prisma.employee.create({
      data: { organizationId: orgId, membershipId: membership.id, employeeCode: `${PREFIX}-${key}`, fullName: `${key} person` },
    })
  ).id
  tokens[key] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
}

const as = (key: string) => `Bearer ${tokens[key]}`
const list = (key: string, year = 2027) =>
  request(app).get(`/api/holidays?year=${year}`).set('Authorization', as(key))
const add = (body: Record<string, unknown>, key = 'hr') =>
  request(app).post('/api/holidays').set('Authorization', as(key)).send(body)

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org` } })).id
  otherOrgId = (await prisma.organization.create({ data: { name: `${PREFIX}-other` } })).id

  // A five-day week, so a weekday holiday is the only thing that can shorten a
  // Monday-to-Wednesday request.
  await prisma.organizationPolicy.create({
    data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), weeklyOffDays: [0, 6] },
  })
  leaveTypeId = (
    await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })
  ).id

  await login('hr', 'hr')
  await login('mgr', 'manager')
  await login('emp', 'employee')
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('reading the calendar', () => {
  it('is open to an employee — it used to be a permission error on the Leave page', async () => {
    const res = await list('emp')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.data)).toBe(true)
  })
})

describe('keeping the calendar', () => {
  it('lets HR add Diwali, and everybody then sees it', async () => {
    const res = await add({ date: '2027-10-29', name: 'Diwali' })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ date: '2027-10-29', name: 'Diwali', type: 'public' })

    const seen = await list('emp')
    expect(seen.body.data.map((h: { name: string }) => h.name)).toContain('Diwali')
  })

  it('refuses the same holiday twice on one day, whatever the capitalisation', async () => {
    expect((await add({ date: '2027-10-29', name: 'diwali' })).status).toBe(409)
    // A different holiday on the same day is fine — two festivals can coincide.
    expect((await add({ date: '2027-10-29', name: 'Laxmi Puja', type: 'optional' })).status).toBe(201)
  })

  it('only offers public and optional — weekly offs are the Working Days setting', async () => {
    expect((await add({ date: '2027-11-06', name: 'Extra', type: 'weekly_off' })).status).toBe(422)
  })

  it('moves and renames a holiday, but not onto one that exists', async () => {
    const created = await add({ date: '2027-03-22', name: 'Holi' })
    const id = created.body.data.id

    const moved = await request(app).patch(`/api/holidays/${id}`).set('Authorization', as('hr')).send({ date: '2027-03-23' })
    expect(moved.status).toBe(200)
    expect(moved.body.data.date).toBe('2027-03-23')

    await add({ date: '2027-08-15', name: 'Independence Day' })
    const clash = await request(app).patch(`/api/holidays/${id}`).set('Authorization', as('hr'))
      .send({ date: '2027-08-15', name: 'Independence Day' })
    expect(clash.status).toBe(409)
  })

  it('removes a holiday', async () => {
    const created = await add({ date: '2027-12-31', name: 'Year End' })
    const res = await request(app).delete(`/api/holidays/${created.body.data.id}`).set('Authorization', as('hr'))
    expect(res.status).toBe(200)
    expect((await list('hr')).body.data.map((h: { name: string }) => h.name)).not.toContain('Year End')
  })

  it('says how much approved leave a new holiday falls inside, since that is not recalculated', async () => {
    await prisma.leaveRequest.create({
      data: {
        organizationId: orgId,
        employeeId: employeeIds.emp!,
        leaveTypeId,
        fromDate: toDateColumn('2027-01-11'),
        toDate: toDateColumn('2027-01-13'),
        days: 3,
        leaveYear: 2026,
        reason: 'Already approved',
        status: 'approved',
      },
    })

    const res = await add({ date: '2027-01-12', name: 'Local Festival' })
    expect(res.status).toBe(201)
    expect(res.body.meta.approved_leave_affected).toBe(1)
  })

  it('is refused to a manager and an employee', async () => {
    expect((await add({ date: '2027-06-01', name: 'Team Day' }, 'mgr')).status).toBe(403)
    expect((await add({ date: '2027-06-01', name: 'My Day' }, 'emp')).status).toBe(403)
  })

  it("cannot touch another company's calendar", async () => {
    const theirs = await prisma.holiday.create({
      data: { organizationId: otherOrgId, name: 'Their Day', date: toDateColumn('2027-05-01') },
    })
    expect((await request(app).delete(`/api/holidays/${theirs.id}`).set('Authorization', as('hr'))).status).toBe(404)
    expect(await prisma.holiday.count({ where: { id: theirs.id } })).toBe(1)
  })
})

describe('what a holiday does to leave', () => {
  const preview = (from: string, to: string) =>
    request(app).post('/api/leave-requests/preview').set('Authorization', as('emp'))
      .send({ leaveTypeId, fromDate: from, toDate: to })

  it('a public holiday is not charged, an optional one is', async () => {
    // Mon 7 – Wed 9 June 2027: three working days before any holiday.
    expect((await preview('2027-06-07', '2027-06-09')).body.data.days).toBe(3)

    await add({ date: '2027-06-08', name: 'Optional Day', type: 'optional' })
    // Optional is each person's own choice — it frees nobody automatically.
    expect((await preview('2027-06-07', '2027-06-09')).body.data.days).toBe(3)

    await add({ date: '2027-06-08', name: 'Public Day', type: 'public' })
    expect((await preview('2027-06-07', '2027-06-09')).body.data.days).toBe(2)
  })
})
