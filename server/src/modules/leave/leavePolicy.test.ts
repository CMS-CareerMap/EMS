import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { forOrg } from '../../platform/db/scoped'
import { hashPassword } from '../../platform/auth/password'
import { addCalendarDays, fromDateColumn, toDateColumn, zonedToday } from '../../domain/shared/dates'
import { leaveDaysIn, lossOfPay, monthCalendar } from '../../domain/payroll/payDays'
import { grantWithNobodySignedIn } from './leaveEntitlement.service'

/**
 * Who gets how much leave and from when, Loss of Pay, and the rest of a short
 * application as Loss of Pay (client, 9 Oct 2026) — end to end over HTTP:
 * every rule a setting, one application decided as one, nothing hardcoded.
 */

const PREFIX = 'lpoltest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

const today = zonedToday(new Date(), 'Asia/Kolkata')
const YEAR = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)

/** The Monday of a week in January of this leave year — always inside it. */
function monday(week: number): string {
  let day = `${YEAR + 1}-01-05`
  while (new Date(`${day}T00:00:00Z`).getUTCDay() !== 1) day = addCalendarDays(day, 1)
  return addCalendarDays(day, week * 7)
}

let orgId = ''
const type: Record<string, string> = {}
const tokens: Record<string, string> = {}
const users: Record<string, string> = {}
const emp: Record<string, string> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.employeeLeaveEntitlement.deleteMany({ where: org })
  await prisma.employmentEvent.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function person(key: string, options: { role?: string; reportsTo?: string; joined?: string | null; unconfirmed?: boolean } = {}) {
  let membershipId: string | null = null
  if (options.role) {
    const email = `${PREFIX}-${key}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    users[key] = user.id
    membershipId = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: options.role, status: 'active' } })).id
  }
  const joined = options.joined === undefined ? '2020-01-06' : options.joined
  const e = await prisma.employee.create({
    data: {
      organizationId: orgId,
      ...(membershipId ? { memberships: { connect: { id: membershipId } } } : {}),
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key[0]!.toUpperCase()}${key.slice(1)} Test`,
      dateOfJoining: joined ? toDateColumn(joined) : null,
      onboardedOn: joined ? toDateColumn(joined) : null,
      confirmedOn: joined && !options.unconfirmed ? toDateColumn(joined) : null,
      reportingManagerId: options.reportsTo ?? null,
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
const preview = (key: string, body: object) => request(app).post('/api/leave-requests/preview').set('Authorization', as(key)).send(body)
const apply = (key: string, body: object) => request(app).post('/api/leave-requests').set('Authorization', as(key)).send({ reason: 'Family matter', ...body })
const act = (key: string, id: string, action: 'approve' | 'reject' | 'reverse') => request(app).post(`/api/leave-requests/${id}/${action}`).set('Authorization', as(key)).send({})
const withdraw = (key: string, id: string) => request(app).delete(`/api/leave-requests/${id}`).set('Authorization', as(key))
const adjust = (key: string, body: object) => request(app).post('/api/leave-balances/adjustments').set('Authorization', as(key)).send(body)
const own = (key: string, employee: string, body: object) => request(app).put(`/api/leave-balances/people/${emp[employee]}/entitlement`).set('Authorization', as(key)).send(body)
const ledger = (employeeId: string, leaveTypeId: string, reason?: 'opening_grant' | 'consumed' | 'reversal') =>
  prisma.leaveLedgerEntry.aggregate({ where: { employeeId, leaveTypeId, leaveYear: YEAR, ...(reason ? { reason } : {}) }, _sum: { days: true } }).then((r) => Number(r._sum.days ?? 0))
const noticesTo = (key: string, event: string) => prisma.notification.findMany({ where: { userId: users[key], event }, orderBy: { createdAt: 'asc' } })

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  const make = async (code: string, data: object) => (type[code] = (await prisma.leaveType.create({ data: { organizationId: orgId, code, ...data } as never })).id)
  await make('CL', { name: 'Casual Leave', annualQuota: 12 })
  await make('SL', { name: 'Sick Leave', annualQuota: 12, usableAfterConfirmation: true })
  await make('CO', { name: 'Comp Off', annualQuota: 0 })
  await make('LOP', { name: 'Loss of Pay', annualQuota: 0, isPaid: false })

  await person('boss', { role: 'super_admin' })
  await person('hema', { role: 'hr' })
  await person('adam', { role: 'admin' })
  const manoj = await person('manoj', { role: 'manager' })
  await person('priya', { role: 'employee', reportsTo: manoj })
  await person('sunil', { role: 'employee', reportsTo: manoj })
  await person('ravi', { role: 'employee', reportsTo: manoj, unconfirmed: true })
  await person('tara', { role: 'employee', reportsTo: manoj })

  expect((await request(app).post('/api/leave-balances/grant').set('Authorization', as('hema')).send({})).status).toBe(201)
})

afterAll(cleanup)

