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
let bossId = ''
let acHeadId = ''
let accountantId = ''
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
  role: 'hr' | 'manager' | 'employee' | 'super_admin' | 'accounts',
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
      memberships: { connect: { id: membership.id } },
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
  bossId = await makeUser('boss', 'super_admin')
  managerEmpId = await makeUser('mgr', 'manager')
  aliceId = await makeUser('alice', 'employee', { reportsTo: managerEmpId })
  strangerId = await makeUser('stranger', 'employee')
  // An Accounts head with an accountant under them: no leave right in the role at all.
  acHeadId = await makeUser('achead', 'accounts')
  accountantId = await makeUser('accountant', 'employee', { reportsTo: acHeadId })
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

  it('refuses reversing one’s own approved leave, which would hand the days back to oneself', async () => {
    await grant(managerEmpId, 12)
    const id = await applyAs('mgr', D(7), D(8))
    // The manager has nobody above them, so the Super Admin decides.
    expect((await decide('approve', id, 'boss')).status).toBe(200)

    const res = await decide('reverse', id, 'mgr')
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/your own leave/i)
    // Somebody else still may.
    expect((await decide('reverse', id, 'boss')).status).toBe(200)
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

  it('gives HR no decision — HR sees every request and is told who decides it (Day 22)', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    const refused = await decide('approve', id, 'hr')
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toBe('alice person\'s leave is decided by mgr person, the person they report to in the company tree.')
    const seen = await request(app).get('/api/leave-requests?status=pending').set('Authorization', as('hr'))
    const row = (seen.body.data as { id: string; can_decide: boolean; decided_by: string }[]).find((r) => r.id === id)
    expect(row).toMatchObject({ can_decide: false, decided_by: 'mgr person' })
  })

  it('sends somebody with nobody above them to the Super Admin', async () => {
    await grant(strangerId, 12)
    const id = await applyAs('stranger')
    expect((await decide('approve', id, 'boss')).status).toBe(200)
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

    // The manager, and the Super Admin standing in as the backup.
    const results = await Promise.all([decide('approve', id, 'mgr'), decide('approve', id, 'boss')])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await consumed()).toBe(1)
  })

  it('keeps the status and the ledger in agreement when an approval and a rejection race', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')

    const results = await Promise.all([decide('approve', id, 'mgr'), decide('reject', id, 'boss')])
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

    const results = await Promise.all([decide('reverse', id, 'mgr'), decide('reverse', id, 'boss')])

    expect(results.map((r) => r.status).sort()).toEqual([200, 409])
    expect(await prisma.leaveLedgerEntry.count({ where: { employeeId: aliceId, reason: 'reversal' } })).toBe(1)
  })
})

