import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { leaveYearOf } from './leave.service'
import { policySchema } from '../../http/validators/settings.validator'
import { fromDateColumn } from '../../domain/shared/dates'

/**
 * Applying for leave.
 *
 * The thing worth being careful about is the balance. It is the SUM of ledger
 * entries, and the number somebody may apply against is that sum minus what
 * they have already asked for and not yet had decided. Getting the second part
 * wrong lets one person book their whole entitlement three times and have all
 * three approved by three managers on the same afternoon.
 */

const PREFIX = 'leavetest'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
let clId = ''
let coId = ''
let aliceId = ''
let bobId = ''
let strangerId = ''
const tokens: Record<string, string> = {}

/**
 * Dates relative to a Monday at least two weeks out.
 *
 * Fixed dates rot: these tests were written with April 2026 in them and started
 * failing the day April was more than ninety days ago, because applying that
 * far back is refused on purpose. Anchoring to a known weekday keeps the
 * weekend and holiday arithmetic exact without pinning the calendar.
 */
function nextMonday(): Date {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + 14)
  // 1 is Monday.
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1)
  return date
}

const MONDAY = nextMonday()

/** D(0) is that Monday, D(1) Tuesday, and so on. */
function D(offset: number): string {
  const date = new Date(MONDAY)
  date.setUTCDate(date.getUTCDate() + offset)
  return fromDateColumn(date)
}

/** The leave year those dates fall in, with a year starting in April. */
const YEAR = Number(D(0).slice(0, 4)) - (Number(D(0).slice(5, 7)) >= 4 ? 0 : 1)

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.holiday.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(
  key: string,
  role: 'hr' | 'manager' | 'employee' | 'super_admin',
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

const preview = (body: object, key = 'alice') =>
  request(app).post('/api/leave-requests/preview').set('Authorization', as(key)).send(body)

const apply = (body: object, key = 'alice') =>
  request(app).post('/api/leave-requests').set('Authorization', as(key)).send(body)

/** Puts days into somebody's ledger, the way the grant script would. */
async function grant(employeeId: string, leaveTypeId: string, days: number, leaveYear = YEAR) {
  await prisma.leaveLedgerEntry.create({
    data: { organizationId: orgId, employeeId, leaveTypeId, leaveYear, days, reason: 'opening_grant' },
  })
}

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
      // Sunday only, the common Indian office pattern.
      weeklyOffDays: [0],
    },
  })

  const cl = await prisma.leaveType.create({
    data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 },
  })
  clId = cl.id

  // No quota — granted, not accrued. The error message for this has to be
  // different from "you are 3 days short".
  const co = await prisma.leaveType.create({
    data: { organizationId: orgId, name: 'Comp Off', code: 'CO', annualQuota: 0 },
  })
  coId = co.id

  await prisma.holiday.create({
    // Tuesday of that week, so a Monday-to-Wednesday request costs two days
    // rather than three.
    data: { organizationId: orgId, name: 'Test Holiday', date: new Date(`${D(1)}T00:00:00Z`) },
  })

  await makeUser('hr', 'hr')
  // A company always has its Super Admin: who decides for somebody with nobody above (Day 22).
  await makeUser('boss', 'super_admin')
  const manager = await makeUser('mgr', 'manager')
  aliceId = await makeUser('alice', 'employee', { reportsTo: manager })
  bobId = await makeUser('bob', 'employee', { reportsTo: manager })
  strangerId = await makeUser('stranger', 'employee')
})

