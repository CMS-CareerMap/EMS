import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { addCalendarDays, fromDateColumn, monthOfDay, toDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { weekdayOf } from '../../domain/shared/workWeek'

/**
 * Settings → Leave Config → Working Week (client, 25 Oct 2026): the weekly
 * offs are dated — from today, the 1st of next month, or (while this month's
 * payroll is open) the 1st of this month — and every screen asks the week in
 * force on each day.
 */

const PREFIX = 'wwtest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

let orgId = ''
const tokens: Record<string, string> = {}
const employeeIds: Record<string, string> = {}
const today: CalendarDate = zonedToday(new Date(), 'Asia/Kolkata')
const thisMonth = `${today.slice(0, 7)}-01`
const nextMonth = (() => {
  const { year, month } = monthOfDay(today)
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
})()

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.workWeek.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function login(key: string, role: 'super_admin' | 'hr' | 'employee') {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  const membership = await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
  employeeIds[key] = (await prisma.employee.create({
    data: { organizationId: orgId, memberships: { connect: { id: membership.id } }, employeeCode: `${PREFIX}-${key}`, fullName: `${key} person` },
  })).id
  tokens[key] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
}

const as = (key: string) => `Bearer ${tokens[key]}`
const read = (key = 'sa') => request(app).get('/api/settings/work-week').set('Authorization', as(key))
const save = (body: Record<string, unknown>, key = 'sa') => request(app).put('/api/settings/work-week').set('Authorization', as(key)).send(body)
const cancel = (from: string, key = 'sa') => request(app).delete(`/api/settings/work-week/${from}`).set('Authorization', as(key))
const calendar = (day: CalendarDate) => {
  const { year, month } = monthOfDay(day)
  return request(app).get(`/api/attendance/calendar?year=${year}&month=${month}`).set('Authorization', as('sa'))
}
const offDays = async (day: CalendarDate) => ((await calendar(day)).body.data.days_off as { date: string }[]).map((d) => d.date)

/** The first Saturday on or after a day. */
function saturdayFrom(day: CalendarDate): CalendarDate {
  let d = day
  while (weekdayOf(d) !== 6) d = addCalendarDays(d, 1)
  return d
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01') } })
  await login('sa', 'super_admin')
  await login('hr', 'hr')
  await login('emp', 'employee')
})

