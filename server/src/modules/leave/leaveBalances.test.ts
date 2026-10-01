import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { fromDateColumn, toDateColumn, zonedToday } from '../../domain/shared/dates'

/**
 * Leave → Team Balances: HR grants the leave year from the app, corrects a
 * balance with a reason, and a manager sees their own team. A new company's
 * first week depends on this — without a grant nobody can apply for a day.
 */

const PREFIX = 'lbaltest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

const today = zonedToday(new Date(), 'Asia/Kolkata')
const YEAR = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)

let orgId = ''
let clId = ''
let elId = ''
const tokens: Record<string, string> = {}
const emp: Record<string, string> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function person(key: string, options: { role?: 'super_admin' | 'hr' | 'manager' | 'employee' | 'accounts'; joined?: string | null; left?: string; reportsTo?: string; inactive?: boolean } = {}) {
  let membershipId: string | null = null
  if (options.role) {
    const email = `${PREFIX}-${key}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    membershipId = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: options.role, status: 'active' } })).id
  }
  const e = await prisma.employee.create({
    data: {
      organizationId: orgId,
      membershipId,
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key[0]!.toUpperCase()}${key.slice(1)} Test`,
      dateOfJoining: options.joined === null ? null : toDateColumn(options.joined ?? '2020-01-06'),
      lastWorkingDate: options.left ? toDateColumn(options.left) : null,
      reportingManagerId: options.reportsTo ?? null,
      status: options.inactive ? 'inactive' : 'active',
    },
  })
  emp[key] = e.id
  if (options.role) {
    const res = await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-${key}@example.com`, password: PASSWORD })
    tokens[key] = res.body.data.accessToken
  }
  return e.id
}

const as = (key: string) => `Bearer ${tokens[key]}`
const list = (key: string, query = '') => request(app).get(`/api/leave-balances${query}`).set('Authorization', as(key))
const grant = (key: string, body: object = {}) => request(app).post('/api/leave-balances/grant').set('Authorization', as(key)).send(body)
const adjust = (key: string, body: object) => request(app).post('/api/leave-balances/adjustments').set('Authorization', as(key)).send(body)
const ledger = (employeeId: string, leaveTypeId: string) =>
  prisma.leaveLedgerEntry.aggregate({ where: { employeeId, leaveTypeId, leaveYear: YEAR }, _sum: { days: true } }).then((r) => Number(r._sum.days ?? 0))

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  clId = (await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })).id
  elId = (await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Earned Leave', code: 'EL', annualQuota: 18, carryForward: true, carryForwardCap: 10 } })).id
  await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Work From Home', code: 'WFH', annualQuota: 0 } })

  await person('boss', { role: 'super_admin' })
  await person('hema', { role: 'hr' })
  const manoj = await person('manoj', { role: 'manager' })
  await person('priya', { role: 'employee', reportsTo: manoj })
  await person('anil', { role: 'accounts' })
  // Joined this leave year in October: six months of twelve.
  await person('neha', { joined: `${YEAR}-10-14` })
  // Left before this leave year began: nothing for it.
  await person('kiran', { left: `${YEAR}-03-31` })
  // Marked inactive, no last day recorded: gone too.
  await person('lata', { inactive: true })

  // Priya had 12 days of Earned Leave left last year; 10 carry in.
  await prisma.leaveLedgerEntry.createMany({
    data: [
      { organizationId: orgId, employeeId: emp.priya!, leaveTypeId: elId, leaveYear: YEAR - 1, days: 18, reason: 'opening_grant' },
      { organizationId: orgId, employeeId: emp.priya!, leaveTypeId: elId, leaveYear: YEAR - 1, days: -6, reason: 'consumed' },
    ],
  })
})

afterAll(cleanup)

describe('who may see and change balances', () => {
  it('lets HR and the Super Admin see everybody, a manager only their team, and nobody else at all', async () => {
    const hr = await list('hema')
    expect(hr.status).toBe(200)
    expect(hr.body.data.people.map((p: { full_name: string }) => p.full_name)).toEqual(
      expect.arrayContaining(['Boss Test', 'Hema Test', 'Manoj Test', 'Priya Test', 'Anil Test', 'Neha Test']),
    )
    // Kiran and Lata are still on the books (not archived) and still listed; they just get no grant.
    expect(hr.body.data.people).toHaveLength(8)

    const mgr = await list('manoj')
    expect(mgr.status).toBe(200)
    expect(mgr.body.data.people.map((p: { full_name: string }) => p.full_name).sort()).toEqual(['Manoj Test', 'Priya Test'])
    // A manager is not told what a grant would do — it is not theirs to do.
    expect(mgr.body.data.waiting).toBeNull()

    expect((await list('priya')).status).toBe(403)
    expect((await list('anil')).status).toBe(403)
  })

  it('lets only HR and the Super Admin grant or correct', async () => {
    expect((await grant('manoj')).status).toBe(403)
    expect((await grant('priya')).status).toBe(403)
    expect((await grant('anil')).status).toBe(403)
    expect((await request(app).get('/api/leave-balances/grant-preview').set('Authorization', as('manoj'))).status).toBe(403)
    expect((await adjust('manoj', { employeeId: emp.priya, leaveTypeId: clId, days: 1, note: 'Try' })).status).toBe(403)
  })
})

describe('granting the leave year', () => {
  it('shows what is waiting, and what a grant would do, named, before anybody presses it', async () => {
    const before = await list('hema')
    // Everybody but Kiran: six people, each with CL and EL.
    expect(before.body.data.waiting.people).toBe(6)
    expect(before.body.data.people.every((p: { balances: { available: number }[] }) => p.balances.every((b) => b.available === 0))).toBe(true)

    const preview = await request(app).get('/api/leave-balances/grant-preview').set('Authorization', as('hema'))
    expect(preview.status).toBe(200)
    expect(preview.body.data.people).toBe(6)
    expect(preview.body.data.pro_rated).toEqual(expect.arrayContaining([
      expect.objectContaining({ full_name: 'Neha Test', leave_type: 'Casual Leave', days: 6 }),
      expect.objectContaining({ full_name: 'Neha Test', leave_type: 'Earned Leave', days: 9 }),
    ]))
    expect(preview.body.data.carried).toEqual([expect.objectContaining({ full_name: 'Priya Test', leave_type: 'Earned Leave', days: 10 })])
    // Nobody here lacks a joining date yet.
    expect(preview.body.data.no_joining_date).toEqual([])
    expect(preview.body.data.carry_later).toBe(false)
  })

  it('grants the year to everybody, by the rules, and records it', async () => {
    const res = await grant('hema')
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ leave_year: YEAR, people: 6 })

    expect(await ledger(emp.priya!, clId)).toBe(12)
    expect(await ledger(emp.priya!, elId)).toBe(28) // 18 + 10 carried
    // …and the same 10 days leave last year, so a late application there cannot spend them again.
    const lastYear = await prisma.leaveLedgerEntry.aggregate({ where: { employeeId: emp.priya!, leaveTypeId: elId, leaveYear: YEAR - 1 }, _sum: { days: true } })
    expect(Number(lastYear._sum.days)).toBe(2) // 18 − 6 taken − 10 carried out
    expect(await ledger(emp.neha!, clId)).toBe(6)
    expect(await ledger(emp.kiran!, clId)).toBe(0)
    expect(await ledger(emp.lata!, clId)).toBe(0)

    const row = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'leave.granted' } })
    expect(row?.actorUserId).toBeTruthy()
    expect(row?.details).toMatchObject({ leaveYear: YEAR, people: 6 })
    const told = await prisma.notification.count({ where: { organizationId: orgId, event: 'leave.balance_changed' } })
    expect(told).toBeGreaterThanOrEqual(4) // everybody with a login who was granted, bar HR herself
  })

  it('grants nothing twice — and a second press reaches only people added since', async () => {
    const again = await grant('hema')
    expect(again.status).toBe(409)
    expect(again.body.error.message).toMatch(/already has/)

    await person('ravi', { joined: '2024-01-01' })
    const waiting = (await list('hema')).body.data.waiting
    expect(waiting.people).toBe(1)
    expect((await grant('hema')).status).toBe(201)
    expect(await ledger(emp.ravi!, clId)).toBe(12)
    expect(await ledger(emp.priya!, clId)).toBe(12)
  })

  it('names anybody with no joining date before granting them a full year', async () => {
    await person('dev', { joined: null })
    const preview = await request(app).get('/api/leave-balances/grant-preview').set('Authorization', as('hema'))
    expect(preview.body.data.no_joining_date).toEqual([expect.objectContaining({ full_name: 'Dev Test' })])
    expect((await grant('hema')).status).toBe(201)
  })

  it('grants next year in advance with no carry — that comes when the year begins', async () => {
    const preview = await request(app).get(`/api/leave-balances/grant-preview?year=${YEAR + 1}`).set('Authorization', as('hema'))
    expect(preview.body.data.carry_later).toBe(true)
    expect(preview.body.data.carried).toEqual([])
    const res = await grant('hema', { leaveYear: YEAR + 1 })
    expect(res.status).toBe(201)
    const next = await prisma.leaveLedgerEntry.aggregate({ where: { employeeId: emp.priya!, leaveTypeId: elId, leaveYear: YEAR + 1 }, _sum: { days: true } })
    expect(Number(next._sum.days)).toBe(18)
    const notice = await prisma.notification.findFirst({ where: { organizationId: orgId, title: { contains: `${YEAR + 1}` } }, orderBy: { createdAt: 'desc' } })
    expect(notice?.message).toMatch(/when the .* leave year begins on 1 Apr/)
  })

  it('grants once even when two people press the button at the same moment', async () => {
    await person('sana', { joined: '2024-01-01' })
    const [a, b] = await Promise.all([grant('hema'), grant('boss')])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(await ledger(emp.sana!, clId)).toBe(12)
  })

  it('lets an employee apply once the year is granted', async () => {
    const monday = new Date()
    monday.setUTCHours(0, 0, 0, 0)
    monday.setUTCDate(monday.getUTCDate() + 21)
    while (monday.getUTCDay() !== 1) monday.setUTCDate(monday.getUTCDate() + 1)
    const day = fromDateColumn(monday)
    const res = await request(app).post('/api/leave-requests').set('Authorization', as('priya')).send({ leaveTypeId: clId, fromDate: day, toDate: day, reason: 'First day off' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
  })

  it('looks only at this leave year and the next', async () => {
    expect((await list('hema', `?year=${YEAR + 1}`)).status).toBe(200)
    expect((await list('hema', `?year=${YEAR + 2}`)).status).toBe(422)
    expect((await list('hema', `?year=${YEAR - 1}`)).status).toBe(422)
  })
})

describe('correcting a balance', () => {
  it('adds days with a reason, records who and why, and tells the employee', async () => {
    const res = await adjust('hema', { employeeId: emp.priya, leaveTypeId: clId, days: 1.5, note: 'Worked on the Diwali weekend' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.balance).toBe(13.5)
    const entry = await prisma.leaveLedgerEntry.findFirst({ where: { employeeId: emp.priya, reason: 'adjustment' } })
    expect(entry?.note).toBe('Worked on the Diwali weekend')
    const row = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'leave.balance_adjusted' } })
    expect(row?.details).toMatchObject({ employeeId: emp.priya, days: 1.5, balanceAfter: 13.5, note: 'Worked on the Diwali weekend' })
    const notice = await prisma.notification.findFirst({ where: { organizationId: orgId, event: 'leave.balance_changed', title: { contains: '1.5 days of Casual Leave added' } } })
    expect(notice?.message).toContain('now 13.5 days')
  })

  it('never takes away days already applied for', async () => {
    // Priya has 13.5 CL with 1 day pending: at most 12.5 can go.
    const tooMany = await adjust('hema', { employeeId: emp.priya, leaveTypeId: clId, days: -13, note: 'Correction' })
    expect(tooMany.status).toBe(409)
    expect(tooMany.body.error.message).toMatch(/already applied for.*At most 12\.5/)
    expect((await adjust('hema', { employeeId: emp.priya, leaveTypeId: clId, days: -2, note: 'Granted twice by mistake' })).status).toBe(201)
    expect(await ledger(emp.priya!, clId)).toBe(11.5)
  })

  it('refuses a correction to one’s own balance, one with no reason, and anything but whole or half days', async () => {
    const own = await adjust('hema', { employeeId: emp.hema, leaveTypeId: clId, days: 5, note: 'For me' })
    expect(own.status).toBe(403)
    expect((await adjust('hema', { employeeId: emp.priya, leaveTypeId: clId, days: 1, note: '' })).status).toBe(422)
    expect((await adjust('hema', { employeeId: emp.priya, leaveTypeId: clId, days: 0.3, note: 'Odd amount' })).status).toBe(422)
    expect((await adjust('hema', { employeeId: emp.priya, leaveTypeId: clId, days: 0, note: 'Nothing' })).status).toBe(422)
    expect((await adjust('hema', { employeeId: '00000000-0000-4000-8000-000000000001', leaveTypeId: clId, days: 1, note: 'Nobody' })).status).toBe(404)
  })

  it('shows the corrected balance, and what is left after days applied for', async () => {
    const priya = (await list('hema')).body.data.people.find((p: { full_name: string }) => p.full_name === 'Priya Test')
    const cl = priya.balances.find((b: { leave_type_id: string }) => b.leave_type_id === clId)
    expect(cl).toEqual({ leave_type_id: clId, balance: 11.5, pending: 1, available: 10.5 })
  })
})