beforeEach(async () => {
  await prisma.leaveRequest.deleteMany({ where: { organization: { name: { startsWith: PREFIX } } } })
  await prisma.leaveLedgerEntry.deleteMany({
    where: { organization: { name: { startsWith: PREFIX } } },
  })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('which leave year a date belongs to', () => {
  it('puts March into the previous year when the year starts in April', () => {
    // A leave year starting in April means 2026-03-31 is leave year 2025.
    // Getting this wrong charges somebody's March leave to the wrong
    // entitlement, and nobody notices until the year closes.
    expect(leaveYearOf('2026-03-31', 4)).toBe(2025)
    expect(leaveYearOf('2026-04-01', 4)).toBe(2026)
  })

  it('follows the calendar when the year starts in January', () => {
    expect(leaveYearOf('2026-03-31', 1)).toBe(2026)
  })
})

describe('the preview', () => {
  it('counts working days, not calendar days', async () => {
    await grant(aliceId, clId, 12)

    // Wed 1 to Mon 6. The 2nd is a holiday and the 5th a Sunday.
    const res = await preview({ leaveTypeId: clId, fromDate: D(0), toDate: D(6) })

    expect(res.status).toBe(200)
    expect(res.body.data.days).toBe(5)
    expect(res.body.data.problem).toBeNull()
  })

  it('explains every day, so nobody has to reconstruct the rules', async () => {
    await grant(aliceId, clId, 12)

    const res = await preview({ leaveTypeId: clId, fromDate: D(0), toDate: D(6) })
    const reasons = res.body.data.breakdown.map((d: { reason: string }) => d.reason)

    expect(reasons).toEqual([
      'working',
      'holiday',
      'working',
      'working',
      'working',
      'working',
      'weekly_off',
    ])
  })

  it('charges half for a half day', async () => {
    await grant(aliceId, clId, 12)

    const res = await preview({
      leaveTypeId: clId,
      fromDate: D(0),
      toDate: D(2),
      halfDayDates: [D(2)],
    })

    // Tuesday is a holiday, so this is one full day plus one half.
    expect(res.body.data.days).toBe(1.5)
  })

  it('says how many days short, not just no', async () => {
    await grant(aliceId, clId, 2)

    const res = await preview({ leaveTypeId: clId, fromDate: D(7), toDate: D(11) })

    expect(res.body.data.problem.reason).toBe('insufficient')
    // "You are 3 days short" is actionable. "Insufficient balance" is not.
    expect(res.body.data.problem.message).toMatch(/3 days short/)
  })

  it('distinguishes a type with no quota from an exhausted balance', async () => {
    const res = await preview({ leaveTypeId: coId, fromDate: '2026-04-06', toDate: '2026-04-06' })

    // Telling somebody they are "1 day short" of comp off sends them looking
    // for days that were never going to exist.
    expect(res.body.data.problem.reason).toBe('no_quota')
    expect(res.body.data.problem.message).toMatch(/granted rather than accrued/)
  })

  it('refuses a range that is entirely weekend and holidays', async () => {
    await grant(aliceId, clId, 12)

    // D(6) is the Sunday, and Sunday is the only weekly off.
    const res = await preview({ leaveTypeId: clId, fromDate: D(6), toDate: D(6) })

    expect(res.body.data.days).toBe(0)
    expect(res.body.data.problem.reason).toBe('no_working_days')
  })

  it('refuses an end date before the start', async () => {
    await grant(aliceId, clId, 12)

    const res = await preview({ leaveTypeId: clId, fromDate: D(7), toDate: D(0) })
    expect(res.status).toBe(400)
  })

  it('writes nothing', async () => {
    await grant(aliceId, clId, 12)
    await preview({ leaveTypeId: clId, fromDate: D(0), toDate: D(6) })

    expect(await prisma.leaveRequest.count()).toBe(0)
  })
})

describe('applying', () => {
  const validRange = { fromDate: D(7), toDate: D(9) }

  it('creates a pending request with the days the server counted', async () => {
    await grant(aliceId, clId, 12)

    const res = await apply({ leaveTypeId: clId, ...validRange, reason: 'Family function' })

    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.days).toBe(3)
    expect(res.body.data.leave_year).toBe(2026)
  })

  it('ignores a days figure the client tries to send', async () => {
    await grant(aliceId, clId, 12)

    const res = await apply({
      leaveTypeId: clId,
      ...validRange,
      reason: 'Trying it on',
      days: 0,
    })

    // Unknown keys are refused outright rather than ignored, so a page sending
    // `days: 0` for three days off fails loudly instead of quietly.
    expect(res.status).toBe(422)
  })

  it('does NOT move the balance yet', async () => {
    await grant(aliceId, clId, 12)
    await apply({ leaveTypeId: clId, ...validRange, reason: 'Family function' })

    const balances = await request(app)
      .get('/api/leave-requests/balances')
      .set('Authorization', as('alice'))

    const cl = balances.body.data.balances.find((b: { code: string }) => b.code === 'CL')

    // The ledger is written on APPROVAL. Until then the days are held, not
    // spent — two different facts, shown as two different numbers.
    expect(cl.balance).toBe(12)
    expect(cl.pending).toBe(3)
    expect(cl.available).toBe(9)
  })

  it('counts pending days against the next request', async () => {
    await grant(aliceId, clId, 4)

    const first = await apply({ leaveTypeId: clId, ...validRange, reason: 'First' })
    expect(first.status).toBe(201)

    // 3 days held, 1 left. Without counting pending, somebody could book their
    // whole entitlement three times over and have all three approved.
    const second = await apply({
      leaveTypeId: clId,
      fromDate: D(14),
      toDate: D(16),
      reason: 'Second',
    })

    expect(second.status).toBe(400)
    expect(second.body.error.message).toMatch(/2 days short/)
  })

  it('lets only one of two applications sent together spend the same days', async () => {
    await grant(aliceId, clId, 3)

    // Different dates, three days each; the balance covers one. Both used to
    // read "3 available" before either had written, and both went in.
    const results = await Promise.all([
      apply({ leaveTypeId: clId, fromDate: D(7), toDate: D(9), reason: 'First' }),
      apply({ leaveTypeId: clId, fromDate: D(14), toDate: D(16), reason: 'Second' }),
    ])

    // The loser is refused either at the preview (400, days short) or inside
    // the transaction (409) — which depends on timing. That only one wins does not.
    expect(results.filter((r) => r.status === 201)).toHaveLength(1)
    expect(results.map((r) => r.status).filter((s) => s !== 201)[0]).toBeOneOf([400, 409])
    expect(await prisma.leaveRequest.count({ where: { employeeId: aliceId, status: 'pending' } })).toBe(1)
  })

  it('lets only one of two applications sent together have the same dates', async () => {
    await grant(aliceId, clId, 12)

    const results = await Promise.all([
      apply({ leaveTypeId: clId, ...validRange, reason: 'First' }),
      apply({ leaveTypeId: clId, ...validRange, reason: 'Again' }),
    ])

    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect(await prisma.leaveRequest.count({ where: { employeeId: aliceId, status: 'pending' } })).toBe(1)
  })

  it('refuses leave that overlaps leave already applied for', async () => {
    await grant(aliceId, clId, 12)
    await apply({ leaveTypeId: clId, ...validRange, reason: 'First' })

    const overlapping = await apply({
      leaveTypeId: clId,
      fromDate: D(8),
      toDate: D(10),
      reason: 'Overlapping',
    })

    // An employee cannot be on leave twice on the same day, and letting them
    // try produces two rows that both look valid.
    expect(overlapping.status).toBe(409)
    expect(overlapping.body.error.message).toMatch(/overlaps/i)
  })

  it('refuses a start date more than 90 days ago', async () => {
    await grant(aliceId, clId, 12, 2020)

    const res = await apply({
      leaveTypeId: clId,
      fromDate: '2020-01-01',
      toDate: '2020-01-02',
      reason: 'Very late',
    })

    // Backdated leave is real — somebody falls ill and applies on returning —
    // but a year back is a typo, and payroll is where it would surface.
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/90 days/)
  })

  it('requires a reason', async () => {
    await grant(aliceId, clId, 12)
    const res = await apply({ leaveTypeId: clId, ...validRange, reason: '' })
    expect(res.status).toBe(422)
  })
})