beforeEach(async () => {
  // Sundays off since long ago, nothing saved for later, no payroll run.
  await prisma.workWeek.deleteMany({ where: { organizationId: orgId } })
  await prisma.workWeek.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), weeklyOffDays: [0] } })
  await prisma.payrollRun.deleteMany({ where: { organizationId: orgId } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('reading the working week', () => {
  it('says the week in force today, since when, and the days a change may start on', async () => {
    const res = await read()
    expect(res.status).toBe(200)
    expect(res.body.data.current).toEqual({ from: '2020-04-01', weekly_off_days: [0], names: ['Sunday'] })
    expect(res.body.data.scheduled).toEqual([])
    expect(res.body.data.starts).toEqual({ today, this_month: thisMonth === today ? null : thisMonth, next_month: nextMonth })
  })

  it('is a company setting: an employee cannot read it, HR cannot change it', async () => {
    expect((await read('emp')).status).toBe(403)
    expect((await save({ weeklyOffDays: [0, 6], from: nextMonth }, 'hr')).status).toBe(403)
  })
})

describe('a change from the 1st of next month', () => {
  it('is saved for later: this month keeps Sundays, next month has Saturdays off', async () => {
    const res = await save({ weeklyOffDays: [0, 6], from: nextMonth })
    expect(res.status).toBe(200)
    expect(res.body.data.current.weekly_off_days).toEqual([0])
    expect(res.body.data.scheduled).toEqual([{ from: nextMonth, weekly_off_days: [0, 6], names: ['Sunday', 'Saturday'] }])

    const saturdayNext = saturdayFrom(nextMonth)
    expect(await offDays(saturdayNext)).toContain(saturdayNext)
    const saturdayThis = saturdayFrom(thisMonth)
    if (saturdayThis < nextMonth) expect(await offDays(saturdayThis)).not.toContain(saturdayThis)
  })

  it('can be cancelled before it starts — and only then', async () => {
    await save({ weeklyOffDays: [0, 6], from: nextMonth })
    const res = await cancel(nextMonth)
    expect(res.status).toBe(200)
    expect(res.body.data.scheduled).toEqual([])
    expect((await cancel(nextMonth)).status).toBe(404)
    expect((await cancel(today)).status).toBe(400)
  })

  it('is replaced by a change saved from an earlier day', async () => {
    await save({ weeklyOffDays: [0, 6], from: nextMonth })
    const res = await save({ weeklyOffDays: [5, 6], from: today })
    expect(res.status).toBe(200)
    expect(res.body.data.current.weekly_off_days).toEqual([5, 6])
    expect(res.body.data.scheduled).toEqual([])
  })
})

describe('a change from today', () => {
  it('makes the coming Saturdays off and leaves the days before today as they were', async () => {
    const res = await save({ weeklyOffDays: [0, 6], from: today })
    expect(res.status).toBe(200)
    expect(res.body.data.current).toMatchObject({ from: today, weekly_off_days: [0, 6] })
    const ahead = saturdayFrom(today)
    expect(await offDays(ahead)).toContain(ahead)
    const lastSaturday = addCalendarDays(saturdayFrom(addCalendarDays(today, -7)), 0)
    if (lastSaturday < today) expect(await offDays(lastSaturday)).not.toContain(lastSaturday)
  })

  it('refuses a change that changes nothing', async () => {
    const res = await save({ weeklyOffDays: [0], from: today })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/already/)
  })

  it('says how many approved leave requests cover a day that changed — not recounted', async () => {
    const saturday = saturdayFrom(addCalendarDays(today, 1))
    const type = await prisma.leaveType.create({ data: { organizationId: orgId, code: 'CL', name: 'Casual Leave', annualQuota: 12 } })
    await prisma.leaveRequest.create({
      data: { organizationId: orgId, employeeId: employeeIds.emp!, leaveTypeId: type.id, fromDate: toDateColumn(saturday), toDate: toDateColumn(saturday), days: 1, leaveYear: 2026, reason: 'x', status: 'approved' },
    })
    try {
      const res = await save({ weeklyOffDays: [0, 6], from: today })
      expect(res.body.data.approved_leave_affected).toBe(1)
      expect(res.body.data.changed_days).toBeGreaterThan(0)
    } finally {
      await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } })
      await prisma.leaveType.deleteMany({ where: { organizationId: orgId } })
    }
  })

  it('is written in the audit log, as a sentence', async () => {
    await save({ weeklyOffDays: [0, 6], from: today })
    const row = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'work_week.changed' }, orderBy: { createdAt: 'desc' } })
    expect(row?.details).toMatchObject({ from: today, offDays: [0, 6], before: [0] })
  })
})

describe('the days a change may start on', () => {
  it('refuses a day before this month: those months are counted', async () => {
    const res = await save({ weeklyOffDays: [0, 6], from: addCalendarDays(thisMonth, -1) })
    expect(res.status).toBe(400)
  })

  it('refuses more than a year ahead', async () => {
    expect((await save({ weeklyOffDays: [0, 6], from: addCalendarDays(today, 400) })).status).toBe(400)
  })

  it('refuses every day of the week off', async () => {
    expect((await save({ weeklyOffDays: [0, 1, 2, 3, 4, 5, 6], from: nextMonth })).status).toBe(422)
  })

  it('takes the 1st of this month while its payroll is open — and not once it is approved', async () => {
    if (thisMonth === today) return // On the 1st, "this month" is today.
    const { year, month } = monthOfDay(today)
    expect((await save({ weeklyOffDays: [0, 6], from: thisMonth })).status).toBe(200)
    // Back to Sundays, then the month approved.
    await prisma.workWeek.deleteMany({ where: { organizationId: orgId, effectiveFrom: { gte: toDateColumn(thisMonth) } } })
    await prisma.payrollRun.create({
      data: {
        organizationId: orgId, year, month, status: 'approved', lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 0,
        grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0, calculatedAt: new Date(),
      },
    })
    const refused = await save({ weeklyOffDays: [0, 6], from: thisMonth })
    expect(refused.status).toBe(409)
    const view = await read()
    expect(view.body.data.starts.this_month).toBeNull()
    expect(view.body.data.this_month_closed).toMatch(/approved/)
    // From next month is still open.
    expect((await save({ weeklyOffDays: [0, 6], from: nextMonth })).status).toBe(200)
  })
})

