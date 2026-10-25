import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { forOrg } from '../../platform/db/scoped'
import { hashPassword } from '../../platform/auth/password'
import { addCalendarDays, fromDateColumn, monthOfDay, toDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'
import { weekdayOf } from '../../domain/shared/workWeek'
import { reconcileAbsent } from './absentRule.service'
import { nudgeCheckOuts } from './checkOutNudge.service'

/**
 * No check-in means Absent (client, 25 Oct 2026), end to end on a real
 * database: the nightly run marks only days with nothing in them, takes back
 * only what it wrote, and gives way to everything a person does — a punch, a
 * leave, HR's mark, a holiday, the rule switched off — while a month whose
 * payroll is closed never changes. With it: the check-out reminder, marking
 * the people ticked, and the roster's "day over".
 */

const PREFIX = 'absrtest'
const PASSWORD = 'CorrectHorseBattery1'
const TZ = 'Asia/Kolkata'
const app = createApp()

const today = zonedToday(new Date(), TZ)
const yesterday = addCalendarDays(today, -1)

/** A Monday three to four weeks back whose week is in one month — inside "the 1st of last month" at the earliest. */
function pastMonday(): CalendarDate {
  let day = addCalendarDays(today, -21)
  while (weekdayOf(day) !== 1) day = addCalendarDays(day, -1)
  if (addCalendarDays(day, 5).slice(0, 7) !== day.slice(0, 7)) day = addCalendarDays(day, -7)
  return day
}
const MON = pastMonday()
const [TUE, WED, THU, FRI, SAT] = [1, 2, 3, 4, 5].map((n) => addCalendarDays(MON, n)) as [CalendarDate, CalendarDate, CalendarDate, CalendarDate, CalendarDate]
const yearOf = (day: string) => Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) >= 4 ? 0 : 1)

let orgId = ''
let clId = ''
let shiftId = ''
const tokens: Record<string, string> = {}
const users: Record<string, string> = {}
const emp: Record<string, string> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.holiday.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.shift.deleteMany({ where: org })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

/** Records and logins made long ago, as a company's are — unless `madeOn` says when. */
const LONG_AGO = new Date('2020-01-06T04:30:00Z')

async function person(key: string, options: { role?: string; reportsTo?: string; mode?: 'app' | 'manual'; joined?: string; madeOn?: Date } = {}) {
  let membershipId: string | null = null
  const madeOn = options.madeOn ?? LONG_AGO
  if (options.role) {
    const user = await prisma.user.create({ data: { email: `${PREFIX}-${key}@example.com`, passwordHash: await hashPassword(PASSWORD) } })
    users[key] = user.id
    membershipId = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: options.role, status: 'active', createdAt: madeOn } })).id
  }
  const e = await prisma.employee.create({
    data: {
      organizationId: orgId,
      ...(membershipId ? { memberships: { connect: { id: membershipId } } } : {}),
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key[0]!.toUpperCase()}${key.slice(1)} Test`,
      dateOfJoining: toDateColumn(options.joined ?? '2020-01-06'),
      onboardedOn: toDateColumn('2020-01-06'),
      confirmedOn: toDateColumn('2020-01-06'),
      reportingManagerId: options.reportsTo ?? null,
      attendanceMode: options.mode ?? 'app',
      shiftId,
      createdAt: madeOn,
    },
  })
  emp[key] = e.id
  if (options.role) tokens[key] = (await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-${key}@example.com`, password: PASSWORD })).body.data.accessToken
  for (const leaveYear of new Set([yearOf(today), yearOf(MON)])) {
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: e.id, leaveTypeId: clId, leaveYear, days: 12, reason: 'opening_grant' } })
  }
  return e.id
}

const as = (key: string) => `Bearer ${tokens[key]}`
const send = (key: string, method: 'get' | 'post' | 'put' | 'delete', path: string, body: object = {}) =>
  method === 'get' ? request(app).get(`/api${path}`).set('Authorization', as(key)) : request(app)[method](`/api${path}`).set('Authorization', as(key)).send(body)