describe('Loss of Pay: unpaid, no limit', () => {
  it('is applied for with no balance, needs approval, and shows as days taken', async () => {
    const day = monday(0)
    const p = await preview('sunil', { leaveTypeId: type.LOP, fromDate: day, toDate: addCalendarDays(day, 1) })
    expect(p.status).toBe(200)
    expect(p.body.data.unlimited).toBe(true)
    expect(p.body.data.problem).toBeNull()

    const res = await apply('sunil', { leaveTypeId: type.LOP, fromDate: day, toDate: addCalendarDays(day, 1) })
    expect(res.status).toBe(201)
    expect(res.body.data.status).toBe('pending')
    expect(res.body.data.parts).toBeNull()
    expect((await act('manoj', res.body.data.id, 'approve')).status).toBe(200)
    expect(await ledger(emp.sunil!, type.LOP!)).toBe(-2)

    const balances = (await request(app).get('/api/leave-requests/balances').set('Authorization', as('sunil'))).body.data.balances
    const lop = balances.find((b: { code: string }) => b.code === 'LOP')
    expect(lop).toMatchObject({ is_paid: false, unlimited: true, taken: 2 })
    const cl = balances.find((b: { code: string }) => b.code === 'CL')
    expect(cl).toMatchObject({ is_paid: true, unlimited: false, taken: 0, available: 12 })

    // Team Balances: the column says what was taken; there is no balance to correct.
    const team = (await request(app).get('/api/leave-balances').set('Authorization', as('hema'))).body.data
    expect(team.types.find((t: { code: string }) => t.code === 'LOP')).toMatchObject({ is_paid: false, unlimited: true })
    const sunil = team.people.find((x: { full_name: string }) => x.full_name === 'Sunil Test')
    expect(sunil.balances.find((b: { leave_type_id: string }) => b.leave_type_id === type.LOP)).toMatchObject({ taken: 2, unlimited: true })
    const fix = await adjust('hema', { employeeId: emp.sunil, leaveTypeId: type.LOP, days: 2, note: 'Give back' })
    expect(fix.status).toBe(422)
    expect(fix.body.error.message).toMatch(/no limit/)
  })

  it('offers the whole of a type with nothing in it as Loss of Pay', async () => {
    const day = monday(1)
    const p = await preview('sunil', { leaveTypeId: type.CO, fromDate: day, toDate: addCalendarDays(day, 2) })
    expect(p.body.data.problem.reason).toBe('no_quota')
    expect(p.body.data.offer).toMatchObject({
      rest_leave_type_id: type.LOP,
      parts: [{ leave_type: 'LOP', is_paid: false, from_date: day, to_date: addCalendarDays(day, 2), days: 3 }],
    })
    expect(p.body.data.offer.message).toBe(`You have no Comp Off left. Apply for all 3 days as Loss of Pay? Loss of Pay is unpaid: its days are cut from pay.`)
    // Applied as it is, refused as before; applied like this, one request of Loss of Pay.
    expect((await apply('sunil', { leaveTypeId: type.CO, fromDate: day, toDate: addCalendarDays(day, 2) })).status).toBe(400)
    const res = await apply('sunil', { leaveTypeId: type.CO, fromDate: day, toDate: addCalendarDays(day, 2), restLeaveTypeId: type.LOP, coveredDays: 0 })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ leave_type: 'LOP', days: 3, parts: null, group_id: null })
    expect((await withdraw('sunil', res.body.data.id)).status).toBe(200)
  })

  it('offers nothing where the company has no unpaid type without a limit', async () => {
    await prisma.leaveType.update({ where: { id: type.LOP }, data: { annualQuota: 5 } })
    try {
      const day = monday(2)
      const p = await preview('sunil', { leaveTypeId: type.CO, fromDate: day, toDate: day })
      expect(p.body.data.problem.reason).toBe('no_quota')
      expect(p.body.data.offer).toBeNull()
    } finally {
      await prisma.leaveType.update({ where: { id: type.LOP }, data: { annualQuota: 0 } })
    }
  })
})