describe('applying on somebody else behalf', () => {
  const validRange = { fromDate: D(7), toDate: D(9) }

  it('refuses an employee applying as a colleague', async () => {
    await grant(bobId, clId, 12)

    const res = await apply(
      { leaveTypeId: clId, ...validRange, reason: 'Not mine', employeeId: bobId },
      'alice',
    )

    // Otherwise the request is Bob's in every respect except who submitted it.
    // An employee who cannot see Bob is not told he exists.
    expect(res.status).toBe(404)
  })

  it('lets the person’s manager apply for them — and not HR, whose leave decisions it is not (Day 22)', async () => {
    await grant(bobId, clId, 12)

    const res = await apply(
      { leaveTypeId: clId, ...validRange, reason: 'Recorded by his manager', employeeId: bobId },
      'mgr',
    )
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.employee_code).toBe(`${PREFIX}-bob`)

    const hr = await apply(
      { leaveTypeId: clId, fromDate: D(14), toDate: D(14), reason: 'Recorded by HR', employeeId: bobId },
      'hr',
    )
    expect(hr.status).toBe(403)
    expect(hr.body.error.message).toMatch(/the people whose leave you decide/)
  })
})

describe('who can see which requests', () => {
  beforeEach(async () => {
    await grant(aliceId, clId, 12)
    await grant(strangerId, clId, 12)
    await apply({ leaveTypeId: clId, fromDate: D(7), toDate: D(7), reason: 'Alice' })
    await apply(
      { leaveTypeId: clId, fromDate: D(7), toDate: D(7), reason: 'Stranger' },
      'stranger',
    )
  })

  const list = (key: string) =>
    request(app).get('/api/leave-requests').set('Authorization', as(key))

  it('shows an employee only their own', async () => {
    const res = await list('alice')
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].reason).toBe('Alice')
  })

  it('shows a manager their team', async () => {
    const res = await list('mgr')
    const reasons = res.body.data.map((r: { reason: string }) => r.reason)

    expect(reasons).toContain('Alice')
    expect(reasons).not.toContain('Stranger')
  })

  it('shows HR everybody', async () => {
    const res = await list('hr')
    expect(res.body.data).toHaveLength(2)
  })
})

