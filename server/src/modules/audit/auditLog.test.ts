import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'

/**
 * Reading the audit log back (Day 20): who may, what they see, and that paging
 * and the filters find exactly the rows asked for — on the company's clock.
 */

const PREFIX = 'auditread'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

let orgId = ''
const users: Record<string, { userId: string; membershipId: string; employeeId: string | null; token: string; email: string; cookie: string }> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.documentType.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(key: string, role: 'super_admin' | 'hr' | 'employee', fullName: string | null) {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  const membership = await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
  const employee = fullName
    ? await prisma.employee.create({ data: { organizationId: orgId, membershipId: membership.id, employeeCode: `${PREFIX}-${key}`, fullName } })
    : null
  const login = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  const cookie = [login.headers['set-cookie']].flat().find((c) => String(c).startsWith('ems_refresh')) ?? ''
  users[key] = { userId: user.id, membershipId: membership.id, employeeId: employee?.id ?? null, token: login.body.data.accessToken, email, cookie: String(cookie).split(';')[0] ?? '' }
}

const as = (key: string) => `Bearer ${users[key]!.token}`
const get = (key: string, query = '') => request(app).get(`/api/audit-log${query}`).set('Authorization', as(key))

async function row(action: string, at: string, extra: { actor?: string | null; entityType?: string; entityId?: string; details?: Record<string, unknown> } = {}) {
  return prisma.auditLog.create({
    data: {
      organizationId: orgId,
      actorUserId: extra.actor === undefined ? users.boss!.userId : extra.actor,
      action,
      entityType: extra.entityType ?? null,
      entityId: extra.entityId ?? null,
      details: (extra.details ?? {}) as object,
      createdAt: new Date(at),
    },
  })
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await makeUser('boss', 'super_admin', 'Meera Boss')
  await makeUser('hr', 'hr', 'Hema Hr')
  await makeUser('ravi', 'employee', 'Ravi Patil')
  await prisma.documentType.create({ data: { organizationId: orgId, code: 'AADHAAR', label: 'Aadhaar Card' } })
  await prisma.salaryComponent.create({ data: { organizationId: orgId, code: 'INCENTIVE', label: 'Incentive', entry: 'monthly' } })
})

afterAll(cleanup)

describe('who may read it', () => {
  it('is Super Admin’s alone — HR and an employee are refused, and the refusal is itself recorded', async () => {
    expect((await get('hr')).status).toBe(403)
    expect((await get('ravi')).status).toBe(403)
    expect((await request(app).get('/api/audit-log/export').set('Authorization', as('hr'))).status).toBe(403)
    expect((await request(app).get('/api/audit-log')).status).toBe(401)

    const refused = await prisma.auditLog.findMany({ where: { organizationId: orgId, action: 'permission.denied', actorUserId: users.hr!.userId } })
    expect(refused.length).toBeGreaterThanOrEqual(2)
  })

  it('offers no way to change or remove a row', async () => {
    const one = await row('company.updated', '2026-01-01T00:00:00Z', { details: { changes: { name: 'x' } } })
    for (const method of ['put', 'patch', 'delete', 'post'] as const) {
      const res = await request(app)[method](`/api/audit-log/${one.id}`).set('Authorization', as('boss'))
      expect(res.status, method).toBe(404)
    }
    expect(await prisma.auditLog.count({ where: { id: one.id } })).toBe(1)
  })
})

