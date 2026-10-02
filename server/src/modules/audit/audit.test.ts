import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { toDateColumn, fromDateColumn } from '../../domain/shared/dates'
import * as auditRepo from './audit.repository'

/**
 * The audit log: that the rows are written, by whom, in which request — and
 * the two promises that make it worth having. A change never commits without
 * its row. A security event never fails the request it describes.
 */

const PREFIX = 'audittest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

let orgId = ''
let clId = ''
const users: Record<string, { userId: string; membershipId: string; employeeId: string | null; token: string }> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.employeeSalaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.esiCoverage.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.ptSlab.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  // The audit rows go with the company.
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(key: string, role: 'super_admin' | 'accounts' | 'hr' | 'employee', withEmployee: boolean) {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  const employee = withEmployee
    ? await prisma.employee.create({
        data: { organizationId: orgId, memberships: { connect: { id: membership.id } }, employeeCode: `${PREFIX}-${key}`, fullName: `${key} person` },
      })
    : null
  const login = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  users[key] = { userId: user.id, membershipId: membership.id, employeeId: employee?.id ?? null, token: login.body.data.accessToken }
}

const as = (key: string) => `Bearer ${users[key]!.token}`
const rows = (where: Record<string, unknown> = {}) =>
  prisma.auditLog.findMany({ where: { organizationId: orgId, ...where }, orderBy: { createdAt: 'asc' } })

/** A Monday at least two weeks out, so leave dates are working days in the future. */
function nextMonday(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  d.setUTCDate(d.getUTCDate() + 14)
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1)
  return fromDateColumn(d)
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({
    data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] },
  })
  clId = (await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })).id
  for (const c of [
    { code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    { code: 'HRA', label: 'House Rent Allowance', displayOrder: 3 },
  ]) {
    await prisma.salaryComponent.create({ data: { organizationId: orgId, ...c } })
  }

  await makeUser('boss', 'super_admin', false)
  await makeUser('accounts', 'accounts', true)
  await makeUser('hr', 'hr', true)
  await makeUser('emp', 'employee', true)
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('signing in', () => {
  it('records a sign-in, with who and from where', async () => {
    const found = await rows({ action: 'auth.login_succeeded', actorUserId: users.boss!.userId })
    expect(found).toHaveLength(1)
    expect(found[0]!.details).toMatchObject({ ip: expect.any(String) })
  })

  it("records a wrong password on somebody's account — and nothing for an address that is nobody's", async () => {
    const before = (await rows()).length

    await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-boss@example.com`, password: 'NotThePassword1' })
    await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-nobody@example.com`, password: 'NotThePassword1' })

    const after = await rows()
    expect(after).toHaveLength(before + 1)
    expect(after.at(-1)).toMatchObject({
      action: 'auth.login_failed',
      actorUserId: null,
      entityId: users.boss!.userId,
      details: expect.objectContaining({ reason: 'wrong_password' }),
    })
  })
})

describe('refusals', () => {
  it('records who was refused what', async () => {
    const res = await request(app).get('/api/payroll/employees').set('Authorization', as('emp'))
    expect(res.status).toBe(403)

    const [denied] = await rows({ action: 'permission.denied', actorUserId: users.emp!.userId })
    expect(denied?.details).toMatchObject({ method: 'GET', path: '/api/payroll/employees' })
    expect(denied?.requestId).toBe(res.headers['x-request-id'])
  })

  it('still refuses — it does not turn into an error — when the row cannot be written', async () => {
    const broken = vi.spyOn(auditRepo, 'appendUnscoped').mockRejectedValueOnce(new Error('audit table unavailable'))
    try {
      const res = await request(app).get('/api/payroll/employees').set('Authorization', as('emp'))
      expect(res.status).toBe(403)
      // The write really was attempted and really failed — this is not a pass by default.
      expect(broken).toHaveBeenCalledTimes(1)
    } finally {
      broken.mockRestore()
    }
  })
})