describe('the company tree decides (Day 22)', () => {
  const rules = (data: Record<string, unknown>) => prisma.organization.update({ where: { id: orgId }, data })
  const audited = (id: string) => prisma.auditLog.findFirst({ where: { entityId: id, action: { in: ['leave.approved', 'leave.recorded_directly', 'leave.rejected'] } }, orderBy: { createdAt: 'desc' } })

  it('lets an Accounts head, whose role has no leave right, decide the accountant’s leave from Team requests', async () => {
    await grant(accountantId, 12)
    const id = await applyAs('accountant')
    const team = await request(app).get('/api/leave-requests/team?status=pending').set('Authorization', as('achead'))
    expect(team.status).toBe(200)
    expect(team.body.meta.decides_for).toBe(1)
    expect(team.body.data.requests.map((r: { id: string }) => r.id)).toEqual([id])
    expect(team.body.data.requests[0]).toMatchObject({ can_decide: true, as_backup: false })
    const res = await decide('approve', id, 'achead')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.status).toBe('approved')
  })

  it('follows a person to their new manager, and drops the old one', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await prisma.employee.update({ where: { id: aliceId }, data: { reportingManagerId: acHeadId } })
    try {
      // The old manager no longer has her in their team: not found to them.
      expect((await decide('approve', id, 'mgr')).status).toBe(404)
      expect((await decide('approve', id, 'achead')).status).toBe(200)
    } finally {
      await prisma.employee.update({ where: { id: aliceId }, data: { reportingManagerId: managerEmpId } })
    }
  })

  it('sends the team of a manager who has left to the Super Admin', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await prisma.employee.update({ where: { id: managerEmpId }, data: { archivedAt: new Date() } })
    try {
      const team = await request(app).get('/api/leave-requests/team?status=pending').set('Authorization', as('boss'))
      const row = (team.body.data.requests as { id: string; as_backup: boolean }[]).find((r) => r.id === id)
      expect(row?.as_backup).toBe(false)
      expect((await decide('approve', id, 'boss')).status).toBe(200)
      expect((await audited(id))?.details).not.toHaveProperty('asBackup')
    } finally {
      await prisma.employee.update({ where: { id: managerEmpId }, data: { archivedAt: null } })
    }
  })

  it('lets the Super Admin stand in for a manager, and says so in the log', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    const team = await request(app).get('/api/leave-requests/team').set('Authorization', as('boss'))
    expect((team.body.data.backup as { id: string }[]).map((r) => r.id)).toContain(id)
    expect((await decide('reject', id, 'boss', 'Short-staffed')).status).toBe(200)
    expect((await audited(id))?.details).toMatchObject({ asBackup: true })
  })

  it('keeps the request waiting for the manager when Settings → Approvals says nobody stands in', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    await rules({ leaveBackup: 'none' })
    try {
      const res = await decide('approve', id, 'boss')
      expect(res.status).toBe(403)
      expect(res.body.error.message).toMatch(/decided by mgr person/)
      expect((await decide('approve', id, 'mgr')).status).toBe(200)
    } finally {
      await rules({ leaveBackup: 'super_admin' })
    }
  })

  it('lets only the Super Admin cancel approved leave when Settings → Approvals says so', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    expect((await decide('approve', id, 'mgr')).status).toBe(200)
    await rules({ leaveReversal: 'super_admin_only' })
    try {
      const res = await decide('reverse', id, 'mgr')
      expect(res.status).toBe(403)
      expect(res.body.error.message).toBe('Only the Super Admin can cancel approved leave.')
      expect((await decide('reverse', id, 'boss')).status).toBe(200)
    } finally {
      await rules({ leaveReversal: 'manager_or_super_admin' })
    }
  })

  it('sends nobody-above to the person Settings → Approvals names', async () => {
    await grant(strangerId, 12)
    const id = await applyAs('stranger')
    await rules({ leaveNoManagerApproverId: acHeadId })
    try {
      expect((await decide('approve', id, 'achead')).status).toBe(200)
    } finally {
      await rules({ leaveNoManagerApproverId: null })
    }
  })

  it('records the owner’s leave directly — nobody approves it — and says so in the log', async () => {
    await grant(bossId, 12)
    await rules({ ownerEmployeeId: bossId })
    try {
      const res = await request(app)
        .post('/api/leave-requests')
        .set('Authorization', as('boss'))
        .send({ leaveTypeId: clId, fromDate: D(7), toDate: D(8), reason: 'Travel' })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      expect(res.body.data.status).toBe('approved')
      const log = await audited(res.body.data.id)
      expect(log?.action).toBe('leave.recorded_directly')
      expect(await prisma.leaveLedgerEntry.count({ where: { employeeId: bossId, reason: 'consumed' } })).toBe(1)
    } finally {
      await rules({ ownerEmployeeId: null })
    }
  })

  it('sends the team of a manager who cannot sign in to the Super Admin, rather than waiting', async () => {
    await grant(aliceId, 12)
    const id = await applyAs('alice')
    const mgr = await prisma.membership.findFirstOrThrow({ where: { employeeId: managerEmpId }, select: { id: true } })
    await prisma.membership.update({ where: { id: mgr.id }, data: { status: 'inactive' } })
    await rules({ leaveBackup: 'none' })
    try {
      // Not standing in: with the manager unable to act, it is the Super Admin's own.
      const res = await decide('approve', id, 'boss')
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect((await audited(id))?.details).not.toHaveProperty('asBackup')
    } finally {
      await prisma.membership.update({ where: { id: mgr.id }, data: { status: 'active' } })
      await rules({ leaveBackup: 'super_admin' })
    }
  })

  it('stops treating a marked owner as the owner once they no longer hold the Super Admin panel', async () => {
    await grant(bossId, 12)
    const boss = await prisma.membership.findFirstOrThrow({ where: { employeeId: bossId }, select: { id: true } })
    await rules({ ownerEmployeeId: bossId })
    await prisma.membership.update({ where: { id: boss.id }, data: { role: 'hr' } })
    try {
      const res = await request(app).post('/api/leave-requests').set('Authorization', as('boss'))
        .send({ leaveTypeId: clId, fromDate: D(14), toDate: D(14), reason: 'Travel' })
      // Not recorded directly any more — and with nobody above and no other
      // Super Admin, refused rather than left waiting for nobody.
      expect(res.status, JSON.stringify(res.body)).toBe(400)
      expect(res.body.error.message).toMatch(/Nobody could decide this request/)
    } finally {
      await prisma.membership.update({ where: { id: boss.id }, data: { role: 'super_admin' } })
      await rules({ ownerEmployeeId: null })
    }
  })

  it('refuses the only Super Admin’s own leave while no owner is marked — nobody could decide it', async () => {
    await grant(bossId, 12)
    const res = await request(app).post('/api/leave-requests').set('Authorization', as('boss'))
      .send({ leaveTypeId: clId, fromDate: D(15), toDate: D(15), reason: 'Travel' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/Mark the owner in Settings → Company tree/)
  })

  it('lets a manager file and withdraw leave for their team, and nobody else', async () => {
    await grant(aliceId, 12)
    const filed = await request(app)
      .post('/api/leave-requests')
      .set('Authorization', as('mgr'))
      .send({ employeeId: aliceId, leaveTypeId: clId, fromDate: D(0), toDate: D(1), reason: 'Called in sick' })
    expect(filed.status, JSON.stringify(filed.body)).toBe(201)
    // HR sees Alice, and may not file for her: her leave is her manager's.
    const hr = await request(app)
      .post('/api/leave-requests')
      .set('Authorization', as('hr'))
      .send({ employeeId: aliceId, leaveTypeId: clId, fromDate: D(7), toDate: D(7), reason: 'Called in sick' })
    expect(hr.status).toBe(403)
    expect((await request(app).delete(`/api/leave-requests/${filed.body.data.id}`).set('Authorization', as('mgr'))).status).toBe(200)
  })
})