const dayOf = async (key: string, date: CalendarDate) => prisma.attendance.findFirst({ where: { employeeId: emp[key]!, date: toDateColumn(date) } })
const run = () => reconcileAbsent(forOrg(orgId), orgId, { apply: true, trigger: 'test' })
const ruleOn = (from: CalendarDate, on = true) =>
  prisma.organization.update({ where: { id: orgId }, data: { absentWithoutCheckIn: on, absentWithoutCheckInFrom: toDateColumn(from), absentWaitDays: 3 } })

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: TZ } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4 } })
  await prisma.workWeek.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), weeklyOffDays: [0] } })
  clId = (await prisma.leaveType.create({ data: { organizationId: orgId, code: 'CL', name: 'Casual Leave', annualQuota: 12 } })).id
  shiftId = (await prisma.shift.create({ data: { organizationId: orgId, name: 'General', startTime: '10:00', endTime: '19:00', expectedHours: 9 } })).id

  // A role that marks days and does not correct them, as the Super Admin could make one.
  const top = await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'super_admin' } })
  await prisma.role.create({
    data: { organizationId: orgId, key: 'marker', name: 'Marker', parentId: top.id, permissions: ['dashboard:read', 'employee:read', 'attendance:read', 'attendance:mark'], scopes: { employee: 'ORGANIZATION', attendance: 'ORGANIZATION' } },
  })
  // …and one that marks its own team only.
  await prisma.role.create({
    data: { organizationId: orgId, key: 'teammarker', name: 'Team Marker', parentId: top.id, permissions: ['dashboard:read', 'employee:read', 'attendance:read', 'attendance:mark'], scopes: { employee: 'ORGANIZATION', attendance: 'DIRECT_REPORTS' } },
  })

  await person('boss', { role: 'super_admin' })
  await person('hema', { role: 'hr' })
  const manoj = await person('manoj', { role: 'manager' })
  await person('priya', { role: 'employee', reportsTo: manoj })
  await person('ravi', { role: 'employee', reportsTo: manoj })
  await person('sunil', { role: 'employee', reportsTo: manoj, mode: 'manual' })
  await person('mark', { role: 'marker' })
  await person('lead', { role: 'teammarker' })
  // Added to EMS only today, with a joining day three weeks back — and one on the app with no login at all.
  await person('late', { role: 'employee', reportsTo: manoj, joined: MON, madeOn: new Date() })
  await person('nologin', { reportsTo: manoj, joined: MON })
  // Joined yesterday: checked in and never out — for the reminder.
  await person('nina', { role: 'employee', reportsTo: manoj, joined: yesterday })
  await person('emp', { role: 'employee', reportsTo: manoj })

  // Priya's week: a punch on Monday, HR's absent on Wednesday, half a day of
  // leave on Thursday; Friday is a holiday for everybody.
  const punchIn = new Date(`${MON}T04:30:00Z`)
  await prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp.priya!, date: toDateColumn(MON), checkIn: punchIn, checkOut: new Date(`${MON}T13:30:00Z`), status: 'present', source: 'punch', hoursWorked: 9 } })
  await prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp.priya!, date: toDateColumn(WED), status: 'absent', source: 'manual' } })
  await prisma.leaveRequest.create({ data: { organizationId: orgId, employeeId: emp.priya!, leaveTypeId: clId, fromDate: toDateColumn(THU), toDate: toDateColumn(THU), halfDayDates: [THU], days: 0.5, leaveYear: yearOf(THU), reason: 'x', status: 'approved' } })
  await prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp.priya!, date: toDateColumn(THU), status: 'on_leave', source: 'leave' } })
  await prisma.holiday.create({ data: { organizationId: orgId, date: toDateColumn(FRI), name: 'A festival', type: 'public' } })
  // Nina checked in on the app yesterday and never out — just after yesterday's midnight, so her
  // day is over whenever this runs: a day checked in at ten could still be closed until six this
  // morning (a long day runs past midnight, never past twenty hours), and read "not over" before then.
  await prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp.nina!, date: toDateColumn(yesterday), checkIn: new Date(`${yesterday}T00:30:00+05:30`), status: 'present', source: 'punch' } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the rule switched off', () => {
  it('writes nothing: a day with nothing in it stays not marked', async () => {
    const result = await run()
    expect(result).toMatchObject({ marked: 0, removed: 0 })
    expect(await dayOf('ravi', TUE)).toBeNull()
  })
})