describe('the rest as Loss of Pay: one application, two parts', () => {
  let leadId = ''
  const from = monday(3)
  const to = addCalendarDays(from, 2)

  beforeAll(async () => {
    // Priya has one day of Casual Leave left.
    expect((await adjust('hema', { employeeId: emp.priya, leaveTypeId: type.CL, days: -11, note: 'Used elsewhere' })).status).toBe(201)
  })

  it('offers the day the balance covers and the rest as Loss of Pay, in words', async () => {
    const p = await preview('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to })
    expect(p.body.data.problem.reason).toBe('insufficient')
    expect(p.body.data.offer.rest_leave_type_id).toBe(type.LOP)
    expect(p.body.data.offer.parts).toEqual([
      { leave_type_id: type.CL, leave_type: 'CL', leave_type_name: 'Casual Leave', is_paid: true, from_date: from, to_date: from, days: 1 },
      { leave_type_id: type.LOP, leave_type: 'LOP', leave_type_name: 'Loss of Pay', is_paid: false, from_date: addCalendarDays(from, 1), to_date: to, days: 2 },
    ])
    expect(p.body.data.offer.message).toMatch(/^You have 1 day of Casual Leave\. Take 1 day as Casual Leave \(.+\) and 2 days as Loss of Pay \(.+\)\? Loss of Pay is unpaid: its days are cut from pay\.$/)
  })

  it('refuses to apply in parts the preview does not offer', async () => {
    // In parts says what the offer shown covered — or it is not taken at all.
    expect((await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to, restLeaveTypeId: type.LOP })).status).toBe(422)
    expect((await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to, restLeaveTypeId: type.LOP, coveredDays: 2 })).status).toBe(409)
    // Another unpaid type is not what was offered.
    expect((await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to, restLeaveTypeId: type.CO, coveredDays: 1 })).status).toBe(409)
    // A single day the balance covers needs no parts.
    const covered = await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: from, restLeaveTypeId: type.LOP, coveredDays: 1 })
    expect(covered.status).toBe(409)
    expect(covered.body.error.message).toMatch(/covers all/)
  })

  it('saves two requests, linked, read as one application everywhere', async () => {
    const before = (await noticesTo('manoj', 'leave.submitted')).length
    const res = await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to, restLeaveTypeId: type.LOP, coveredDays: 1 })
    expect(res.status).toBe(201)
    leadId = res.body.data.id
    expect(res.body.data).toMatchObject({ leave_type: 'CL', from_date: from, to_date: to, days: 3, status: 'pending' })
    expect(res.body.data.parts.map((p: { leave_type: string; days: number }) => `${p.leave_type}:${p.days}`)).toEqual(['CL:1', 'LOP:2'])

    const rows = await prisma.leaveRequest.findMany({ where: { employeeId: emp.priya, groupId: res.body.data.group_id }, orderBy: { fromDate: 'asc' } })
    expect(rows.map((r) => [fromDateColumn(r.fromDate), fromDateColumn(r.toDate), Number(r.days)])).toEqual([[from, from, 1], [addCalendarDays(from, 1), to, 2]])

    // The employee's list, the manager's team and the home page: one each.
    const mine = (await request(app).get('/api/leave-requests').set('Authorization', as('priya'))).body.data
    expect(mine.filter((r: { group_id: string | null }) => r.group_id === res.body.data.group_id)).toHaveLength(1)
    const team = (await request(app).get('/api/leave-requests/team').set('Authorization', as('manoj'))).body.data.requests
    expect(team.filter((r: { status: string }) => r.status === 'pending')).toHaveLength(1)
    expect((await request(app).get('/api/dashboard/me').set('Authorization', as('manoj'))).body.data.waiting_for_me).toBe(1)

    // One notice to the manager, naming both parts.
    const told = await noticesTo('manoj', 'leave.submitted')
    expect(told).toHaveLength(before + 1)
    expect(told.at(-1)!.message).toMatch(/^Priya Test asked for 1 day of Casual Leave \+ 2 days of Loss of Pay: /)
  })

  it('refuses a second application over the same days, whole or in parts', async () => {
    expect((await apply('priya', { leaveTypeId: type.LOP, fromDate: to, toDate: to })).status).toBe(409)
  })

  it('is approved whole: both parts, both balances, attendance, and loss of pay for the unpaid days', async () => {
    const res = await act('manoj', leadId, 'approve')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('approved')
    expect(res.body.data.parts).toHaveLength(2)
    const parts = await prisma.leaveRequest.findMany({ where: { groupId: res.body.data.group_id } })
    expect(parts.every((p) => p.status === 'approved')).toBe(true)
    expect(await ledger(emp.priya!, type.CL!, 'consumed')).toBe(-1)
    expect(await ledger(emp.priya!, type.LOP!, 'consumed')).toBe(-2)
    expect(await prisma.attendance.count({ where: { employeeId: emp.priya, status: 'on_leave' } })).toBe(3)
    const told = await noticesTo('priya', 'leave.decided')
    expect(told).toHaveLength(1)
    expect(told[0]!.message).toMatch(/^Your Casual Leave \+ Loss of Pay for .+ was approved\.$/)

    // Payroll reads each part's type: the Casual Leave day is paid, the two Loss of Pay days are cut.
    const [year, month] = from.split('-').map(Number) as [number, number]
    const calendar = monthCalendar({ year, month, weeklyOffDays: [0], holidays: [] })
    const approved = parts.map((p) => ({ from: fromDateColumn(p.fromDate)!, to: fromDateColumn(p.toDate)!, halfDays: p.halfDayDates, paid: p.leaveTypeId === type.CL }))
    const attendance = (await prisma.attendance.findMany({ where: { employeeId: emp.priya } })).map((a) => ({ date: fromDateColumn(a.date)!, status: a.status }))
    const lop = lossOfPay({
      calendar,
      window: { from: calendar.days[0]!.date, to: calendar.days[calendar.days.length - 1]!.date },
      attendance,
      leave: leaveDaysIn(approved, calendar, [0]),
      sandwichRule: false,
      today: calendar.days[calendar.days.length - 1]!.date,
    } as Parameters<typeof lossOfPay>[0])
    expect(lop.lopDays).toBe(2)
  })

  it('is reversed whole: both parts back, and their attendance gone', async () => {
    const res = await act('manoj', leadId, 'reverse')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('cancelled')
    expect(await ledger(emp.priya!, type.CL!)).toBe(1)
    expect(await ledger(emp.priya!, type.LOP!)).toBe(0)
    expect(await prisma.attendance.count({ where: { employeeId: emp.priya, status: 'on_leave' } })).toBe(0)
  })

  it('is rejected whole, and withdrawn whole', async () => {
    const a = await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to, restLeaveTypeId: type.LOP, coveredDays: 1 })
    expect(a.status).toBe(201)
    expect((await act('manoj', a.body.data.id, 'reject')).status).toBe(200)
    expect((await prisma.leaveRequest.findMany({ where: { groupId: a.body.data.group_id } })).map((r) => r.status)).toEqual(['rejected', 'rejected'])

    const b = await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to, restLeaveTypeId: type.LOP, coveredDays: 1 })
    expect(b.status).toBe(201)
    const told = (await noticesTo('manoj', 'leave.withdrawn')).length
    expect((await withdraw('priya', b.body.data.id)).status).toBe(200)
    expect((await prisma.leaveRequest.findMany({ where: { groupId: b.body.data.group_id } })).map((r) => r.status)).toEqual(['cancelled', 'cancelled'])
    expect(await noticesTo('manoj', 'leave.withdrawn')).toHaveLength(told + 1)
  })

  it('refuses a page left open while the balance changed', async () => {
    const p = await preview('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to })
    expect(p.body.data.offer.parts[0].days).toBe(1)
    expect((await adjust('hema', { employeeId: emp.priya, leaveTypeId: type.CL, days: 1, note: 'Found a day' })).status).toBe(201)
    // The offer split at one day; there are two now — it would split elsewhere.
    const res = await apply('priya', { leaveTypeId: type.CL, fromDate: from, toDate: to, restLeaveTypeId: type.LOP, coveredDays: 1 })
    expect(res.status).toBe(409)
    expect(await prisma.leaveRequest.count({ where: { employeeId: emp.priya, status: 'pending' } })).toBe(0)
  })
})

