import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { accruedBy } from '../../domain/leave/grant'
import { daysInMonth } from '../../domain/payroll/salary'
import { addCalendarDays, monthOfDay, toDateColumn, zonedToday, type CalendarDate } from '../../domain/shared/dates'

/**
 * The rules and extras the client's document asks for beyond the first
 * version, through the API: shift rules (§34), overtime from work to pay
 * (§35), a leave type's own rules and encashment (§36–37), salary components
 * and loans (§40), the reports and notices that go with them (§45–47).
 *
 * Last month is the month worked — over, and not yet paid — so the dates move
 * with the clock; this month is the one encashment and loans are paid in.
 *
 *   boss (Super Admin) ── mgr (Manager) ── emp (Employee)
 *   hr (HR), acc (Accounts): logins without an employee record
 */

const PREFIX = 'v1x'
const PASSWORD = 'CorrectHorseBattery1'
const TZ = 'Asia/Kolkata'
const app = createApp()

type Who = 'boss' | 'mgr' | 'emp' | 'hr' | 'acc'
const ROLES: Record<Who, string> = { boss: 'super_admin', mgr: 'manager', emp: 'employee', hr: 'hr', acc: 'accounts' }

let orgId = ''
let shiftId = ''
const emp = {} as Record<'mgr' | 'emp', string>
const users = {} as Record<Who, string>
const tokens = {} as Record<Who, string>
const component = {} as Record<string, string>
const email = (who: string) => `${PREFIX}-${who}@example.com`

const as = (who: Who) => `Bearer ${tokens[who]}`
const get = (who: Who, url: string) => request(app).get(url).set('Authorization', as(who))
const post = (who: Who, url: string, body: object = {}) => request(app).post(url).set('Authorization', as(who)).send(body)
const put = (who: Who, url: string, body: object) => request(app).put(url).set('Authorization', as(who)).send(body)
const patch = (who: Who, url: string, body: object) => request(app).patch(url).set('Authorization', as(who)).send(body)
const del = (who: Who, url: string) => request(app).delete(url).set('Authorization', as(who))