describe('withdrawing', () => {
  it('lets an employee withdraw their own pending request', async () => {
    await grant(aliceId, clId, 12)
    const created = await apply({
      leaveTypeId: clId,
      fromDate: D(7),
      toDate: D(7),
      reason: 'Changed my mind',
    })

    const res = await request(app)
      .delete(`/api/leave-requests/${created.body.data.id}`)
      .set('Authorization', as('alice'))

    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')
  })

  it('releases the held days', async () => {
    await grant(aliceId, clId, 4)
    const created = await apply({
      leaveTypeId: clId,
      fromDate: D(7),
      toDate: D(9),
      reason: 'First',
    })

    await request(app)
      .delete(`/api/leave-requests/${created.body.data.id}`)
      .set('Authorization', as('alice'))

    const balances = await request(app)
      .get('/api/leave-requests/balances')
      .set('Authorization', as('alice'))
    const cl = balances.body.data.balances.find((b: { code: string }) => b.code === 'CL')

    expect(cl.pending).toBe(0)
    expect(cl.available).toBe(4)
  })

  it('refuses to withdraw somebody else request', async () => {
    await grant(bobId, clId, 12)
    const created = await apply(
      { leaveTypeId: clId, fromDate: D(7), toDate: D(7), reason: 'Bob' },
      'bob',
    )

    const res = await request(app)
      .delete(`/api/leave-requests/${created.body.data.id}`)
      .set('Authorization', as('alice'))

    // 404, not 403. Alice scope is SELF, so the request is not visible to her
    // at all — and a 403 would confirm it exists, which is the same leak the
    // employee endpoints avoid.
    expect(res.status).toBe(404)
  })
})

describe('a five-day week is a setting, not a code change', () => {
  /** Restores the six-day week so the other tests are unaffected. */
  async function setWeeklyOff(days: number[]) {
    await prisma.organizationPolicy.updateMany({
      where: { organizationId: orgId },
      data: { weeklyOffDays: days },
    })
  }

  it('charges the Saturday on a six-day week', async () => {
    await setWeeklyOff([0])
    await grant(aliceId, clId, 12)

    // Monday to Saturday. Tuesday is a holiday.
    const res = await preview({ leaveTypeId: clId, fromDate: D(0), toDate: D(5) })
    expect(res.body.data.days).toBe(5)
  })

  it('stops charging it the moment the company goes to five days', async () => {
    // Saturday AND Sunday off. Nothing is rebuilt and no code changes — the
    // counting reads the list, and the list is a company setting.
    await setWeeklyOff([0, 6])
    await grant(aliceId, clId, 12)

    const res = await preview({ leaveTypeId: clId, fromDate: D(0), toDate: D(5) })

    expect(res.body.data.days).toBe(4)
    expect(res.body.data.breakdown.at(-1).reason).toBe('weekly_off')

    await setWeeklyOff([0])
  })

  it('works for a Friday-Saturday weekend too', async () => {
    // The Gulf pattern. Same list, different numbers.
    await setWeeklyOff([5, 6])
    await grant(aliceId, clId, 12)

    const res = await preview({ leaveTypeId: clId, fromDate: D(0), toDate: D(6) })
    const reasons = res.body.data.breakdown.map((d: { reason: string }) => d.reason)

    // Mon, Tue(holiday), Wed, Thu, Fri(off), Sat(off), Sun(working now).
    expect(reasons[4]).toBe('weekly_off')
    expect(reasons[5]).toBe('weekly_off')
    expect(reasons[6]).toBe('working')

    await setWeeklyOff([0])
  })

  it('refuses to close the company every day', () => {
    // Tested against the schema directly. Sending this over HTTP as HR would
    // be refused for lacking settings:update and the validator would never
    // run — a green test that proves nothing.
    const result = policySchema.safeParse({ weeklyOffDays: [0, 1, 2, 3, 4, 5, 6] })

    // Otherwise leave becomes impossible to take, and the reason would be a
    // settings page nobody thought to look at.
    expect(result.success).toBe(false)

    expect(policySchema.safeParse({ weeklyOffDays: [0, 6] }).success).toBe(true)
    expect(policySchema.safeParse({ weeklyOffDays: [7] }).success).toBe(false)
  })
})