describe('an application in parts, at the edges', () => {
  it('lets one of two applications sent together for the same days through, and refuses the other', async () => {
    const day = monday(6)
    await adjust('hema', { employeeId: emp.sunil, leaveTypeId: type.CL, days: -11, note: 'Down to one' })
    const body = { leaveTypeId: type.CL, fromDate: day, toDate: addCalendarDays(day, 2), restLeaveTypeId: type.LOP, coveredDays: 1 }
    const [a, b] = await Promise.all([apply('sunil', body), apply('sunil', body)])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(await prisma.leaveRequest.count({ where: { employeeId: emp.sunil, status: 'pending', fromDate: { gte: toDateColumn(day) } } })).toBe(2)
    const id = (a.status === 201 ? a : b).body.data.id
    expect((await withdraw('sunil', id)).status).toBe(200)
    await adjust('hema', { employeeId: emp.sunil, leaveTypeId: type.CL, days: 11, note: 'Back' })
  })

  it('records the owner’s application in parts directly, both parts, with nobody to approve it', async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: emp.boss } })
    try {
      // Nobody below the owner corrects their balance (Day 22): set up in the ledger itself.
      await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp.boss!, leaveTypeId: type.CL!, leaveYear: YEAR, days: -11, reason: 'adjustment', note: 'Down to one' } })
      const day = monday(7)
      const res = await apply('boss', { leaveTypeId: type.CL, fromDate: day, toDate: addCalendarDays(day, 1), restLeaveTypeId: type.LOP, coveredDays: 1 })
      expect(res.status).toBe(201)
      expect(res.body.data.status).toBe('approved')
      expect(res.body.data.parts.map((p: { leave_type: string }) => p.leave_type)).toEqual(['CL', 'LOP'])
      expect(await ledger(emp.boss!, type.LOP!)).toBe(-1)
    } finally {
      await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: null } })
    }
  })

  it('cancels only the part after a last working day, and shows the part before as it stands', async () => {
    const day = monday(8)
    await person('vani', { role: 'employee', reportsTo: emp.manoj })
    // Vani joined before this year; her year was granted, and one day of Casual Leave is left of it.
    await prisma.leaveLedgerEntry.createMany({ data: [
      { organizationId: orgId, employeeId: emp.vani!, leaveTypeId: type.CL!, leaveYear: YEAR, days: 12, reason: 'opening_grant' },
      { organizationId: orgId, employeeId: emp.vani!, leaveTypeId: type.CL!, leaveYear: YEAR, days: -11, reason: 'adjustment', note: 'Taken before' },
      { organizationId: orgId, employeeId: emp.vani!, leaveTypeId: type.SL!, leaveYear: YEAR, days: 12, reason: 'opening_grant' },
    ] })
    const res = await apply('vani', { leaveTypeId: type.CL, fromDate: day, toDate: addCalendarDays(day, 2), restLeaveTypeId: type.LOP, coveredDays: 1 })
    expect(res.status).toBe(201)
    expect((await act('manoj', res.body.data.id, 'approve')).status).toBe(200)
    // Her last day is the Monday: the Loss of Pay days after it go back; the Monday stays.
    const leaving = await request(app).patch(`/api/employees/${emp.vani}`).set('Authorization', as('hema')).send({ lastWorkingDate: day })
    expect(leaving.status, JSON.stringify(leaving.body)).toBe(200)
    const parts = await prisma.leaveRequest.findMany({ where: { groupId: res.body.data.group_id }, orderBy: { fromDate: 'asc' } })
    expect(parts.map((p) => p.status)).toEqual(['approved', 'cancelled'])
    expect(await ledger(emp.vani!, type.LOP!)).toBe(0)
    expect(await ledger(emp.vani!, type.CL!)).toBe(0)
    // Told of the part that went, as itself — and listed apart now, each as it stands.
    expect((await noticesTo('vani', 'leave.reversed')).at(-1)!.message).toMatch(/^Your approved Loss of Pay for .+ was reversed: Cancelled: it falls after the last working day/)
    const listed = (await request(app).get('/api/leave-requests').set('Authorization', as('vani'))).body.data.filter((r: { group_id: string | null }) => r.group_id === res.body.data.group_id)
    expect(listed.map((r: { status: string; parts: unknown }) => `${r.status}:${r.parts}`).sort()).toEqual(['approved:null', 'cancelled:null'])
  })
})