const today = zonedToday(new Date(), TZ)
const thisMonth = monthOfDay(today)
const lastMonth = thisMonth.month === 1 ? { year: thisMonth.year - 1, month: 12 } : { year: thisMonth.year, month: thisMonth.month - 1 }
const ymd = (m: { year: number; month: number }, d: number) => `${m.year}-${String(m.month).padStart(2, '0')}-${String(d).padStart(2, '0')}` as CalendarDate
/** Monday to Friday of last month's second week. */
const week = (() => {
  let d = ymd(lastMonth, 8)
  while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addCalendarDays(d, 1)
  return [0, 1, 2, 3, 4].map((i) => addCalendarDays(d, i))
})()
const [MON, TUE, WED, THU, FRI] = week as [CalendarDate, CalendarDate, CalendarDate, CalendarDate, CalendarDate]
const round2 = (n: number) => Math.round(n * 100) / 100

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.organization.updateMany({ where: { name: { startsWith: PREFIX } }, data: { ownerEmployeeId: null } })
  await prisma.emailOutbox.deleteMany({ where: org })
  await prisma.loanRecovery.deleteMany({ where: org })
  await prisma.employeeLoan.deleteMany({ where: org })
  await prisma.payslipLine.deleteMany({ where: org })
  await prisma.payslip.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employeeRequest.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.esiCoverage.deleteMany({ where: org })
  await prisma.employeeMonthlyEntry.deleteMany({ where: org })
  await prisma.employeeSalaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.employmentEvent.deleteMany({ where: org })
  await prisma.passwordResetToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } })
  await prisma.membership.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.shift.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: TZ } })).id
  // Overtime is off until a company turns it on; this one has.
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0], overtimeEnabled: true } })
  for (const c of [
    { code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    { code: 'HRA', label: 'House Rent Allowance', countsForPf: false, displayOrder: 3 },
  ]) {
    component[c.code] = (await prisma.salaryComponent.create({ data: { organizationId: orgId, ...c } })).id
  }
  shiftId = (await prisma.shift.create({ data: { organizationId: orgId, name: 'General', startTime: '09:00', endTime: '18:00', breakMinutes: 60, expectedHours: 8 } })).id

  for (const who of Object.keys(ROLES) as Who[]) {
    const user = await prisma.user.create({ data: { email: email(who), passwordHash: await hashPassword(PASSWORD) } })
    users[who] = user.id
    let employeeId: string | null = null
    if (who === 'mgr' || who === 'emp') {
      employeeId = (await prisma.employee.create({
        data: {
          organizationId: orgId,
          employeeCode: `${PREFIX}-${who}`,
          fullName: `${who} Person`,
          gender: who === 'emp' ? 'female' : 'male',
          dateOfJoining: toDateColumn('2024-01-08'),
          onboardedOn: toDateColumn('2024-01-08'),
          confirmedOn: toDateColumn('2024-07-08'),
          shiftId,
          attendanceMode: 'manual',
        },
      })).id
      emp[who] = employeeId
      await prisma.employeeStatutoryIdentity.create({ data: { organizationId: orgId, employeeId, pfApplicable: false } })
      const salary = who === 'emp' ? { BASIC: 24_000, HRA: 6_000 } : { BASIC: 40_000 }
      await prisma.employeeFinancial.create({
        data: {
          organizationId: orgId,
          employeeId,
          ctc: Object.values(salary).reduce((a, b) => a + b, 0) * 12,
          effectiveFrom: toDateColumn('2024-01-08'),
          components: { create: Object.entries(salary).map(([code, amount]) => ({ organizationId: orgId, salaryComponentId: component[code]!, amount })) },
        },
      })
    }
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: ROLES[who], status: 'active', employeeId } })
  }
  await prisma.employee.update({ where: { id: emp.emp }, data: { reportingManagerId: emp.mgr } })
  for (const who of Object.keys(ROLES) as Who[]) {
    const res = await request(app).post('/api/auth/login').send({ identifier: email(who), password: PASSWORD })
    expect(res.status, `sign in ${who}`).toBe(200)
    tokens[who] = res.body.data.accessToken
  }
}, 120_000)

afterAll(cleanup)

const dayOf = (employeeId: string, date: CalendarDate) => prisma.attendance.findFirstOrThrow({ where: { employeeId, date: toDateColumn(date) } })
const mark = (date: CalendarDate, checkIn: string, checkOut: string) =>
  post('hr', '/api/attendance/mark', { employeeId: emp.emp, date, status: 'present', checkIn, checkOut })

describe('a shift’s rules (client §34)', () => {
  it('are set on the shift, and checked', async () => {
    const res = await patch('boss', `/api/master-data/shifts/${shiftId}`, { graceMinutes: 10, lateThresholdMinutes: 120, earlyLeavingMinutes: 60, overtimeAfterMinutes: 30 })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ grace_minutes: 10, late_threshold_minutes: 120, early_leaving_minutes: 60, overtime_after_minutes: 30, min_full_day_hours: null })
    expect((await patch('boss', `/api/master-data/shifts/${shiftId}`, { minFullDayHours: 6, minHalfDayHours: 7 })).status).toBe(422)
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'master_data.changed' }, orderBy: { createdAt: 'desc' } })
    expect(audit.details).toMatchObject({ changes: { graceMinutes: 10 }, before: { graceMinutes: 0 } })
  })

  it('mark a late arrival past the grace, and make it a half day past the threshold', async () => {
    expect((await mark(MON, '09:25', '18:00')).status).toBe(201)
    expect(await dayOf(emp.emp, MON)).toMatchObject({ status: 'present', lateMinutes: 25, earlyLeavingMinutes: 0, overtimeMinutes: 0 })

    expect((await mark(TUE, '11:30', '20:00')).status).toBe(201)
    const tue = await dayOf(emp.emp, TUE)
    expect(tue).toMatchObject({ status: 'half_day', lateMinutes: 150 })
    expect(tue.note).toMatch(/Half day: arrived 2h 30m after the shift start/)
  })

  it('count overtime once past the threshold — all of it', async () => {
    expect((await mark(WED, '09:00', '19:30')).status).toBe(201)
    expect(await dayOf(emp.emp, WED)).toMatchObject({ status: 'present', overtimeMinutes: 90, lateMinutes: 0 })
    expect((await mark(THU, '09:05', '18:20')).status).toBe(201)
    expect(await dayOf(emp.emp, THU)).toMatchObject({ overtimeMinutes: 0, lateMinutes: 0 })

    const roster = await get('hr', `/api/attendance/day?date=${WED}`)
    const row = roster.body.data.employees.find((e: { employee_id: string }) => e.employee_id === emp.emp)
    expect(row.attendance).toMatchObject({ overtime_minutes: 90, late_minutes: 0 })
  })
})