describe('a change before every rule there is', () => {
  it('keeps the week the days before it had — even months paid', async () => {
    // A company whose only rule starts after the 1st: Sundays from the 5th.
    await prisma.workWeek.deleteMany({ where: { organizationId: orgId } })
    const fifth = addCalendarDays(thisMonth, 4)
    await prisma.workWeek.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn(fifth), weeklyOffDays: [0] } })
    // Saturday and Sunday from the 1st — before the only rule there is.
    const res = await save({ weeklyOffDays: [0, 6], from: thisMonth })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    // A Saturday long before keeps the Sundays-only week: it does not become off.
    const old = saturdayFrom('2025-06-01')
    expect(await offDays(old)).not.toContain(old)
    const rows = await prisma.workWeek.findMany({ where: { organizationId: orgId }, orderBy: { effectiveFrom: 'asc' } })
    expect(rows.map((r) => [fromDateColumn(r.effectiveFrom), r.weeklyOffDays])).toEqual([['2000-01-01', [0]], [thisMonth, [0, 6]]])
  })
})

describe('cancelling a change saved for later', () => {
  it('is refused once the month it starts in is approved — its days would change back', async () => {
    const tomorrow = addCalendarDays(today, 1)
    if (tomorrow.slice(0, 7) !== today.slice(0, 7)) return // The last day of a month: tomorrow is next month's.
    expect((await save({ weeklyOffDays: [0, 6], from: tomorrow })).status).toBe(200)
    const { year, month } = monthOfDay(today)
    await prisma.payrollRun.create({
      data: {
        organizationId: orgId, year, month, status: 'approved', lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 0,
        grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0, calculatedAt: new Date(),
      },
    })
    expect((await cancel(tomorrow)).status).toBe(409)
  })
})

describe('the approved leave a change touches', () => {
  it('counts leave however far ahead, by its own days', async () => {
    const type = await prisma.leaveType.create({ data: { organizationId: orgId, code: 'EL', name: 'Earned Leave', annualQuota: 12 } })
    // Two weeks of leave two months on — Saturdays inside it.
    const start = addCalendarDays(nextMonth, 40)
    await prisma.leaveRequest.create({
      data: { organizationId: orgId, employeeId: employeeIds.emp!, leaveTypeId: type.id, fromDate: toDateColumn(start), toDate: toDateColumn(addCalendarDays(start, 13)), days: 12, leaveYear: 2026, reason: 'x', status: 'approved' },
    })
    try {
      const res = await save({ weeklyOffDays: [0, 6], from: nextMonth })
      expect(res.body.data.approved_leave_affected).toBe(1)
    } finally {
      await prisma.leaveRequest.deleteMany({ where: { organizationId: orgId } })
      await prisma.leaveType.deleteMany({ where: { organizationId: orgId } })
    }
  })
})

describe('the payroll rules no longer carry the week', () => {
  it('refuses weekly offs sent with the payroll rules', async () => {
    const res = await request(app).put('/api/settings/payroll').set('Authorization', as('sa')).send({ weeklyOffDays: [0, 6] })
    expect(res.status).toBe(422)
  })
})