describe('usable only after confirmation', () => {
  it('refuses somebody on probation, and takes them once confirmed', async () => {
    const day = monday(4)
    const p = await preview('ravi', { leaveTypeId: type.SL, fromDate: day, toDate: day })
    expect(p.body.data.problem).toMatchObject({ reason: 'not_eligible' })
    expect(p.body.data.offer).toBeNull()
    await prisma.employee.update({ where: { id: emp.ravi }, data: { confirmedOn: toDateColumn(addCalendarDays(day, -3)) } })
    expect((await preview('ravi', { leaveTypeId: type.SL, fromDate: day, toDate: day })).body.data.problem).toBeNull()
  })

  it('is set on the leave type, by whoever may change leave types', async () => {
    const res = await request(app).patch(`/api/settings/leave-types/${type.CL}`).set('Authorization', as('adam')).send({ usableAfterConfirmation: true, joinerGrant: 'months_after_joining' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ usable_after_confirmation: true, joiner_grant: 'months_after_joining', unlimited: false })
    const back = await request(app).patch(`/api/settings/leave-types/${type.CL}`).set('Authorization', as('adam')).send({ usableAfterConfirmation: false, joinerGrant: 'months_left' })
    expect(back.status).toBe(200)
    expect((await request(app).patch(`/api/settings/leave-types/${type.CL}`).set('Authorization', as('priya')).send({ usableAfterConfirmation: true })).status).toBe(403)
    expect((await request(app).patch(`/api/settings/leave-types/${type.CL}`).set('Authorization', as('adam')).send({ joinerGrant: 'whenever' })).status).toBe(422)
  })
})

describe('a person’s own days a year', () => {
  it('adds the difference at once, and takes it away again when put back on the company’s', async () => {
    const res = await own('hema', 'tara', { leaveTypeId: type.CL, days: 15, note: 'Agreed at joining' })
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ own_days: 15, balance_change: 3, not_taken_back: 0 })
    expect(await ledger(emp.tara!, type.CL!)).toBe(15)
    const told = await noticesTo('tara', 'leave.balance_changed')
    expect(told.at(-1)!.message).toBe('Your Casual Leave is now 15 days a year. 3 days added to your balance. Reason: Agreed at joining')

    const view = (await request(app).get(`/api/leave-balances/people/${emp.tara}`).set('Authorization', as('hema'))).body.data
    expect(view.may_change).toBe(true)
    expect(view.types.find((t: { code: string }) => t.code === 'CL')).toMatchObject({ company_days: 12, own_days: 15, granted: 15, taken: 0, available: 15 })
    expect(view.types.find((t: { code: string }) => t.code === 'LOP')).toMatchObject({ unlimited: true, own_days: null })

    // The same number again is nothing to change.
    expect((await own('hema', 'tara', { leaveTypeId: type.CL, days: 15, note: 'Again' })).status).toBe(400)
    const back = await own('hema', 'tara', { leaveTypeId: type.CL, days: null, note: 'Back to policy' })
    expect(back.body.data).toMatchObject({ own_days: null, balance_change: -3 })
    expect(await ledger(emp.tara!, type.CL!)).toBe(12)
  })

  it('never takes back days already taken: a cut goes only as far as what is left', async () => {
    const day = monday(5)
    const res = await apply('tara', { leaveTypeId: type.CL, fromDate: day, toDate: addCalendarDays(day, 4) })
    expect(res.status).toBe(201)
    expect((await act('manoj', res.body.data.id, 'approve')).status).toBe(200)
    // 12 granted, 5 taken, 7 left. Two days a year would take 10 away; only 7 can go.
    const cut = await own('hema', 'tara', { leaveTypeId: type.CL, days: 2, note: 'Policy change' })
    expect(cut.status).toBe(200)
    expect(cut.body.data).toMatchObject({ balance_change: -7, not_taken_back: 3 })
    expect(await ledger(emp.tara!, type.CL!)).toBe(0)
    await own('hema', 'tara', { leaveTypeId: type.CL, days: null, note: 'Undo' })
  })

  it('gives a type the company gives nobody to the one person given days of it', async () => {
    const res = await own('hema', 'sunil', { leaveTypeId: type.CO, days: 3, note: 'Weekend work' })
    expect(res.status).toBe(200)
    expect(await ledger(emp.sunil!, type.CO!)).toBe(3)
  })

  it('is set by whoever manages leave balances — never their own, never by an employee or a manager', async () => {
    expect((await own('priya', 'tara', { leaveTypeId: type.CL, days: 20, note: 'Mine' })).status).toBe(403)
    expect((await own('manoj', 'tara', { leaveTypeId: type.CL, days: 20, note: 'Team' })).status).toBe(403)
    expect((await own('adam', 'tara', { leaveTypeId: type.CL, days: 20, note: 'Admin' })).status).toBe(403)
    expect((await own('hema', 'hema', { leaveTypeId: type.CL, days: 20, note: 'For me' })).status).toBe(403)
    expect((await request(app).get(`/api/leave-balances/people/${emp.tara}`).set('Authorization', as('manoj'))).status).toBe(403)
    expect((await own('hema', 'tara', { leaveTypeId: type.CL, days: 1.3, note: 'Odd' })).status).toBe(422)
    expect((await own('hema', 'tara', { leaveTypeId: type.CL, days: 5 })).status).toBe(422)
    expect((await own('hema', 'tara', { leaveTypeId: type.CL, days: -1, note: 'Below' })).status).toBe(422)
  })
})