describe('the home page, section by section, and the numbers it used to invent', () => {
  /** A login with the Admin role and no employee record — whose attendance reach is their own. */
  async function adminToken(): Promise<string> {
    const email = `${PREFIX}-admin@example.com`
    const existing = await prisma.user.findUnique({ where: { email } })
    if (!existing) {
      const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
      await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: 'admin', status: 'active' } })
    }
    const login = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
    return `Bearer ${login.body.data.accessToken}`
  }

  /** The API at a fixed instant — the company is in India, so 05:00 UTC is 10:30 there. */
  async function at<T>(iso: string, call: () => Promise<T>): Promise<T> {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date(iso))
    try {
      return await call()
    } finally {
      vi.useRealTimers()
    }
  }

  it('gives My Profile the employee’s own HR record — their manager included', async () => {
    await prisma.employee.update({ where: { id: aliceId }, data: { phone: '9876543210' } })
    const res = await request(app).get('/api/dashboard/me').set('Authorization', as('alice'))
    expect(res.status).toBe(200)
    expect(res.body.data.profile).toMatchObject({
      full_name: 'alice person',
      phone: '9876543210',
      reporting_manager_name: 'mgr person',
      reporting_manager_designation: null,
    })
  })

  it('reports a real zero balance rather than a comfortable twelve', async () => {
    // Alice has NO ledger entries at all — exactly the state every employee
    // imported from the CSV starts in.
    const res = await request(app).get('/api/dashboard/me').set('Authorization', as('alice'))
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
    const res = await request(app).get('/api/dashboard/me').set('Authorization', as('alice'))
    const cl = res.body.data.leave_balances.find((b: { code: string }) => b.code === 'CL')
    expect(cl.remaining_days).toBe(12)
  })

  it('gives an employee their own month and last seven days, with hours and how late', async () => {
    // The COMPANY'S today, not UTC's: between midnight and 05:30 IST the UTC
    // date is still yesterday, and a test written for the UTC day fails overnight.
    const today = zonedToday(new Date(), 'Asia/Kolkata')
    await prisma.attendance.create({
      data: { organizationId: orgId, employeeId: aliceId, date: new Date(`${today}T00:00:00Z`), status: 'present', source: 'punch', hoursWorked: 8.5, lateMinutes: 12 },
    })

    const res = await request(app).get('/api/dashboard/me').set('Authorization', as('alice'))

    expect(res.body.data.this_month.present_days).toBe(1)
    expect(res.body.data.this_month.total_hours).toBe(8.5)
    expect(res.body.data.today).toMatchObject({ status: 'present', late_minutes: 12 })
    const days = res.body.data.recent_days
    expect(days).toHaveLength(7)
    expect(days[6]).toMatchObject({ date: today, status: 'present', hours_worked: 8.5, late_minutes: 12 })
  })

  it('names the company’s days off in somebody’s last seven days, which have no rows', async () => {
    await prisma.holiday.create({ data: { organizationId: orgId, name: 'Test Holiday', date: new Date(Date.UTC(2026, 8, 22)), type: 'public' } })
    try {
      const res = await at('2026-09-23T05:00:00Z', () => request(app).get('/api/dashboard/me').set('Authorization', as('alice')))
      const byDate = Object.fromEntries(res.body.data.recent_days.map((d: { date: string }) => [d.date, d]))
      expect(Object.keys(byDate)).toEqual(['2026-09-17', '2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'])
      expect(byDate['2026-09-20']).toMatchObject({ day_off: 'weekly_off', status: null })
      expect(byDate['2026-09-22']).toMatchObject({ day_off: 'holiday', holiday: 'Test Holiday' })
      expect(byDate['2026-09-23']).toMatchObject({ day_off: null })
    } finally {
      await prisma.holiday.deleteMany({ where: { organizationId: orgId } })
    }
  })

  it('keeps not-marked separate from absent on today at work', async () => {
    // A fixed working day. On a Sunday — this company's weekly off — nobody is
    // expected in, so "not marked" is rightly zero.
    const res = await at('2026-09-23T05:00:00Z', () => request(app).get('/api/dashboard/today').set('Authorization', as('hr')))

    expect(res.status).toBe(200)
    expect(res.body.data.reach).toBe('company')
    expect(res.body.data.counts.absent).toBe(0)
    // Seven employees, nobody marked. The old dashboard called that seven
    // absences every morning.
    expect(res.body.data.counts.not_marked).toBe(7)
    expect(res.body.data.headcount).toBe(7)
    // The server's clock, which the team's time at work runs on (client, 9 Oct 2026).
    expect(res.body.data.server_now).toBe('2026-09-23T05:00:00.000Z')
  })

  it("carries the server's clock on one's own dashboard too, for today's time at work in the week", async () => {
    const res = await at('2026-09-23T05:00:00Z', () => request(app).get('/api/dashboard/me').set('Authorization', as('hr')))
    expect(res.status).toBe(200)
    expect(res.body.data.server_now).toBe('2026-09-23T05:00:00.000Z')
  })

  it('expects nobody on the weekly off', async () => {
    const res = await at('2026-09-27T05:00:00Z', () => request(app).get('/api/dashboard/today').set('Authorization', as('hr')))
    expect(res.body.data.day_off).toBe('weekly_off')
    expect(res.body.data.counts.not_marked).toBe(0)
    expect(res.body.data.counts.absent).toBe(0)
  })

  it('counts late arrivals and work away from the office today', async () => {
    const day = new Date(Date.UTC(2026, 8, 23))
    await prisma.attendance.createMany({
      data: [
        { organizationId: orgId, employeeId: aliceId, date: day, status: 'present', source: 'punch', lateMinutes: 17 },
        { organizationId: orgId, employeeId: managerEmpId, date: day, status: 'present', source: 'punch', lateMinutes: 0, workMode: 'wfh' },
      ],
    })
    const res = await at('2026-09-23T05:00:00Z', () => request(app).get('/api/dashboard/today').set('Authorization', as('mgr')))
    expect(res.body.data.counts).toMatchObject({ present: 2, late: 1, away: 1, not_marked: 0 })
    const alice = res.body.data.people.find((p: { id: string }) => p.id === aliceId)
    expect(alice).toMatchObject({ status: 'present', late_minutes: 17, is_self: false })
    expect(res.body.data.people.find((p: { id: string }) => p.id === managerEmpId).is_self).toBe(true)
  })

  it("runs a team member's time at work only for an app check-in, as the roster does (9 Oct 2026)", async () => {
    await prisma.attendance.create({
      data: { organizationId: orgId, employeeId: aliceId, date: new Date(Date.UTC(2026, 8, 23)), status: 'present', source: 'punch', checkIn: new Date('2026-09-23T04:00:00Z') },
    })
    const alice = async () => (await at('2026-09-23T05:00:00Z', () => request(app).get('/api/dashboard/today').set('Authorization', as('mgr'))))
      .body.data.people.find((p: { id: string }) => p.id === aliceId)
    expect((await alice()).at_work).toBe(true)
    // On the biometric machine she has no card counting her time: neither does her manager's list.
    const mode = (await prisma.employee.findUniqueOrThrow({ where: { id: aliceId } })).attendanceMode
    await prisma.employee.update({ where: { id: aliceId }, data: { attendanceMode: 'biometric' } })
    try {
      expect((await alice()).at_work).toBe(false)
    } finally {
      await prisma.employee.update({ where: { id: aliceId }, data: { attendanceMode: mode } })
    }
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
    const presentOnMonday = async (key: string) => {
      const res = await at('2026-09-23T05:00:00Z', () => request(app).get('/api/dashboard/today').set('Authorization', as(key)))
      return res.body.data.week.find((d: { date: string }) => d.date === '2026-09-21')?.present
    }
    // The stranger is not in the manager's team. The week used to count them anyway.
    expect(await presentOnMonday('mgr')).toBe(1)
    expect(await presentOnMonday('hr')).toBe(2)
  })

  it('narrows today to a manager team, and calls it a team', async () => {
    const res = await request(app).get('/api/dashboard/today').set('Authorization', as('mgr'))
    expect(res.body.data.reach).toBe('team')
    // The manager and one direct report — not the whole company.
    expect(res.body.data.headcount).toBe(2)
    expect(res.body.data.people.map((p: { full_name: string }) => p.full_name).sort()).toEqual(['alice person', 'mgr person'])
  })

  it('refuses today at work to a login that sees only its own attendance', async () => {
    // Admin's attendance reach is their own: the old dashboard drew them a
    // company of one — "1 employee, 0 present". An employee likewise.
    expect((await request(app).get('/api/dashboard/today').set('Authorization', await adminToken())).status).toBe(403)
    expect((await request(app).get('/api/dashboard/today').set('Authorization', as('alice'))).status).toBe(403)
  })

  it('lists who is away in the next seven days, within the reach only', async () => {
    const today = zonedToday(new Date(), 'Asia/Kolkata')
    // The next working day: run on a Saturday, tomorrow is the weekly off and no leave at all.
    const next = new Date(new Date(`${today}T00:00:00Z`).getTime() + 86_400_000)
    const tomorrow = fromDateColumn(next.getUTCDay() === 0 ? new Date(next.getTime() + 86_400_000) : next)
    await grant(aliceId, 12)
    await grant(strangerId, 12)
    await applyAs('alice', tomorrow, tomorrow)
    await applyAs('stranger', tomorrow, tomorrow)

    const names = async (key: string) => {
      const res = await request(app).get('/api/dashboard/today').set('Authorization', as(key))
      return res.body.data.away.map((a: { full_name: string; kind: string; status: string }) => `${a.full_name}:${a.kind}:${a.status}`).sort()
    }
    expect(await names('mgr')).toEqual(['alice person:leave:pending'])
    expect(await names('hr')).toEqual(['alice person:leave:pending', 'stranger person:leave:pending'])

    // A role that reads attendance but not leave sees who came in, not who is off on what leave.
    const where = { organizationId_key: { organizationId: orgId, key: 'hr' } }
    const before = await prisma.role.findUniqueOrThrow({ where })
    await prisma.role.update({ where, data: { permissions: before.permissions.filter((p) => p !== 'leave:read') } })
    try {
      const res = await request(app).get('/api/dashboard/today').set('Authorization', as('hr'))
      expect(res.status).toBe(200)
      expect(res.body.data.headcount).toBe(7)
      expect(res.body.data.away).toEqual([])
    } finally {
      await prisma.role.update({ where, data: { permissions: before.permissions } })
    }
  })

  it('counts the staff on the employee reach: Admin sees the company, not a company of one', async () => {
    const res = await request(app).get('/api/dashboard/people').set('Authorization', await adminToken())
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ total: 7, active: 7, inactive: 0 })
    expect(res.body.data.by_department).toEqual([{ department: 'Unassigned', headcount: 7 }])
  })

  it('lists as new joiners only the people who joined in the last 60 days, newest first', async () => {
    const today = zonedToday(new Date(), 'Asia/Kolkata')
    const daysAgo = (n: number) => new Date(new Date(`${today}T00:00:00Z`).getTime() - n * 86_400_000)
    await prisma.employee.update({ where: { id: aliceId }, data: { dateOfJoining: daysAgo(10) } })
    await prisma.employee.update({ where: { id: strangerId }, data: { dateOfJoining: daysAgo(100) } })
    await prisma.employee.update({ where: { id: accountantId }, data: { dateOfJoining: daysAgo(59) } })
    try {
      const res = await request(app).get('/api/dashboard/people').set('Authorization', as('hr'))
      // The old list was the first five people whatever their joining date —
      // somebody who joined in 2022 was a "recent joiner".
      expect(res.body.data.joiners.map((j: { full_name: string }) => j.full_name)).toEqual(['alice person', 'accountant person'])
    } finally {
      await prisma.employee.updateMany({ where: { id: { in: [aliceId, strangerId, accountantId] } }, data: { dateOfJoining: null } })
    }
  })

  it('refuses the people section to a login without the directory', async () => {
    expect((await request(app).get('/api/dashboard/people').set('Authorization', as('alice'))).status).toBe(403)
  })

  it('gives the payroll section to whoever reads payroll, and to nobody else', async () => {
    const res = await request(app).get('/api/dashboard/payroll').set('Authorization', as('achead'))
    expect(res.status).toBe(200)
    const today = zonedToday(new Date(), 'Asia/Kolkata')
    // No run yet: the next one is this month's.
    expect(res.body.data.latest).toBeNull()
    expect(res.body.data.next).toEqual({ year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) })
    // Nobody here has a salary account yet.
    expect(res.body.data.bank).toMatchObject({ verified: 0, waiting: 0, none: 7 })
    expect(res.body.data.loans).toEqual({ active: 0, left: 0 })

    // HR enters incentives but does not read payroll.
    expect((await request(app).get('/api/dashboard/payroll').set('Authorization', as('hr'))).status).toBe(403)
    expect((await request(app).get('/api/dashboard/payroll').set('Authorization', as('mgr'))).status).toBe(403)
  })

  it('shows waiting leave only to whoever decides it', async () => {
    await grant(aliceId, 12)
    await applyAs('alice')
    const pendingFor = async (key: string) =>
      (await request(app).get('/api/leave-requests/team').set('Authorization', as(key))).body.data.requests.filter((r: { status: string }) => r.status === 'pending').length
    expect(await pendingFor('mgr')).toBe(1)

    await grant(strangerId, 12)
    await applyAs('stranger')
    // The stranger's request is not the manager's to see or decide.
    expect(await pendingFor('mgr')).toBe(1)
  })
})