describe('changes', () => {
  it('records a salary change with who made it and the request it came in', async () => {
    const employeeId = users.emp!.employeeId!
    const res = await request(app)
      .put(`/api/payroll/employees/${employeeId}/salary`)
      .set('Authorization', as('accounts'))
      .send({ effectiveFrom: '2026-01-01', ctc: 360_000, components: [{ code: 'BASIC', amount: 20_000 }, { code: 'HRA', amount: 10_000 }] })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const [set] = await rows({ action: 'salary.set', entityId: employeeId })
    expect(set).toMatchObject({
      actorUserId: users.accounts!.userId,
      entityType: 'employee',
      requestId: res.headers['x-request-id'],
      details: { kind: 'first', effectiveFrom: '2026-01-01', ctc: 360_000, previousCtc: null },
    })
  })

  it('records a leave decision once — a second, refused decision leaves nothing', async () => {
    const monday = nextMonday()
    const [year, month] = monday.split('-').map(Number)
    await prisma.leaveLedgerEntry.create({
      data: { organizationId: orgId, employeeId: users.emp!.employeeId!, leaveTypeId: clId, leaveYear: month! >= 4 ? year! : year! - 1, days: 12, reason: 'opening_grant' },
    })
    const applied = await request(app)
      .post('/api/leave-requests')
      .set('Authorization', as('emp'))
      .send({ leaveTypeId: clId, fromDate: monday, toDate: monday, reason: 'Audit test' })
    expect(applied.status, JSON.stringify(applied.body)).toBe(201)
    const id = applied.body.data.id

    // She has nobody above her, so the Super Admin decides (Day 22: the company tree).
    expect((await request(app).post(`/api/leave-requests/${id}/approve`).set('Authorization', as('boss')).send({})).status).toBe(200)
    expect((await request(app).post(`/api/leave-requests/${id}/approve`).set('Authorization', as('boss')).send({})).status).toBe(409)

    const decided = await rows({ action: 'leave.approved', entityId: id })
    expect(decided).toHaveLength(1)
    expect(decided[0]).toMatchObject({ actorUserId: users.boss!.userId, details: expect.objectContaining({ days: 1 }) })
    // Her own application is the request itself, not an audit row.
    expect(await rows({ action: 'leave.applied_for', entityId: id })).toHaveLength(0)
  })

  it('records a role change with what it was and what it became', async () => {
    const res = await request(app)
      .put(`/api/users/${users.emp!.membershipId}/role`)
      .set('Authorization', as('boss'))
      .send({ role: 'manager' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)

    const [changed] = await rows({ action: 'user.role_changed', entityId: users.emp!.membershipId })
    expect(changed).toMatchObject({ actorUserId: users.boss!.userId, details: { from: 'employee', to: 'manager' } })
  })

  it('writes nothing for a change that was refused', async () => {
    const res = await request(app)
      .put('/api/settings/pt-slabs')
      .set('Authorization', as('boss'))
      .send({ state: 'Kerala', effectiveFrom: '2026-10-01', slabs: [{ gender: 'any', from: 0, amount: 300 }] })
    expect(res.status).toBe(400)
    expect(await rows({ action: 'pt_table.set' })).toHaveLength(0)
  })

  it('never lets a change commit without its row', async () => {
    const before = await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })

    // The row fails to write: the change it describes must not survive either.
    const broken = vi.spyOn(auditRepo, 'append').mockRejectedValueOnce(new Error('audit table unavailable'))
    try {
      const res = await request(app).put('/api/settings/company').set('Authorization', as('boss')).send({ city: 'Nowhere' })
      expect(res.status).toBe(500)
    } finally {
      broken.mockRestore()
    }
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).city).toBe(before.city)

    // And written, it carries what changed.
    const res = await request(app).put('/api/settings/company').set('Authorization', as('boss')).send({ city: 'Pune' })
    expect(res.status).toBe(200)
    const [updated] = await rows({ action: 'company.updated' })
    // The role the actor held when they did it is kept with the facts — and,
    // since roles can be renamed (Day 21), what it was called then.
    expect(updated?.details).toEqual({ changes: { city: 'Pune' }, actorRole: 'super_admin', actorRoleName: 'Super Admin' })
  })
})