describe('granted without anybody pressing Grant', () => {
  const add = (key: string, body: object) => request(app).post('/api/employees').set('Authorization', as(key)).send(body)

  it('grants a new joiner their share the moment they are added, by the type’s rule and their own days', async () => {
    const joined = `${YEAR}-10-14`
    const res = await add('hema', { employeeCode: `${PREFIX}-new1`, fullName: 'New One', dateOfJoining: joined })
    expect(res.status).toBe(201)
    // October to March: six months of twelve.
    expect(await ledger(res.body.data.id, type.CL!)).toBe(6)

    const withOwn = await add('hema', { employeeCode: `${PREFIX}-new2`, fullName: 'New Two', dateOfJoining: joined, leaveEntitlements: [{ leaveTypeId: type.CL, days: 24 }] })
    expect(withOwn.status).toBe(201)
    expect(await ledger(withOwn.body.data.id, type.CL!)).toBe(12)

    // No joining date: no share to work out — HR's Grant leave names them instead.
    const undated = await add('hema', { employeeCode: `${PREFIX}-new3`, fullName: 'New Three' })
    expect(undated.status).toBe(201)
    expect(await ledger(undated.body.data.id, type.CL!)).toBe(0)
  })

  it('refuses own days on Add Employee to somebody who does not manage balances', async () => {
    const res = await add('adam', { employeeCode: `${PREFIX}-new4`, fullName: 'New Four', dateOfJoining: `${YEAR}-10-14`, leaveEntitlements: [{ leaveTypeId: type.CL, days: 24 }] })
    expect(res.status).toBe(403)
    expect(await prisma.employee.count({ where: { employeeCode: `${PREFIX}-new4` } })).toBe(0)
  })

  it('works their leave out again when their joining date is corrected — or grants it, when they had none', async () => {
    const one = (await prisma.employee.findFirstOrThrow({ where: { employeeCode: `${PREFIX}-new1` } })).id
    // Casual Leave goes to 24 a year from the next leave year: a date corrected now must not bring that in.
    expect((await request(app).patch(`/api/settings/leave-types/${type.CL}`).set('Authorization', as('adam')).send({ annualQuota: 24 })).status).toBe(200)
    try {
      const moved = await request(app).patch(`/api/employees/${one}`).set('Authorization', as('hema')).send({ dateOfJoining: `${YEAR}-07-02` })
      expect(moved.status).toBe(200)
      // July to March: nine months — of the twelve a year she was given, not of the new twenty-four.
      expect(await ledger(one, type.CL!)).toBe(9)
    } finally {
      await request(app).patch(`/api/settings/leave-types/${type.CL}`).set('Authorization', as('adam')).send({ annualQuota: 12 })
    }

    const three = (await prisma.employee.findFirstOrThrow({ where: { employeeCode: `${PREFIX}-new3` } })).id
    expect((await request(app).patch(`/api/employees/${three}`).set('Authorization', as('hema')).send({ dateOfJoining: `${YEAR}-10-14` })).status).toBe(200)
    expect(await ledger(three, type.CL!)).toBe(6)
  })

  it('grants the year at night to anybody with a joining date who has not had it — once', async () => {
    const late = await person('late', { joined: `${YEAR}-10-14` })
    await person('nodate', { joined: null })
    // Somebody whose balance HR typed in by hand, with no grant: theirs is HR's, not the night's.
    const manual = await person('manual')
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: manual, leaveTypeId: type.CL!, leaveYear: YEAR, days: 4, reason: 'adjustment', note: 'Left from before EMS' } })
    const db = forOrg(orgId)
    const dry = await grantWithNobodySignedIn(db, orgId, { withoutJoiningDate: false, apply: false, via: 'nightly' })
    expect(dry.people).toBe(1)
    expect(await ledger(late, type.CL!)).toBe(0)
    const done = await grantWithNobodySignedIn(db, orgId, { withoutJoiningDate: false, apply: true, via: 'nightly' })
    expect(done).toMatchObject({ people: 1 })
    expect(await ledger(late, type.CL!)).toBe(6)
    expect(await ledger(emp.nodate!, type.CL!)).toBe(0)
    expect(await ledger(manual, type.CL!)).toBe(4)
    expect(await ledger(manual, type.SL!)).toBe(0)
    expect((await grantWithNobodySignedIn(db, orgId, { withoutJoiningDate: false, apply: true, via: 'nightly' })).people).toBe(0)
    const logged = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'leave.granted', actorUserId: null }, orderBy: { createdAt: 'desc' } })
    expect(logged?.details).toMatchObject({ via: 'nightly', people: 1 })
  })

  it('carries last year’s days in at night once nothing of last year is waiting — not before, so none lapse', async () => {
    const el = (type.EL = (await prisma.leaveType.create({ data: { organizationId: orgId, code: 'EL', name: 'Earned Leave', annualQuota: 15, carryForward: true, carryForwardCap: 10 } })).id)
    try {
      const carl = await person('carl')
      // Last year: 5 days of Earned Leave left, 2 of them applied for and not decided yet. This year granted already.
      await prisma.leaveLedgerEntry.createMany({ data: [
        { organizationId: orgId, employeeId: carl, leaveTypeId: el, leaveYear: YEAR - 1, days: 5, reason: 'opening_grant' },
        { organizationId: orgId, employeeId: carl, leaveTypeId: el, leaveYear: YEAR, days: 15, reason: 'opening_grant' },
        ...['CL', 'SL'].map((code) => ({ organizationId: orgId, employeeId: carl, leaveTypeId: type[code]!, leaveYear: YEAR, days: 12, reason: 'opening_grant' as const })),
      ] })
      const waiting = await prisma.leaveRequest.create({ data: {
        organizationId: orgId, employeeId: carl, leaveTypeId: el, fromDate: toDateColumn(`${YEAR}-03-23`), toDate: toDateColumn(`${YEAR}-03-24`),
        days: 2, leaveYear: YEAR - 1, reason: 'Before the year turned', status: 'pending',
      } })
      const db = forOrg(orgId)
      await grantWithNobodySignedIn(db, orgId, { withoutJoiningDate: false, apply: true, via: 'nightly' })
      expect(await ledger(carl, el, 'opening_grant')).toBe(15)
      expect(await ledger(carl, el)).toBe(15)

      // Turned down after the year began: all five carry the next night.
      await prisma.leaveRequest.update({ where: { id: waiting.id }, data: { status: 'rejected' } })
      await grantWithNobodySignedIn(db, orgId, { withoutJoiningDate: false, apply: true, via: 'nightly' })
      expect(await ledger(carl, el)).toBe(20)
      const lastYear = await prisma.leaveLedgerEntry.aggregate({ where: { employeeId: carl, leaveTypeId: el, leaveYear: YEAR - 1 }, _sum: { days: true } })
      expect(Number(lastYear._sum.days)).toBe(0)
    } finally {
      await prisma.leaveType.update({ where: { id: el }, data: { archivedAt: new Date() } })
    }
  })
})