describe('the nightly run, from a Monday three weeks back', () => {
  beforeAll(async () => {
    await ruleOn(MON)
  })

  it('marks a working day with nothing in it Absent — "no check-in" — and nothing else', async () => {
    const result = await run()
    expect(result.marked).toBeGreaterThan(0)

    const tuesday = await dayOf('priya', TUE)
    expect(tuesday).toMatchObject({ status: 'absent', source: 'system', note: 'No check-in' })
    // Her punch, HR's absent, her holiday stand as they were.
    expect(await dayOf('priya', MON)).toMatchObject({ status: 'present', source: 'punch' })
    expect(await dayOf('priya', WED)).toMatchObject({ status: 'absent', source: 'manual' })
    expect(await dayOf('priya', FRI)).toBeNull()
    // Sunday is a weekly off; Saturday works.
    expect(await dayOf('ravi', addCalendarDays(MON, 6))).toBeNull()
    expect(await dayOf('ravi', SAT)).toMatchObject({ source: 'system' })
    // Somebody marked by HR is judged too, once the days of waiting are past.
    expect(await dayOf('sunil', TUE)).toMatchObject({ source: 'system' })
    // Nothing before the rule starts, nothing before one joined.
    expect(await dayOf('ravi', addCalendarDays(MON, -1))).toBeNull()
    expect(await prisma.attendance.count({ where: { employeeId: emp.nina!, source: 'system' } })).toBe(0)
  })

  it('never judges a day before somebody’s record was made, nor anybody on the app with no login', async () => {
    // Added today with a joining day gone by: they could not have checked in on those days.
    expect(await prisma.attendance.count({ where: { employeeId: emp.late!, source: 'system' } })).toBe(0)
    expect(await prisma.attendance.count({ where: { employeeId: emp.nologin!, source: 'system' } })).toBe(0)
  })

  it('makes half a day of leave with no punch Absent for the other half, keeping what it was', async () => {
    expect(await dayOf('priya', THU)).toMatchObject({ status: 'absent', source: 'leave', statusBeforeSystem: 'on_leave' })
  })

  it('tells each person, with the way to undo it', async () => {
    const told = await prisma.notification.findMany({ where: { userId: users.ravi!, event: 'attendance.absent' } })
    expect(told.length).toBeGreaterThan(0)
    expect(told[0]!.message).toMatch(/no check-in/)
    expect(told[0]!.message).toMatch(/attendance correction/)
  })

  it('changes nothing the second time, and tells nobody again', async () => {
    const before = await prisma.notification.count({ where: { organizationId: orgId, event: 'attendance.absent' } })
    expect(await run()).toMatchObject({ marked: 0, removed: 0 })
    expect(await prisma.notification.count({ where: { organizationId: orgId, event: 'attendance.absent' } })).toBe(before)
  })

  it('is written in the audit log as a system job', async () => {
    const row = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'attendance.absent_rule' } })
    expect(row?.actorUserId).toBeNull()
    expect(row?.details).toMatchObject({ trigger: 'test' })
  })

  it('cuts the day from pay, as payroll will', async () => {
    const res = await send('hema', 'get', `/attendance/people/${emp.ravi}/month?year=${monthOfDay(MON).year}&month=${monthOfDay(MON).month}`)
    expect(res.status).toBe(200)
    expect(res.body.data.pay_days.unpaid_days).toBeGreaterThan(0)
    const tue = res.body.data.days.find((d: { date: string }) => d.date === TUE)
    expect(tue).toMatchObject({ status: 'absent', no_check_in: true })
  })
})

