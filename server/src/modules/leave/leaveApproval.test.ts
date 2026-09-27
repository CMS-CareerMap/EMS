import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { zonedToday, fromDateColumn, toDateColumn } from '../../domain/shared/dates'

/**
 * Deciding on leave, and the dashboard that shows the result.
 *
 * The balance moves HERE, not when somebody applies. So the thing to be sure of
 * is that the status change and the ledger entry are one transaction: a request
 * that says approved while the balance still shows the days available is worse
 * than either failure on its own, because both screens look correct.
 */

const PREFIX = 'apprtest'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
let clId = ''
let aliceId = ''
let strangerId = ''
let managerEmpId = ''
const tokens: Record<string, string> = {}

/** A Monday at least two weeks out, so nothing here rots. */
function nextMonday(): Date {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + 14)
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1)
  return date
}

const MONDAY = nextMonday()

function D(offset: number): string {
  const date = new Date(MONDAY)
  date.setUTCDate(date.getUTCDate() + offset)
  return fromDateColumn(date)
}

const YEAR = Number(D(0).slice(0, 4)) - (Number(D(0).slice(5, 7)) >= 4 ? 0 : 1)

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(
  key: string,
  role: 'hr' | 'manager' | 'employee',
  options: { reportsTo?: string } = {},
): Promise<string> {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  const employee = await prisma.employee.create({
    data: {
      organizationId: orgId,
      membershipId: membership.id,
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key} person`,
      reportingManagerId: options.reportsTo ?? null,
    },
  })

  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
  return employee.id
}

const as = (key: string) => `Bearer ${tokens[key]}`

async function grant(employeeId: string, days: number) {
  await prisma.leaveLedgerEntry.create({
    data: {
      organizationId: orgId,
      employeeId,
      leaveTypeId: clId,
      leaveYear: YEAR,
      days,
      reason: 'opening_grant',
    },
  })
}

/** Applies as the given person and returns the created request id. */
async function applyAs(key: string, from = D(0), to = D(2)): Promise<string> {
  const res = await request(app)
    .post('/api/leave-requests')
    .set('Authorization', as(key))
    .send({ leaveTypeId: clId, fromDate: from, toDate: to, reason: 'Testing' })

  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return res.body.data.id
}

const decide = (action: string, id: string, key: string, note?: string) =>
  request(app)
    .post(`/api/leave-requests/${id}/${action}`)
    .set('Authorization', as(key))
    .send(note ? { note } : {})

beforeAll(async () => {
  await cleanup()

  const org = await prisma.organization.create({
    data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' },
  })
  orgId = org.id

  await prisma.organizationPolicy.create({
    data: {
      organizationId: orgId,
      effectiveFrom: new Date(Date.UTC(2020, 3, 1)),
      leaveYearStartMonth: 4,
      weeklyOffDays: [0],
    },
  })

  const cl = await prisma.leaveType.create({
    data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 },
  })
  clId = cl.id

  await makeUser('hr', 'hr')
  managerEmpId = await makeUser('mgr', 'manager')
  aliceId = await makeUser('alice', 'employee', { reportsTo: managerEmpId })
  strangerId = await makeUser('stranger', 'employee')
})

beforeEach(async () => {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('approving', () => {
  it('moves the balance, in the same breath as the status', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    const res = await decide('approve', id, 'mgr', 'Fine by me')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('approved')
    expect(res.body.data.review_note).toBe('Fine by me')

    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { employeeId: aliceId, reason: 'consumed' },
    })

    expect(entries).toHaveLength(1)
    // NEGATIVE. The balance is the sum of these rows, so consuming leave is an
    // entry that subtracts — never an edit to a number somewhere else.
    expect(Number(entries[0]!.days)).toBe(-3)
    expect(entries[0]!.leaveRequestId).toBe(id)
  })

  it('shows the days gone from the balance afterwards', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await decide('approve', id, 'mgr')

    const balances = await request(app)
      .get('/api/leave-requests/balances')
      .set('Authorization', as('alice'))

    const cl = balances.body.data.balances.find((b: { code: string }) => b.code === 'CL')

    expect(cl.balance).toBe(9)
    // Nothing held any more — it has been spent.
    expect(cl.pending).toBe(0)
    expect(cl.available).toBe(9)
  })

  it('writes attendance for the days taken', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await decide('approve', id, 'mgr')

    const rows = await prisma.attendance.findMany({
      where: { employeeId: aliceId },
      orderBy: { date: 'asc' },
    })

    // Without these, a week of approved leave is a GAP in the attendance table,
    // and every report has to guess whether a gap means leave, a holiday, or
    // somebody who never punched.
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.status === 'on_leave')).toBe(true)
    expect(rows.every((r) => r.source === 'leave')).toBe(true)
  })

  it('does NOT overwrite a day somebody actually worked', async () => {
    await grant(aliceId, 12)

    // A real punch on the Monday, before the leave is approved.
    await prisma.attendance.create({
      data: {
        organizationId: orgId,
        employeeId: aliceId,
        date: new Date(`${D(0)}T00:00:00Z`),
        status: 'present',
        source: 'punch',
        checkIn: new Date(`${D(0)}T03:30:00Z`),
        hoursWorked: 8,
      },
    })

    const id = await applyAs('alice')
    await decide('approve', id, 'mgr')

    const monday = await prisma.attendance.findFirstOrThrow({
      where: { employeeId: aliceId, date: new Date(`${D(0)}T00:00:00Z`) },
    })

    // Replacing it would destroy evidence of work they actually did. The clash
    // is logged for a human, not resolved silently.
    expect(monday.source).toBe('punch')
    expect(Number(monday.hoursWorked)).toBe(8)
  })

  it('refuses a second decision on the same request', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    await decide('approve', id, 'mgr')
    const again = await decide('approve', id, 'mgr')

    expect(again.status).toBe(409)
    // And the days came off exactly once.
    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { employeeId: aliceId, reason: 'consumed' },
    })
    expect(entries).toHaveLength(1)
  })
})

describe('who may decide', () => {
  it('refuses a manager deciding on their own leave', async () => {
    await grant(managerEmpId, 12)
    const id = await applyAs('mgr')

    const res = await decide('approve', id, 'mgr')

    // Otherwise the manager is the only person in the company whose leave
    // nobody reviews — and it looks like ordinary work in the log.
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/your own leave/i)
  })

  it('answers 404 — not 403 — for somebody outside the team', async () => {
    await grant(strangerId, 12)
    const id = await applyAs('stranger')

    const res = await decide('approve', id, 'mgr')

    // The request exists. A 403 would confirm that, and confirming which ids
    // are real is the same leak the employee endpoints avoid.
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('lets HR decide on anybody', async () => {
    await grant(strangerId, 12)
    const id = await applyAs('stranger')

    expect((await decide('approve', id, 'hr')).status).toBe(200)
  })

  it('refuses an employee approving anything', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    expect((await decide('approve', id, 'alice')).status).toBe(403)
  })
})

describe('rejecting', () => {
  it('takes no days and releases the hold', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    const res = await decide('reject', id, 'mgr', 'Too many people out that week')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('rejected')
    expect(res.body.data.review_note).toMatch(/Too many people/)

    // A rejected request never took any days, so there is nothing to record.
    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { employeeId: aliceId, reason: 'consumed' },
    })
    expect(entries).toHaveLength(0)

    const balances = await request(app)
      .get('/api/leave-requests/balances')
      .set('Authorization', as('alice'))
    const cl = balances.body.data.balances.find((b: { code: string }) => b.code === 'CL')

    expect(cl.balance).toBe(12)
    expect(cl.pending).toBe(0)
    expect(cl.available).toBe(12)
  })

  it('writes no attendance', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await decide('reject', id, 'mgr')

    expect(await prisma.attendance.count({ where: { employeeId: aliceId } })).toBe(0)
  })
})

describe('reversing an approval', () => {
  it('gives the days back through a new entry, not by deleting the old one', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await decide('approve', id, 'mgr')

    const res = await decide('reverse', id, 'mgr', 'Project deadline moved')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')

    const entries = await prisma.leaveLedgerEntry.findMany({
      where: { employeeId: aliceId },
      orderBy: { createdAt: 'asc' },
    })

    // Grant, consumed, reversal — all three still there. Deleting the consumed
    // entry would leave a balance that is right and a history that cannot
    // explain it.
    expect(entries.map((e) => e.reason)).toEqual(['opening_grant', 'consumed', 'reversal'])
    expect(Number(entries[2]!.days)).toBe(3)

    const balances = await request(app)
      .get('/api/leave-requests/balances')
      .set('Authorization', as('alice'))
    expect(
      balances.body.data.balances.find((b: { code: string }) => b.code === 'CL').balance,
    ).toBe(12)
  })

  it('removes the leave attendance rows it created', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await decide('approve', id, 'mgr')
    expect(await prisma.attendance.count({ where: { employeeId: aliceId } })).toBe(3)

    await decide('reverse', id, 'mgr')
    expect(await prisma.attendance.count({ where: { employeeId: aliceId } })).toBe(0)
  })

  it('leaves a real punch alone when reversing', async () => {
    await grant(aliceId, 12)
    await prisma.attendance.create({
      data: {
        organizationId: orgId,
        employeeId: aliceId,
        date: new Date(`${D(0)}T00:00:00Z`),
        status: 'present',
        source: 'punch',
        hoursWorked: 8,
      },
    })

    const id = await applyAs('alice')
    await decide('approve', id, 'mgr')
    await decide('reverse', id, 'mgr')

    const remaining = await prisma.attendance.findMany({ where: { employeeId: aliceId } })

    // Only the rows this approval created were ours to remove.
    expect(remaining).toHaveLength(1)
    expect(remaining[0]!.source).toBe('punch')
  })

  it('refuses to reverse something that was never approved', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    const res = await decide('reverse', id, 'mgr')
    expect(res.status).toBe(409)
  })
})

/**
 * Two decisions on one request, arriving together — two approvers, or one
 * double click. Each used to read the status first and write after, so both
 * could pass the check and both take the days.
 */
describe('decisions arriving together', () => {
  const consumed = () => prisma.leaveLedgerEntry.count({ where: { employeeId: aliceId, reason: 'consumed' } })

  it('takes the days once when two approvals race', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    const results = await Promise.all([decide('approve', id, 'mgr'), decide('approve', id, 'hr')])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await consumed()).toBe(1)
  })

  it('keeps the status and the ledger in agreement when an approval and a rejection race', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    const results = await Promise.all([decide('approve', id, 'mgr'), decide('reject', id, 'hr')])
    expect(results.map((r) => r.status).sort()).toEqual([200, 409])

    // Whichever won, the record tells one story: approved with the days taken,
    // or rejected with none — never "rejected" with the days gone.
    const request = await prisma.leaveRequest.findUniqueOrThrow({ where: { id } })
    expect(await consumed()).toBe(request.status === 'approved' ? 1 : 0)
  })

  it('gives the days back once when two reversals race', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    expect((await decide('approve', id, 'mgr')).status).toBe(200)

    const results = await Promise.all([decide('reverse', id, 'mgr'), decide('reverse', id, 'hr')])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await prisma.leaveLedgerEntry.count({ where: { employeeId: aliceId, reason: 'reversal' } })).toBe(1)
  })
})

describe('the dashboard, and the numbers it used to invent', () => {
  it('reports a real zero balance rather than a comfortable twelve', async () => {
    // Alice has NO ledger entries at all — exactly the state every employee
    // imported from the CSV starts in.
    const res = await request(app)
      .get('/api/dashboard/me')
      .set('Authorization', as('alice'))

    expect(res.status).toBe(200)

    const cl = res.body.data.leave_balances.find((b: { code: string }) => b.code === 'CL')

    // The old dashboard fell back to `?? 12` here. Somebody with no
    // entitlement saw twelve days, applied for them, and was refused by the
    // same system that had just offered them.
    expect(cl.remaining_days).toBe(0)
    expect(cl.balance).toBe(0)
  })

  it('reports the balance once it exists', async () => {
    await grant(aliceId, 12)

    const res = await request(app)
      .get('/api/dashboard/me')
      .set('Authorization', as('alice'))

    const cl = res.body.data.leave_balances.find((b: { code: string }) => b.code === 'CL')
    expect(cl.remaining_days).toBe(12)
  })

  it('gives an employee their own month, with hours', async () => {
    // The COMPANY'S today, not UTC's. The organization is Asia/Kolkata, so
    // between midnight and 05:30 IST the UTC date is still yesterday — a test
    // that writes attendance for the UTC day passes all afternoon and fails
    // overnight. This is the exact mistake `zonedToday` exists to stop, and
    // the test had made it.
    const today = zonedToday(new Date(), 'Asia/Kolkata')
    await prisma.attendance.create({
      data: {
        organizationId: orgId,
        employeeId: aliceId,
        date: new Date(`${today}T00:00:00Z`),
        status: 'present',
        source: 'punch',
        hoursWorked: 8.5,
      },
    })

    const res = await request(app)
      .get('/api/dashboard/me')
      .set('Authorization', as('alice'))

    expect(res.body.data.this_month.present_days).toBe(1)
    expect(res.body.data.this_month.total_hours).toBe(8.5)
    expect(res.body.data.today.status).toBe('present')
  })

  it('keeps not-marked separate from absent on the company view', async () => {
    // A fixed working day. On a Sunday — this company's weekly off — nobody is
    // expected in, so "not marked" is rightly zero, and this test used to fail
    // every Sunday for that reason alone.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-23T05:00:00Z')) // Wednesday, 10:30 in India
    let res
    try {
      res = await request(app).get('/api/dashboard/summary').set('Authorization', as('hr'))
    } finally {
      vi.useRealTimers()
    }

    expect(res.status).toBe(200)
    expect(res.body.data.absent_today).toBe(0)
    // Four employees, nobody marked. The old dashboard called that four
    // absences every morning.
    expect(res.body.data.not_marked_today).toBe(4)
  })

  it('expects nobody on the weekly off', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-09-27T05:00:00Z')) // Sunday
    let res
    try {
      res = await request(app).get('/api/dashboard/summary').set('Authorization', as('hr'))
    } finally {
      vi.useRealTimers()
    }

    expect(res.body.data.is_weekly_off_today).toBe(true)
    expect(res.body.data.not_marked_today).toBe(0)
    expect(res.body.data.absent_today).toBe(0)
  })

  it("counts a manager's week for the team only", async () => {
    // Monday of a fixed week: one present row inside the team, one outside it.
    const monday = new Date(Date.UTC(2026, 8, 21))
    await prisma.attendance.createMany({
      data: [
        { organizationId: orgId, employeeId: aliceId, date: monday, status: 'present', source: 'manual' },
        { organizationId: orgId, employeeId: strangerId, date: monday, status: 'present', source: 'manual' },
      ],
    })

    const summaryAs = async (key: string) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-09-23T05:00:00Z')) // the Wednesday of that week
      try {
        return (await request(app).get('/api/dashboard/summary').set('Authorization', as(key))).body.data
      } finally {
        vi.useRealTimers()
      }
    }
    const presentOnMonday = (data: { this_week: { date: string; present: number }[] }) =>
      data.this_week.find((d) => d.date === '2026-09-21')?.present

    // The stranger is not in the manager's team. The week used to count them anyway.
    expect(presentOnMonday(await summaryAs('mgr'))).toBe(1)
    expect(presentOnMonday(await summaryAs('hr'))).toBe(2)
  })

  it('shows Admin none of the company attendance', async () => {
    // The matrix keeps Admin out of attendance: their scope is their own, and
    // this Admin has no employee record at all. They used to see the company's.
    const email = `${PREFIX}-admin@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: 'admin', status: 'active' } })
    const login = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })

    const today = toDateColumn(zonedToday(new Date(), 'Asia/Kolkata'))
    await prisma.attendance.create({
      data: { organizationId: orgId, employeeId: aliceId, date: today, status: 'present', source: 'manual' },
    })

    const res = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', `Bearer ${login.body.data.accessToken}`)

    expect(res.status).toBe(200)
    expect(res.body.data.total_employees).toBe(0)
    expect(res.body.data.present_today).toBe(0)
    expect(res.body.data.this_week.every((d: { present: number }) => d.present === 0)).toBe(true)
  })

  it('narrows the company view to a manager team', async () => {
    const res = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', as('mgr'))

    // The manager and one direct report — not the whole company.
    expect(res.body.data.total_employees).toBe(2)
  })

  it('shows pending approvals to whoever can act on them', async () => {
    await grant(aliceId, 12)
    await applyAs('alice')

    const forManager = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', as('mgr'))
    expect(forManager.body.data.pending_leave_count).toBe(1)

    await grant(strangerId, 12)
    await applyAs('stranger')

    const stillOne = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', as('mgr'))
    // The stranger's request is not theirs to see or decide.
    expect(stillOne.body.data.pending_leave_count).toBe(1)
  })

  it('refuses an ordinary employee the company view', async () => {
    const res = await request(app)
      .get('/api/dashboard/summary')
      .set('Authorization', as('alice'))

    expect(res.status).toBe(403)
  })
})