describe('a leave type’s days changed for everybody', () => {
  it('changes this year’s balances only when asked, and only by whoever manages balances', async () => {
    const patch = (key: string, body: object) => request(app).patch(`/api/settings/leave-types/${type.SL}`).set('Authorization', as(key)).send(body)
    expect((await patch('adam', { annualQuota: 10, applyToThisYear: true })).status).toBe(403)

    const nextYear = await patch('adam', { annualQuota: 10 })
    expect(nextYear.status).toBe(200)
    expect(nextYear.body.meta.balances).toMatchObject({ this_year: false, days: 0 })
    expect(await ledger(emp.priya!, type.SL!)).toBe(12)

    const now = await patch('hema', { annualQuota: 9, applyToThisYear: true })
    expect(now.status).toBe(200)
    expect(now.body.meta.balances.this_year).toBe(true)
    expect(await ledger(emp.priya!, type.SL!)).toBe(9)
    expect(await ledger(emp.tara!, type.SL!)).toBe(9)
  })

  it('gives a type that had no days from the next year when asked so — and this year when asked that', async () => {
    const patch = (body: object) => request(app).patch(`/api/settings/leave-types/${type.CO}`).set('Authorization', as('hema')).send(body)
    const buttonWould = async () => (await request(app).get('/api/leave-balances/grant-preview').set('Authorization', as('hema'))).body.data
    const before = await buttonWould()
    // From next year: marked as given at 0 this year, so no grant gives it now — not the night's, not the button's.
    expect((await patch({ annualQuota: 2 })).status).toBe(200)
    expect(await ledger(emp.priya!, type.CO!)).toBe(0)
    expect(await prisma.leaveLedgerEntry.count({ where: { employeeId: emp.priya, leaveTypeId: type.CO, leaveYear: YEAR, reason: 'opening_grant', days: 0 } })).toBe(1)
    // The button adds it only for the people given nothing of this year yet (no joining date, or a balance typed by hand):
    // their whole year is still to come. Nobody already given the year is offered it.
    const after = await buttonWould()
    expect([after.people, after.days - before.days]).toEqual([before.people, 2 * before.people])
    expect((await grantWithNobodySignedIn(forOrg(orgId), orgId, { withoutJoiningDate: false, apply: false, via: 'nightly' })).days).toBe(0)

    // This year too: everybody given this year gets it now — Sunil keeps his own three.
    const now = await patch({ annualQuota: 4, applyToThisYear: true })
    expect(now.status).toBe(200)
    expect(await ledger(emp.priya!, type.CO!)).toBe(4)
    expect(await ledger(emp.sunil!, type.CO!)).toBe(3)
    // Back to none, this year too: what is left of it goes.
    expect((await patch({ annualQuota: 0, applyToThisYear: true })).status).toBe(200)
    expect(await ledger(emp.priya!, type.CO!)).toBe(0)
  })

  it('shows Loss of Pay in the Leave balances report as the days taken, not a negative balance', async () => {
    const month = monday(0).slice(0, 7)
    const res = await request(app).get(`/api/reports/leave-balances?year=${Number(month.slice(0, 4))}&month=${Number(month.slice(5, 7))}`).set('Authorization', as('boss'))
    expect(res.status).toBe(200)
    const column = res.body.data.columns.find((c: { key: string }) => c.key === 'type_LOP')
    expect(column.label).toBe('Loss of Pay (taken)')
    const sunil = res.body.data.rows.find((r: { full_name: string }) => r.full_name === 'Sunil Test')
    expect(sunil.type_LOP).toBe(2)
  })

  it('keeps unpaid leave from carrying forward or being encashed', async () => {
    const patch = (body: object) => request(app).patch(`/api/settings/leave-types/${type.LOP}`).set('Authorization', as('hema')).send(body)
    expect((await patch({ carryForward: true, carryForwardCap: 5 })).status).toBe(400)
    expect((await patch({ encashable: true })).status).toBe(400)
    const add = await request(app).post('/api/settings/leave-types').set('Authorization', as('hema')).send({ name: 'Unpaid Extra', code: 'UX', isPaid: false, carryForward: true, carryForwardCap: 3 })
    expect(add.status).toBe(400)
  })
})