describe('one answer for every role (client, 25 Oct 2026: "consistency rhna jaruri hai")', () => {
  it('the Super Admin, HR, the manager, a custom role and the person themselves read the same day the same way', async () => {
    const { year, month } = monthOfDay(MON)
    const dayAs = async (key: string) => {
      const res = await send(key, 'get', `/attendance/people/${emp.ravi}/month?year=${year}&month=${month}`)
      expect(res.status, `${key}: ${JSON.stringify(res.body)}`).toBe(200)
      const day = res.body.data.days.find((d: { date: string }) => d.date === SAT)
      return { status: day?.status, no_check_in: day?.no_check_in, unpaid: res.body.data.pay_days.unpaid_days, off: res.body.data.days_off.map((d: { date: string }) => d.date) }
    }
    const seen = await Promise.all(['boss', 'hema', 'manoj', 'mark', 'ravi'].map(dayAs))
    expect(seen[0]).toMatchObject({ status: 'absent', no_check_in: true })
    for (const other of seen.slice(1)) expect(other).toEqual(seen[0])
    // A login reaching nobody else is refused, rather than shown a different answer.
    expect((await send('emp', 'get', `/attendance/people/${emp.ravi}/month?year=${year}&month=${month}`)).status).toBe(404)
  })
})

describe('what people do wins', () => {
  it('leave approved for the day takes it over; reversed, the day is Absent again', async () => {
    const applied = await send('ravi', 'post', '/leave-requests', { leaveTypeId: clId, fromDate: TUE, toDate: TUE, reason: 'Was unwell' })
    expect(applied.status, JSON.stringify(applied.body)).toBe(201)
    expect((await send('manoj', 'post', `/leave-requests/${applied.body.data.id}/approve`)).status).toBe(200)
    // The rule's note goes with its Absent.
    expect(await dayOf('ravi', TUE)).toMatchObject({ status: 'on_leave', source: 'leave', note: null })
    // The run leaves the leave alone.
    await run()
    expect(await dayOf('ravi', TUE)).toMatchObject({ status: 'on_leave' })

    expect((await send('manoj', 'post', `/leave-requests/${applied.body.data.id}/reverse`)).status).toBe(200)
    expect(await dayOf('ravi', TUE)).toMatchObject({ status: 'absent', source: 'system', note: 'No check-in' })
  })

  it('a holiday added on the day takes the Absent back at once', async () => {
    expect(await dayOf('ravi', WED)).toMatchObject({ source: 'system' })
    const added = await send('hema', 'post', '/holidays', { date: WED, name: 'Declared off', type: 'public' })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    expect(await dayOf('ravi', WED)).toBeNull()
    // HR's own absent on that day is HR's, and stays.
    expect(await dayOf('priya', WED)).toMatchObject({ source: 'manual' })
  })

  it('a role that only marks may mark over it — it is nobody’s record of the day', async () => {
    const res = await send('mark', 'post', '/attendance/mark', { employeeId: emp.ravi, date: THU, status: 'present', note: 'Was at a client' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await dayOf('ravi', THU)).toMatchObject({ status: 'present', source: 'manual', statusBeforeSystem: null })
    await run()
    expect(await dayOf('ravi', THU)).toMatchObject({ status: 'present', source: 'manual' })
  })
})

describe('marking the people ticked', () => {
  it('marks only those ticked, and leaves out a day with a check-in — its times are its evidence', async () => {
    const res = await send('hema', 'post', '/attendance/mark-many', { date: MON, employeeIds: [emp.ravi, emp.priya], status: 'present', note: 'The app was down' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.marked).toEqual([emp.ravi])
    expect(res.body.data.refused).toEqual([{ employee_id: emp.priya, reason: expect.stringMatching(/Checked in that day/) }])
    expect(await dayOf('ravi', MON)).toMatchObject({ status: 'present', source: 'manual', note: 'The app was down' })
    expect(await dayOf('priya', MON)).toMatchObject({ source: 'punch' })
    // Sunil was not ticked: his day is as it was.
    expect(await dayOf('sunil', MON)).toMatchObject({ source: 'system' })
  })

  it('says nothing of a day outside one’s reach — "not found", not whether they checked in', async () => {
    const res = await send('lead', 'post', '/attendance/mark-many', { date: MON, employeeIds: [emp.priya], status: 'present', note: 'Trying' })
    expect(res.status).toBe(200)
    expect(res.body.data.refused).toEqual([{ employee_id: emp.priya, reason: 'Employee not found' }])
  })

  it('wants a reason, refuses "on leave", and is not for an employee', async () => {
    expect((await send('hema', 'post', '/attendance/mark-many', { date: MON, employeeIds: [emp.sunil], status: 'present', note: '' })).status).toBe(422)
    expect((await send('hema', 'post', '/attendance/mark-many', { date: MON, employeeIds: [emp.sunil], status: 'on_leave', note: 'Leave' })).status).toBe(422)
    expect((await send('emp', 'post', '/attendance/mark-many', { date: MON, employeeIds: [emp.sunil], status: 'present', note: 'Me' })).status).toBe(403)
  })
})

describe('the setting', () => {
  it('reads the rule, for the Super Admin only', async () => {
    const res = await send('boss', 'get', '/settings/absent-rule')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ on: true, from: MON, wait_days: 3, today })
    expect((await send('emp', 'get', '/settings/absent-rule')).status).toBe(403)
  })

  it('previews without writing anything', async () => {
    const before = await prisma.attendance.count({ where: { organizationId: orgId, source: 'system' } })
    const res = await send('boss', 'post', '/settings/absent-rule/preview', { on: false, from: MON, waitDays: 3 })
    expect(res.status).toBe(200)
    expect(res.body.data.removed).toBeGreaterThan(0)
    expect(await prisma.attendance.count({ where: { organizationId: orgId, source: 'system' } })).toBe(before)
  })

  it('keeps a start older than the 1st of last month while the rule stays on — and not once it is switched back on', async () => {
    await ruleOn('2020-01-06')
    // Only the wait changes: the old start stands.
    expect((await send('boss', 'post', '/settings/absent-rule/preview', { on: true, from: '2020-01-06', waitDays: 5 })).status).toBe(200)
    await prisma.organization.update({ where: { id: orgId }, data: { absentWithoutCheckIn: false } })
    // Switched back on, it starts again: not from 2020.
    expect((await send('boss', 'post', '/settings/absent-rule/preview', { on: true, from: '2020-01-06', waitDays: 3 })).status).toBe(400)
    await ruleOn(MON)
  })

  it('refuses a start before the 1st of last month, and a wait of none', async () => {
    const earliest = (await send('boss', 'get', '/settings/absent-rule')).body.data.earliest_from as string
    expect((await send('boss', 'put', '/settings/absent-rule', { on: true, from: addCalendarDays(earliest, -1), waitDays: 3 })).status).toBe(400)
    expect((await send('boss', 'put', '/settings/absent-rule', { on: true, from: MON, waitDays: 0 })).status).toBe(422)
  })

  it('switched off, gives back everything it wrote — and puts the half-day leave back', async () => {
    const res = await send('boss', 'put', '/settings/absent-rule', { on: false, from: MON, waitDays: 3 })
    expect(res.status).toBe(200)
    expect(res.body.data.run.removed).toBeGreaterThan(0)
    expect(await prisma.attendance.count({ where: { organizationId: orgId, source: 'system' } })).toBe(0)
    expect(await dayOf('priya', THU)).toMatchObject({ status: 'on_leave', statusBeforeSystem: null })
    // What people wrote stays.
    expect(await dayOf('ravi', MON)).toMatchObject({ source: 'manual' })
  })

  it('never touches a month whose payroll is approved', async () => {
    const { year, month } = monthOfDay(MON)
    await prisma.payrollRun.create({
      data: {
        organizationId: orgId, year, month, status: 'approved', lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 0,
        grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0, calculatedAt: new Date(),
      },
    })
    try {
      const res = await send('boss', 'put', '/settings/absent-rule', { on: true, from: MON, waitDays: 3 })
      expect(res.status).toBe(200)
      expect(res.body.data.run.closed_months).toContain(`${year}-${String(month).padStart(2, '0')}`)
      expect(await dayOf('ravi', TUE)).toBeNull()
    } finally {
      await prisma.payrollRun.deleteMany({ where: { organizationId: orgId } })
    }
  })

  it('is written in the audit log as the Super Admin’s change', async () => {
    const row = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'absent_rule.updated' }, orderBy: { createdAt: 'desc' } })
    expect(row?.actorUserId).toBe(users.boss)
  })
})