describe('overtime (client §35)', () => {
  let otId = ''

  it('is claimed for a day that recorded it, at most what it recorded, once', async () => {
    expect((await post('emp', '/api/requests', { type: 'overtime', date: THU, reason: 'Stayed for the release' })).status).toBe(400)
    expect((await post('emp', '/api/requests', { type: 'overtime', date: WED, minutes: 120, reason: 'Stayed for the release' })).status).toBe(400)
    const res = await post('emp', '/api/requests', { type: 'overtime', date: WED, reason: 'Stayed for the release' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    otId = res.body.data.id
    expect(res.body.data.details).toMatchObject({ minutes: 90, recordedMinutes: 90 })
    expect((await post('emp', '/api/requests', { type: 'overtime', date: WED, minutes: 30, reason: 'Again' })).status).toBe(409)
  })

  it('is decided by the person they report to, and paid at the company’s rate once approved', async () => {
    expect((await post('hr', `/api/requests/${otId}/approve`)).status).toBe(403)
    expect((await post('mgr', `/api/requests/${otId}/approve`)).status).toBe(200)

    const calc = await post('acc', '/api/payroll/calculate', { employeeId: emp.emp, ...lastMonth })
    expect(calc.status, JSON.stringify(calc.body)).toBe(200)
    // 1.5 hours × (₹30,000 ÷ the month's days ÷ 8 hours) × 2.
    const expected = round2(1.5 * (30_000 / daysInMonth(lastMonth.year, lastMonth.month) / 8) * 2)
    expect(calc.body.data.earnings.find((e: { code: string }) => e.code === 'OT')?.amount).toBe(expected)
    expect(calc.body.data.basis.overtime).toMatchObject({ minutes: 90, rate: 2, basis: 'gross', amount: expected })
  })

  it('has its rate, basis and switch in the payroll settings', async () => {
    const res = await put('boss', '/api/settings/payroll', { overtimeRate: 1.5, overtimeBasis: 'basic', encashmentBasis: 'gross' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ overtime_enabled: true, overtime_rate: 1.5, overtime_basis: 'basic', encashment_basis: 'gross' })
    // Back as it was, so the figures below hold.
    expect((await put('boss', '/api/settings/payroll', { overtimeRate: 2, overtimeBasis: 'gross', encashmentBasis: 'basic' })).status).toBe(200)
  })
})

describe('a leave type’s rules (client §36–37)', () => {
  let pl = ''
  const leaveYear = thisMonth.month >= 4 ? thisMonth.year : thisMonth.year - 1
  // A Monday at least three weeks away, so notice of ten days is easy to give.
  const ahead = (() => {
    let d = addCalendarDays(today, 21)
    while (new Date(`${d}T00:00:00Z`).getUTCDay() !== 1) d = addCalendarDays(d, 1)
    return d
  })()

  beforeAll(async () => {
    const res = await post('hr', '/api/settings/leave-types', {
      name: 'Privilege Leave', code: 'PL', annualQuota: 12, accrual: 'monthly', minNoticeDays: 10, maxDaysPerRequest: 3, halfDayAllowed: true,
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    pl = res.body.data.id
    expect(res.body.data).toMatchObject({ accrual: 'monthly', min_notice_days: 10, max_days_per_request: 3 })
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp.emp, leaveTypeId: pl, leaveYear, days: 12, reason: 'opening_grant' } })
  })

  const preview = (body: object) => post('emp', '/api/leave-requests/preview', { leaveTypeId: pl, ...body })

  it('ask for notice, and cap one application', async () => {
    const soon = await preview({ fromDate: addCalendarDays(today, 1), toDate: addCalendarDays(today, 1) })
    expect(soon.body.data.problem?.reason).toBe('short_notice')
    const long = await preview({ fromDate: ahead, toDate: addCalendarDays(ahead, 3) })
    expect(long.body.data.problem?.reason).toBe('too_long')
  })

  it('make a monthly type available a twelfth a month, by the month the leave starts', async () => {
    const res = await preview({ fromDate: ahead, toDate: addCalendarDays(ahead, 1) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const earned = accruedBy({ grant: 12, leaveYear, startMonth: 4, joined: '2024-01-08', asOf: ahead })
    expect(res.body.data.balance.available).toBe(earned)
    const mine = await get('emp', '/api/leave-requests/balances')
    const row = mine.body.data.balances.find((b: { leave_type_id: string }) => b.leave_type_id === pl)
    expect(row).toMatchObject({ accrual: 'monthly', unearned: 12 - accruedBy({ grant: 12, leaveYear, startMonth: 4, joined: '2024-01-08', asOf: today }) })
  })

  it('keep a type to the gender it is for', async () => {
    const res = await post('hr', '/api/settings/leave-types', { name: 'Maternity Leave', code: 'ML', annualQuota: 0, eligibleGender: 'female', countsNonWorkingDays: true })
    expect(res.status).toBe(201)
    const mine = await post('mgr', '/api/leave-requests/preview', { leaveTypeId: res.body.data.id, fromDate: ahead, toDate: ahead })
    expect(mine.body.data.problem).toMatchObject({ reason: 'not_eligible', message: 'Maternity Leave is for women only.' })
  })

  it('record which half of a half day is taken', async () => {
    const res = await post('emp', '/api/leave-requests', {
      leaveTypeId: pl, fromDate: ahead, toDate: addCalendarDays(ahead, 1), halfDayDates: [ahead], halfDaySessions: { [ahead]: 'second_half' }, reason: 'Family function',
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({ days: 1.5, half_day_sessions: { [ahead]: 'second_half' } })
    const wrong = await post('emp', '/api/leave-requests/preview', { leaveTypeId: pl, fromDate: ahead, toDate: ahead, halfDaySessions: { [addCalendarDays(ahead, 1)]: 'first_half' } })
    expect(wrong.status).toBe(400)
  })
})

describe('leave encashment (client §36)', () => {
  let el = ''
  const leaveYear = thisMonth.month >= 4 ? thisMonth.year : thisMonth.year - 1

  beforeAll(async () => {
    const res = await post('hr', '/api/settings/leave-types', { name: 'Earned Leave', code: 'EL', annualQuota: 12, encashable: true, encashMaxDaysPerYear: 5 })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    el = res.body.data.id
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp.emp, leaveTypeId: el, leaveYear, days: 12, reason: 'opening_grant' } })
  })

  it('is refused for a type that is not encashable, or past the yearly cap', async () => {
    const cl = await post('hr', '/api/settings/leave-types', { name: 'Casual Leave', code: 'CL', annualQuota: 6 })
    expect((await post('emp', '/api/requests', { type: 'leave_encashment', leaveTypeId: cl.body.data.id, days: 1, reason: 'Need the money' })).status).toBe(400)
    const over = await post('emp', '/api/requests', { type: 'leave_encashment', leaveTypeId: el, days: 6, reason: 'Need the money' })
    expect(over.status).toBe(400)
    expect(over.body.error.message).toMatch(/At most 5 days of Earned Leave/)
  })

  it('goes to HR, takes the days off the balance, and is paid with this month’s salary', async () => {
    const sent = await post('emp', '/api/requests', { type: 'leave_encashment', leaveTypeId: el, days: 3, reason: 'School fees' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect(sent.body.data.decided_by_whom).toBe('HR, who keeps leave balances')
    expect((await post('mgr', `/api/requests/${sent.body.data.id}/approve`)).status).toBe(404)
    const ok = await post('hr', `/api/requests/${sent.body.data.id}/approve`)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data.details).toMatchObject({ days: 3, payYear: thisMonth.year, payMonth: thisMonth.month })

    const ledger = await prisma.leaveLedgerEntry.findFirstOrThrow({ where: { employeeId: emp.emp, leaveTypeId: el, reason: 'encashed' } })
    expect(Number(ledger.days)).toBe(-3)

    const calc = await post('acc', '/api/payroll/calculate', { employeeId: emp.emp, ...thisMonth })
    expect(calc.status, JSON.stringify(calc.body)).toBe(200)
    // Three days of Basic (the default basis), over the month's days.
    const expected = round2(3 * (24_000 / daysInMonth(thisMonth.year, thisMonth.month)))
    expect(calc.body.data.earnings.find((e: { code: string }) => e.code === 'LEAVE_ENC')?.amount).toBe(expected)
  })
})

describe('salary components (client §40)', () => {
  let site = ''

  it('are the accountant’s to add, never with a code payroll writes itself', async () => {
    expect((await post('hr', '/api/payroll/components', { code: 'SITE', label: 'Site Allowance' })).status).toBe(403)
    expect((await post('acc', '/api/payroll/components', { code: 'OT', label: 'Overtime' })).status).toBe(400)
    const res = await post('acc', '/api/payroll/components', { code: 'site', label: 'Site Allowance', entry: 'monthly' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    site = res.body.data.id
    expect(res.body.data).toMatchObject({ code: 'SITE', type: 'earning', entry: 'monthly', counts_for_esi: true, counts_for_pt: true, archived: false })
  })

  it('keep their kind once somebody is paid them, and are archived only when nothing uses them', async () => {
    expect((await patch('acc', `/api/payroll/components/${component.BASIC}`, { entry: 'monthly' })).status).toBe(409)
    expect((await del('acc', `/api/payroll/components/${component.HRA}`)).status).toBe(409)
    const changed = await patch('acc', `/api/payroll/components/${site}`, { countsForEsi: false, label: 'Site allowance' })
    expect(changed.status).toBe(200)
    expect(changed.body.data).toMatchObject({ counts_for_esi: false, label: 'Site allowance' })
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'salary_component.updated' } })
    expect(audit.details).toMatchObject({ before: { countsForEsi: true, label: 'Site Allowance' } })

    expect((await del('acc', `/api/payroll/components/${site}`)).body.data.archived).toBe(true)
    const back = await post('acc', '/api/payroll/components', { code: 'SITE', label: 'Site Allowance', entry: 'monthly' })
    expect(back.status).toBe(200)
    expect(back.body.meta.restored).toBe(true)
  })
})

describe('loans and advances (client §40)', () => {
  let loan = ''
  let advance = ''

  it('are recorded by Accounts, and recovered a month at a time', async () => {
    expect((await post('hr', '/api/payroll/loans', { employeeId: emp.emp, kind: 'loan', amount: 10_000, installment: 4_000, ...{ startYear: thisMonth.year, startMonth: thisMonth.month } })).status).toBe(403)
    expect((await post('acc', '/api/payroll/loans', { employeeId: emp.emp, kind: 'loan', amount: 1_000, installment: 4_000, startYear: thisMonth.year, startMonth: thisMonth.month })).status).toBe(400)
    const res = await post('acc', '/api/payroll/loans', { employeeId: emp.emp, kind: 'loan', amount: 10_000, installment: 4_000, startYear: thisMonth.year, startMonth: thisMonth.month, note: 'Two-wheeler' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    loan = res.body.data.id
    expect(res.body.data).toMatchObject({ status: 'active', left: 10_000, recovered: 0 })

    const calc = await post('acc', '/api/payroll/calculate', { employeeId: emp.emp, ...thisMonth })
    expect(calc.body.data.deductions.find((d: { code: string }) => d.code === 'LOAN')?.amount).toBe(4_000)
    expect(calc.body.data.basis.loans).toEqual([{ loan_id: loan, kind: 'loan', amount: 4_000, left_after: 6_000 }])
  })

  it('stop when closed; one nothing was recovered of can be removed', async () => {
    expect((await post('acc', `/api/payroll/loans/${loan}/close`, { note: 'Repaid in cash' })).body.data.status).toBe('closed')
    const calc = await post('acc', '/api/payroll/calculate', { employeeId: emp.emp, ...thisMonth })
    expect(calc.body.data.deductions.find((d: { code: string }) => d.code === 'LOAN')).toBeUndefined()
    expect((await del('acc', `/api/payroll/loans/${loan}`)).status).toBe(204)
  })

  it('are recovered once by a payroll run, however often it is recalculated', async () => {
    const res = await post('acc', '/api/payroll/loans', { employeeId: emp.mgr, kind: 'advance', amount: 5_000, installment: 5_000, startYear: lastMonth.year, startMonth: lastMonth.month })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    advance = res.body.data.id

    // A correction still waiting is said before payroll is approved.
    const waiting = await post('emp', '/api/requests', { type: 'attendance_correction', date: FRI, checkIn: '09:00', checkOut: '18:00', reason: 'Forgot to mark' })
    expect(waiting.status).toBe(201)

    const run = await post('acc', '/api/payroll-runs', lastMonth)
    expect(run.status, JSON.stringify(run.body)).toBe(201)
    const slips = run.body.data.payslips as { id: string; employee_id: string; warnings: string[] }[]
    const mgrSlip = await get('acc', `/api/payroll-runs/${run.body.data.id}/payslips/${slips.find((s) => s.employee_id === emp.mgr)!.id}`)
    expect(mgrSlip.body.data.deductions.find((d: { code: string }) => d.code === 'ADVANCE')?.amount).toBe(5_000)
    const empSlip = await get('acc', `/api/payroll-runs/${run.body.data.id}/payslips/${slips.find((s) => s.employee_id === emp.emp)!.id}`)
    expect(empSlip.body.data.earnings.find((e: { code: string }) => e.code === 'OT')).toBeTruthy()
    expect(empSlip.body.data.warnings.join(' ')).toMatch(new RegExp(`Attendance correction REQ-\\d{4} for ${FRI} is waiting`))

    expect((await post('acc', `/api/payroll-runs/${run.body.data.id}/recalculate`)).status).toBe(200)
    const list = await get('acc', '/api/payroll/loans')
    expect(list.body.data.find((l: { id: string }) => l.id === advance)).toMatchObject({ in_draft: 5_000, left: 0, status: 'repaid' })
    expect(await prisma.loanRecovery.count({ where: { loanId: advance } })).toBe(1)
    expect((await del('acc', `/api/payroll/loans/${advance}`)).status).toBe(409)
  })
})

describe('the reports (client §46)', () => {
  it('show late, early and overtime for the month', async () => {
    const res = await get('boss', `/api/reports/shift-overtime?year=${lastMonth.year}&month=${lastMonth.month}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const row = res.body.data.rows.find((r: { employee_code: string }) => r.employee_code === `${PREFIX}-emp`)
    expect(row, JSON.stringify(row)).toMatchObject({ late_days: 2, overtime_worked: 1.5, overtime_approved: 1.5, overtime_waiting: 0 })
  })

  it('each follow their own right — HR given the reports page still sees no payroll', async () => {
    const role = await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'hr' } })
    await prisma.role.update({ where: { id: role.id }, data: { permissions: [...role.permissions, 'report:read'] } })
    try {
      const pay = await get('hr', `/api/reports/payroll-summary?year=${lastMonth.year}&month=${lastMonth.month}`)
      expect(pay.status).toBe(403)
      expect(pay.body.error.message).toMatch(/needs the right to see payroll/)
      expect((await get('hr', `/api/reports/shift-overtime?year=${lastMonth.year}&month=${lastMonth.month}`)).status).toBe(200)
    } finally {
      await prisma.role.update({ where: { id: role.id }, data: { permissions: role.permissions } })
    }
  })

  it('list the requests sent in a month', async () => {
    const res = await get('boss', `/api/reports/requests?year=${thisMonth.year}&month=${thisMonth.month}`)
    expect(res.status).toBe(200)
    const kinds = res.body.data.rows.map((r: { kind: string }) => r.kind)
    expect(kinds).toEqual(expect.arrayContaining(['Overtime', 'Leave encashment', 'Attendance correction']))
  })
})

describe('notices and the audit log (client §45, §47)', () => {
  it('tell the manager and HR when somebody joins', async () => {
    const res = await post('hr', '/api/employees', { employeeCode: `${PREFIX}-new`, fullName: 'New Joiner', dateOfJoining: addCalendarDays(today, 30), reportingManagerId: emp.mgr })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(await prisma.notification.count({ where: { organizationId: orgId, userId: users.mgr, title: 'New employee added' } })).toBe(1)
    expect(await prisma.notification.count({ where: { organizationId: orgId, userId: users.hr, title: 'New employee added' } })).toBe(0)
  })

  it('keep the old and the new value of a work-record change — and only the name of a private one', async () => {
    const res = await patch('hr', `/api/employees/${emp.emp}`, { fullName: 'Emp Renamed', phone: '9811111111', workArrangement: 'hybrid' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    const row = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'employee.updated', entityId: emp.emp }, orderBy: { createdAt: 'desc' } })
    expect(row.details).toMatchObject({ changes: { fullName: { from: 'emp Person', to: 'Emp Renamed' }, workArrangement: { from: 'office', to: 'hybrid' } } })
    expect(JSON.stringify(row.details)).not.toContain('9811111111')
    const log = await get('boss', `/api/audit-log?category=people&employee=${emp.emp}`)
    expect(JSON.stringify(log.body.data.map((e: { summary?: string }) => e.summary))).toMatch(/record: name emp Person → Emp Renamed; work arrangement office → hybrid; also phone/i)
  })

  it('queue no email while the server has no mail account', async () => {
    expect(await prisma.emailOutbox.count({ where: { organizationId: orgId } })).toBe(0)
    const status = await get('boss', '/api/notifications/email-status')
    expect(status.body.data).toEqual({ ready: false, from: null })
  })
})

describe('a payroll and the decisions around it', () => {
  const SAT = addCalendarDays(FRI, 1)
  const EARLIER = addCalendarDays(MON, -2)
  let runId = ''

  beforeAll(async () => {
    for (const day of [SAT, EARLIER]) expect((await mark(day, '09:00', '19:30')).status).toBe(201)
    runId = (await get('acc', '/api/payroll-runs')).body.data.find((r: { year: number; month: number }) => r.year === lastMonth.year && r.month === lastMonth.month).id
  })

  it('keeps a recovery a draft made when its loan is closed after', async () => {
    const advance = (await get('acc', '/api/payroll/loans')).body.data.find((l: { full_name: string }) => l.full_name === 'mgr Person')
    expect((await post('acc', `/api/payroll/loans/${advance.id}/close`, { note: 'Settled' })).status).toBe(200)
    expect((await post('acc', `/api/payroll-runs/${runId}/recalculate`)).status).toBe(200)
    expect(await prisma.loanRecovery.count({ where: { loanId: advance.id } })).toBe(1)
  })

  it('is not approved while overtime approved after it was calculated is missing from it', async () => {
    const claim = await post('emp', '/api/requests', { type: 'overtime', date: SAT, reason: 'Stock count' })
    expect(claim.status, JSON.stringify(claim.body)).toBe(201)
    const ok = await post('mgr', `/api/requests/${claim.body.data.id}/approve`)
    expect(ok.body.data.details).toMatchObject({ payYear: lastMonth.year, payMonth: lastMonth.month })
    const early = await post('boss', `/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })
    // Refused: the payslips it would make now differ from the stored ones — or,
    // in the race the lock closes, because the overtime was decided after.
    expect([409, 422]).toContain(early.status)
    expect((await post('acc', `/api/payroll-runs/${runId}/recalculate`)).status).toBe(200)

    // The race the payroll lock closes: a decision saved after the calculation
    // that leaves every payslip as it was is still caught, under the lock.
    const late = await prisma.employeeRequest.create({
      data: {
        organizationId: orgId, employeeId: emp.emp, type: 'overtime', status: 'approved', fromDate: toDateColumn(SAT), toDate: toDateColumn(SAT),
        details: { minutes: 0, payYear: lastMonth.year, payMonth: lastMonth.month }, reason: 'Race', submittedByUserId: users.emp, decidedByUserId: users.mgr, decidedAt: new Date(Date.now() + 1000),
      },
    })
    const raced = await post('boss', `/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })
    expect(raced.status).toBe(409)
    expect(raced.body.error.message).toMatch(/approved after it was calculated/)
    await prisma.employeeRequest.delete({ where: { id: late.id } })

    const approved = await post('boss', `/api/payroll-runs/${runId}/approve`, { confirmAssumedDays: true })
    expect(approved.status, JSON.stringify(approved.body)).toBe(200)
  })

  it('pays overtime on a day of a signed-off month with the next month still open', async () => {
    const claim = await post('emp', '/api/requests', { type: 'overtime', date: EARLIER, reason: 'Audit visit' })
    expect(claim.status, JSON.stringify(claim.body)).toBe(201)
    const ok = await post('mgr', `/api/requests/${claim.body.data.id}/approve`)
    expect(ok.status, JSON.stringify(ok.body)).toBe(200)
    expect(ok.body.data.details).toMatchObject({ payYear: thisMonth.year, payMonth: thisMonth.month })
    const calc = await post('acc', '/api/payroll/calculate', { employeeId: emp.emp, ...thisMonth })
    expect(calc.body.data.basis.overtime).toMatchObject({ minutes: 90 })
  })
})

describe('somebody who has left', () => {
  it('cannot be paid an encashment after their last payroll is approved, and leaving closes what waits', async () => {
    // Their last working day was in last month, whose payroll is approved above.
    await prisma.employee.update({ where: { id: emp.emp }, data: { lastWorkingDate: toDateColumn(ymd(lastMonth, daysInMonth(lastMonth.year, lastMonth.month))) } })
    const el = (await prisma.leaveType.findFirstOrThrow({ where: { organizationId: orgId, code: 'EL' } })).id
    const sent = await post('emp', '/api/requests', { type: 'leave_encashment', leaveTypeId: el, days: 1, reason: 'Final settlement' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const refused = await post('hr', `/api/requests/${sent.body.data.id}/approve`)
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/last payroll, .* is already approved/)

    // Removing their access closes it, with why.
    const membership = await prisma.membership.findFirstOrThrow({ where: { organizationId: orgId, employeeId: emp.emp } })
    const removed = await del('boss', `/api/users/${membership.id}`)
    expect(removed.status, JSON.stringify(removed.body)).toBeLessThan(300)
    const closed = await prisma.employeeRequest.findUniqueOrThrow({ where: { id: sent.body.data.id } })
    expect(closed).toMatchObject({ status: 'rejected', decisionNote: 'Closed: they left the company.' })
  })
})