describe('the data migration', () => {
  it('adds Loss of Pay where a company has no unpaid type, and archives the unused Work From Home leave type', async () => {
    const sql = readFileSync(join(__dirname, '../../../prisma/schema/migrations/20261010051204_leave_policy_loss_of_pay/migration.sql'), 'utf8')
    const steps = sql.slice(sql.indexOf('-- Loss of Pay (client')).split(/;\s*\n/).map((s) => s.trim()).filter((s) => /INSERT|UPDATE/.test(s))
    expect(steps).toHaveLength(2)

    const rollback = new Error('rolled back on purpose')
    await prisma.$transaction(async (tx) => {
      const org = async (name: string) => (await tx.organization.create({ data: { name: `${PREFIX}-mig-${name}`, timezone: 'Asia/Kolkata' } })).id
      const a = await org('plain')
      await tx.leaveType.createMany({ data: [{ organizationId: a, code: 'CL', name: 'Casual Leave', annualQuota: 12 }, { organizationId: a, code: 'WFH', name: 'Work From Home', annualQuota: 0 }] })
      const b = await org('unpaid')
      await tx.leaveType.createMany({ data: [{ organizationId: b, code: 'CL', name: 'Casual Leave', annualQuota: 12 }, { organizationId: b, code: 'UL', name: 'Unpaid Leave', annualQuota: 0, isPaid: false }] })
      const c = await org('wfhused')
      const used = await tx.leaveType.create({ data: { organizationId: c, code: 'WFH', name: 'Work From Home', annualQuota: 0 } })
      const somebody = await tx.employee.create({ data: { organizationId: c, employeeCode: `${PREFIX}-mig`, fullName: 'Mig Test' } })
      await tx.leaveLedgerEntry.create({ data: { organizationId: c, employeeId: somebody.id, leaveTypeId: used.id, leaveYear: YEAR, days: 2, reason: 'adjustment', note: 'Given' } })
      const d = await org('none')

      for (const step of steps) await tx.$executeRawUnsafe(step)

      const types = async (id: string) => (await tx.leaveType.findMany({ where: { organizationId: id }, orderBy: { code: 'asc' } })).map((t) => `${t.code}:${t.isPaid ? 'paid' : 'unpaid'}:${Number(t.annualQuota)}:${t.archivedAt ? 'archived' : 'live'}`)
      expect(await types(a)).toEqual(['CL:paid:12:live', 'LOP:unpaid:0:live', 'WFH:paid:0:archived'])
      expect(await types(b)).toEqual(['CL:paid:12:live', 'UL:unpaid:0:live'])
      // In use: kept as it is. A company with no unpaid type gets Loss of Pay all the same.
      expect(await types(c)).toEqual(['LOP:unpaid:0:live', 'WFH:paid:0:live'])
      // Never set up: given it with the others when they are first set up.
      expect(await types(d)).toEqual([])
      throw rollback
    }).catch((err: unknown) => {
      if (err !== rollback) throw err
    })
  })
})