describe('the roster and the check-out reminder', () => {
  it('says whose day is over', async () => {
    const res = await send('hema', 'get', `/attendance/day?date=${yesterday}`)
    expect(res.status).toBe(200)
    const nina = res.body.data.employees.find((e: { employee_id: string }) => e.employee_id === emp.nina)
    // In and never out, no longer her day: "No out" — the one rule the roster and its export use.
    expect(nina).toMatchObject({ day_over: true, no_out: true })
    expect(nina.attendance).toMatchObject({ check_out: null })
    expect(res.body.data.day_off).toBe(weekdayOf(yesterday) === 0)
  })

  it('says a holiday is a day off, so nobody reads "no check-in" on it', async () => {
    const res = await send('hema', 'get', `/attendance/day?date=${FRI}`)
    expect(res.body.data.day_off).toBe(true)
    const csv = await send('hema', 'get', `/attendance/export?date=${yesterday}&status=no_out`)
    expect(csv.status).toBe(200)
    expect(csv.text).toContain('Nina Test')
    expect(csv.text).not.toContain('Ravi Test')
  })

  it('expects no hours of a day in and never out, on the month’s hours table as on the person’s page', async () => {
    const { year, month } = monthOfDay(yesterday)
    const res = await send('hema', 'get', `/attendance/monthly-summary?year=${year}&month=${month}`)
    expect(res.status).toBe(200)
    const nina = res.body.data.employees.find((e: { employee_uuid: string }) => e.employee_uuid === emp.nina)
    expect(nina).toMatchObject({ days_present: 1, expected_hours: 0 })
  })

  it('tells somebody in and never out, once, two hours after the shift', async () => {
    const first = await nudgeCheckOuts(forOrg(orgId), orgId, { apply: true })
    expect(first.told).toBeGreaterThanOrEqual(1)
    const told = await prisma.notification.findMany({ where: { userId: users.nina!, event: 'attendance.no_check_out' } })
    expect(told).toHaveLength(1)
    expect((await dayOf('nina', yesterday))?.checkOutNudgedAt).not.toBeNull()
    expect((await nudgeCheckOuts(forOrg(orgId), orgId, { apply: true })).told).toBe(0)
    expect(await prisma.notification.count({ where: { userId: users.nina!, event: 'attendance.no_check_out' } })).toBe(1)
    // The day stays present.
    expect(fromDateColumn((await dayOf('nina', yesterday))!.date)).toBe(yesterday)
    expect(await dayOf('nina', yesterday)).toMatchObject({ status: 'present' })
  })
})

describe('a change of the working week', () => {
  it('takes back the Absent on a Saturday that becomes a weekly off — at once', async () => {
    await ruleOn(MON)
    await run()
    const thisMonth = `${today.slice(0, 7)}-01`
    let saturday: CalendarDate | null = null
    for (let d = thisMonth; d < today; d = addCalendarDays(d, 1)) if (weekdayOf(d) === 6) saturday = d
    if (thisMonth === today || !saturday) return // No Saturday of this month gone by yet.
    expect(await dayOf('ravi', saturday)).toMatchObject({ source: 'system' })
    const res = await send('boss', 'put', '/settings/work-week', { weeklyOffDays: [0, 6], from: thisMonth })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await dayOf('ravi', saturday)).toBeNull()
  })
})