describe('what a row says', () => {
  it('reads as a sentence with names, and says who did it and as what', async () => {
    await row('user.role_changed', '2026-02-01T06:00:00Z', { entityType: 'membership', entityId: users.ravi!.membershipId, details: { from: 'employee', to: 'hr' } })
    // Written while Hema was a manager: the row keeps that, whatever she is now.
    await row('document.downloaded', '2026-02-01T06:01:00Z', { actor: users.hr!.userId, entityType: 'employee_document', entityId: '00000000-0000-4000-8000-000000000001', details: { employeeId: users.ravi!.employeeId, type: 'AADHAAR', own: false, actorRole: 'manager' } })
    await row('payroll.entry_set', '2026-02-01T06:02:00Z', { details: { employeeId: users.ravi!.employeeId, component: 'INCENTIVE', year: 2026, month: 1, amount: 2500 } })
    await row('auth.login_failed', '2026-02-01T06:03:00Z', { actor: null, entityType: 'user', entityId: users.ravi!.userId, details: { reason: 'wrong_password', ip: '10.1.2.3', userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36' } })

    const res = await get('boss', '?from=2026-02-01&to=2026-02-01')
    expect(res.status).toBe(200)
    const [failed, entry, opened, role] = res.body.data
    expect(role.summary).toBe('Changed Ravi Patil’s role from Employee to HR')
    expect(role.action_label).toBe('Role changed')
    expect(role.category_label).toBe('Users and roles')
    // A row from before roles were written with it says the role is today's.
    expect(role.actor).toEqual({ user_id: users.boss!.userId, name: 'Meera Boss', role: 'Super Admin (now)' })
    expect(opened.summary).toBe('Opened Ravi Patil’s Aadhaar Card')
    expect(opened.actor.name).toBe('Hema Hr')
    expect(opened.actor.role).toBe('Manager')
    expect(entry.summary).toBe('Set Incentive of ₹2,500.00 for Ravi Patil, January 2026')
    expect(failed.summary).toBe('Sign-in to Ravi Patil refused: wrong password')
    expect(failed.actor).toBeNull()
    expect(failed.ip).toBe('10.1.2.3')
    expect(failed.device).toBe('Chrome on Windows')

    // Exactly these fields — no raw details, so nothing a row carries leaks by accident.
    expect(Object.keys(role).sort()).toEqual(['action', 'action_label', 'actor', 'at', 'category', 'category_label', 'device', 'id', 'ip', 'request_id', 'summary'])
    expect(res.body.meta.categories.map((c: { id: string }) => c.id)).toContain('pay')
  })
})

describe('paging', () => {
  it('pages 50 at a time with nothing skipped or repeated, even for rows written in the same millisecond', async () => {
    const at = '2025-06-15T08:00:00.000Z'
    for (let i = 0; i < 120; i++) await row('holiday.added', at, { details: { name: `H${i}`, date: '2025-08-15' } })

    const seen: string[] = []
    let query = '?from=2025-06-15&to=2025-06-15'
    let pages = 0
    for (;;) {
      const res = await get('boss', query)
      expect(res.status).toBe(200)
      seen.push(...res.body.data.map((r: { id: string }) => r.id))
      pages++
      if (!res.body.meta.more) break
      const last = res.body.data[res.body.data.length - 1]
      query = `?from=2025-06-15&to=2025-06-15&before=${encodeURIComponent(last.at)}&beforeId=${last.id}`
    }
    expect(pages).toBe(3)
    expect(seen.length).toBe(120)
    expect(new Set(seen).size).toBe(120)
  })
})

describe('filters', () => {
  it('counts days on the company’s clock — 00:30 in Kolkata is that day, not the one before in UTC', async () => {
    const late = await row('geofence.saved', '2024-03-31T19:00:00Z', { details: { name: 'Pune office', created: true } }) // 1 Apr 00:30 IST
    const inApril = (await get('boss', '?from=2024-04-01&to=2024-04-01')).body.data.map((r: { id: string }) => r.id)
    const inMarch = (await get('boss', '?from=2024-03-31&to=2024-03-31')).body.data.map((r: { id: string }) => r.id)
    expect(inApril).toContain(late.id)
    expect(inMarch).not.toContain(late.id)
  })

  it('narrows to one area', async () => {
    const res = await get('boss', '?category=pay&from=2026-02-01&to=2026-02-01')
    expect(res.body.data.map((r: { action: string }) => r.action)).toEqual(['payroll.entry_set'])
  })

  it('narrows to who did it', async () => {
    const res = await get('boss', `?actor=${users.hr!.userId}&from=2026-02-01&to=2026-02-01`)
    expect(res.body.data.map((r: { action: string }) => r.action)).toEqual(['document.downloaded'])
  })

  it('finds everything about one person — their record, their login, and rows naming them', async () => {
    await row('employee.updated', '2026-03-01T06:00:00Z', { entityType: 'employee', entityId: users.ravi!.employeeId!, details: { fields: ['phone'], statutoryFields: [] } })
    await row('auth.login_succeeded', '2026-03-01T06:01:00Z', { actor: users.ravi!.userId, entityType: 'user', entityId: users.ravi!.userId })
    await row('employee.updated', '2026-03-01T06:02:00Z', { entityType: 'employee', entityId: users.hr!.employeeId!, details: { fields: ['phone'], statutoryFields: [] } })

    const res = await get('boss', `?employee=${users.ravi!.employeeId}`)
    const actions = res.body.data.map((r: { action: string }) => r.action)
    expect(actions).toEqual(expect.arrayContaining(['employee.updated', 'auth.login_succeeded', 'auth.login_failed', 'payroll.entry_set', 'document.downloaded', 'user.role_changed']))
    // Hema's change is not about Ravi.
    expect(res.body.data.some((r: { summary: string }) => r.summary.includes('Hema'))).toBe(false)
  })

  it('refuses a range that ends before it starts, and a person who does not exist', async () => {
    expect((await get('boss', '?from=2026-03-02&to=2026-03-01')).status).toBe(422)
    expect((await get('boss', '?employee=00000000-0000-4000-8000-000000000099')).status).toBe(404)
    expect((await get('boss', '?category=nonsense')).status).toBe(422)
    expect((await get('boss', '?from=yesterday')).status).toBe(422)
  })
})

describe('export', () => {
  it('gives a CSV in words, and records that it was taken', async () => {
    const res = await request(app).get('/api/audit-log/export?from=2026-02-01&to=2026-02-01').set('Authorization', as('boss'))
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('text/csv')
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="audit-log-\d{4}-\d{2}-\d{2}\.csv"$/)
    const csv = res.text.replace(/^﻿/, '')
    const lines = csv.trim().split('\r\n')
    expect(lines[0]).toBe('When,Who,Their role,Area,Action,What happened,IP address,Device,Reference')
    expect(lines.length).toBe(5)
    // Company time, sortable: 06:03 UTC is 11:33 in Kolkata.
    expect(lines[1]).toMatch(/^2026-02-01 11:33:00,Nobody signed in,,Sign-ins and sessions,Sign-in refused,Sign-in to Ravi Patil refused: wrong password,10\.1\.2\.3,Chrome on Windows,/)

    const taken = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'audit.exported' }, orderBy: { createdAt: 'desc' } })
    expect(taken?.actorUserId).toBe(users.boss!.userId)
    expect(taken?.details).toMatchObject({ rows: 4, filters: { from: '2026-02-01', to: '2026-02-01' } })
  })
})

describe('signing out', () => {
  it('is recorded once — a second sign-out with the same token is not a second event', async () => {
    const before = await prisma.auditLog.count({ where: { organizationId: orgId, action: 'auth.logged_out', actorUserId: users.ravi!.userId } })
    const out = () => request(app).post('/api/auth/logout').set('Cookie', users.ravi!.cookie).set('X-Requested-With', 'ems').set('Content-Type', 'application/json').send({})
    expect((await out()).status).toBe(204)
    expect((await out()).status).toBe(204)
    const after = await prisma.auditLog.count({ where: { organizationId: orgId, action: 'auth.logged_out', actorUserId: users.ravi!.userId } })
    expect(after - before).toBe(1)
  })
})
