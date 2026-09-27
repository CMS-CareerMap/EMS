import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'

/**
 * The payroll run, end to end: records in, payslips out.
 *
 * August 2026 throughout — a month that is over, so nothing in it is "not yet",
 * and one with 31 days: Saturday the 1st, Sundays on the 2nd, 9th, 16th, 23rd
 * and 30th. Every figure is worked out beside the assertion.
 *
 * Each scenario gets its own company, because a run takes EVERYBODY employed
 * in the month — one company per story is what keeps one test's people out of
 * another's payroll.
 */

const PREFIX = 'runtest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

type Role = 'accounts' | 'hr' | 'employee'

interface Org {
  id: string
  label: string
  token: Record<Role, string>
  component: Record<string, string>
}

let seq = 0

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.payslipLine.deleteMany({ where: org })
  await prisma.payslip.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.employeeMonthlyEntry.deleteMany({ where: org })
  await prisma.employeeTdsDirective.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.esiCoverage.deleteMany({ where: org })
  await prisma.employeeSalaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.ptSlab.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

const day = (date: string) => new Date(`${date}T00:00:00Z`)

/**
 * A company with the statutory defaults, the client's components, Maharashtra
 * PT and three logins.
 *
 * The PF ceiling is pinned at ₹15,000 unless a test says otherwise: the figures
 * in these tests were worked out before the September 2026 revision. The
 * company on today's defaults has its own describe block below.
 */
async function makeOrg(
  label: string,
  policy: {
    lopBasis?: 'calendar_days' | 'fixed_30' | 'working_days'
    sandwichRule?: boolean
    pfWageCeiling?: number | null
    epsWageCeiling?: number
    tdsEnabled?: boolean
  } = {},
): Promise<Org> {
  const organization = await prisma.organization.create({
    data: { name: `${PREFIX}-${label}`, timezone: 'Asia/Kolkata' },
  })
  const id = organization.id

  // null means "leave it to the schema default". TDS is on here: these tests
  // are about the directives, and a company without TDS has its own block.
  const { pfWageCeiling = 15_000, tdsEnabled = true, ...rest } = policy
  await prisma.organizationPolicy.create({
    data: {
      organizationId: id,
      effectiveFrom: day('2020-04-01'),
      ...(pfWageCeiling === null ? {} : { pfWageCeiling }),
      tdsEnabled,
      ...rest,
    },
  })

  const component: Record<string, string> = {}
  for (const c of [
    { code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    { code: 'DA', label: 'Dearness Allowance', countsForPf: true, displayOrder: 2 },
    { code: 'HRA', label: 'House Rent Allowance', countsForPf: false, displayOrder: 3 },
    { code: 'INCENTIVE', label: 'Incentive', countsForPf: false, displayOrder: 6, entry: 'monthly' as const },
  ]) {
    component[c.code] = (await prisma.salaryComponent.create({ data: { organizationId: id, ...c } })).id
  }

  for (const slab of [
    { gender: 'male', minGross: 0, maxGross: 7500, amount: 0, februaryAmount: null },
    { gender: 'male', minGross: 7500.01, maxGross: 10000, amount: 175, februaryAmount: null },
    { gender: 'male', minGross: 10000.01, maxGross: null, amount: 200, februaryAmount: 300 },
  ] as const) {
    await prisma.ptSlab.create({ data: { organizationId: id, state: 'Maharashtra', effectiveFrom: day('2020-04-01'), ...slab } })
  }

  const token = {} as Record<Role, string>
  for (const role of ['accounts', 'hr', 'employee'] as const) {
    const email = `${PREFIX}-${label}-${role}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    await prisma.membership.create({ data: { userId: user.id, organizationId: id, role, status: 'active' } })
    const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
    token[role] = res.body.data.accessToken
  }

  return { id, label, token, component }
}

/** Somebody on the payroll, with a salary from the day they joined. */
async function hire(
  org: Org,
  options: {
    salary: Record<string, number>
    dateOfJoining?: string
    lastWorkingDate?: string
    status?: 'active' | 'inactive'
    name?: string
  },
): Promise<string> {
  seq += 1
  const joined = options.dateOfJoining ?? '2021-01-01'
  const employee = await prisma.employee.create({
    data: {
      organizationId: org.id,
      employeeCode: `${PREFIX}-${seq}`,
      fullName: options.name ?? `Person ${seq}`,
      dateOfJoining: day(joined),
      lastWorkingDate: options.lastWorkingDate ? day(options.lastWorkingDate) : null,
      status: options.status ?? 'active',
      gender: 'male',
    },
  })

  await prisma.employeeStatutoryIdentity.create({
    data: {
      organizationId: org.id,
      employeeId: employee.id,
      ptState: 'Maharashtra',
      pfApplicable: true,
      hasPriorPfMembership: true,
    },
  })

  await prisma.employeeFinancial.create({
    data: {
      organizationId: org.id,
      employeeId: employee.id,
      ctc: Object.values(options.salary).reduce((a, b) => a + b, 0) * 12,
      effectiveFrom: day(joined),
      components: {
        create: Object.entries(options.salary).map(([code, amount]) => ({
          organizationId: org.id,
          salaryComponentId: org.component[code]!,
          amount,
        })),
      },
    },
  })

  return employee.id
}

const api = (org: Org, role: Role = 'accounts') => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${org.token[role]}`),
  post: (url: string, body: object = {}) => request(app).post(url).set('Authorization', `Bearer ${org.token[role]}`).send(body),
  put: (url: string, body: object) => request(app).put(url).set('Authorization', `Bearer ${org.token[role]}`).send(body),
  delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${org.token[role]}`),
})

const AUGUST = { year: 2026, month: 8 }

async function tds(org: Org, employeeId: string, monthlyAmount: number, from = { year: 2026, month: 4 }, reason?: string) {
  const res = await api(org).put('/api/payroll/tds-directives', {
    employeeId,
    ...from,
    monthlyAmount,
    ...(reason !== undefined ? { reason } : monthlyAmount === 0 ? { reason: 'Below the taxable limit' } : {}),
  })
  expect(res.status).toBe(200)
  return res
}

async function mark(org: Org, employeeId: string, date: string, status: 'absent' | 'half_day' | 'on_leave' | 'present') {
  await prisma.attendance.create({
    data: { organizationId: org.id, employeeId, date: day(date), status, source: 'manual' },
  })
}

const payslipOf = <T extends { employee_id: string }>(run: { payslips: T[] }, employeeId: string) =>
  run.payslips.find((slip) => slip.employee_id === employeeId)

beforeAll(async () => {
  await cleanup()
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('who may run payroll', () => {
  let org: Org

  beforeAll(async () => {
    org = await makeOrg('access')
    const id = await hire(org, { salary: { BASIC: 20_000 } })
    await tds(org, id, 0)
  })

  it('refuses HR and an employee, per the client matrix', async () => {
    for (const role of ['hr', 'employee'] as const) {
      expect((await api(org, role).post('/api/payroll-runs', AUGUST)).status).toBe(403)
      expect((await api(org, role).get('/api/payroll-runs')).status).toBe(403)
      expect((await api(org, role).get('/api/payroll-runs/readiness?year=2026&month=8')).status).toBe(403)
    }
  })

  it('refuses a month that has not started — nothing in it has been worked', async () => {
    const res = await api(org).post('/api/payroll-runs', { year: 2030, month: 1 })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/has not started/)
  })

  it('refuses a body with anything it does not expect', async () => {
    expect((await api(org).post('/api/payroll-runs', { ...AUGUST, force: true })).status).toBe(422)
    expect((await api(org).post('/api/payroll-runs', { year: 2026, month: 13 })).status).toBe(422)
  })

  it('refuses a month nobody was employed in', async () => {
    const empty = await makeOrg('empty')
    const res = await api(empty).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('BUSINESS_RULE')
  })
})

describe('a month of payroll', () => {
  let org: Org
  const who: Record<string, string> = {}
  let run: {
    id: string
    status: string
    employee_count: number
    gross_earnings: number
    net_payable: number
    warnings: string[]
    payslips: { id: string; employee_id: string; lop_days: number; paid_days: number; gross_earnings: number; net_payable: number; warnings: string[] }[]
  }

  beforeAll(async () => {
    org = await makeOrg('month')

    who.standard = await hire(org, { salary: { BASIC: 20_000, DA: 2_000, HRA: 10_000 }, name: 'Standard' })
    who.lop = await hire(org, { salary: { BASIC: 20_000, DA: 2_000, HRA: 10_000 }, name: 'Absent Three Days' })
    who.unpaidLeave = await hire(org, { salary: { BASIC: 15_000 }, name: 'Unpaid Leave' })
    who.incentive = await hire(org, { salary: { BASIC: 20_000 }, name: 'Incentive' })
    who.joiner = await hire(org, { salary: { BASIC: 20_000 }, dateOfJoining: '2026-08-16', name: 'Joiner' })
    who.leaver = await hire(org, {
      salary: { BASIC: 20_000 },
      lastWorkingDate: '2026-08-10',
      status: 'inactive',
      name: 'Leaver',
    })
    who.gone = await hire(org, { salary: { BASIC: 20_000 }, status: 'inactive', name: 'Left Unrecorded' })

    // Absent Monday to Wednesday, 3–5 August.
    for (const date of ['2026-08-03', '2026-08-04', '2026-08-05']) await mark(org, who.lop!, date, 'absent')

    // Approved unpaid leave, Thursday and Friday 6–7 August, with the rows
    // approval writes.
    const lwp = await prisma.leaveType.create({
      data: { organizationId: org.id, name: 'Leave Without Pay', code: 'LWP', isPaid: false },
    })
    await prisma.leaveRequest.create({
      data: {
        organizationId: org.id,
        employeeId: who.unpaidLeave!,
        leaveTypeId: lwp.id,
        fromDate: day('2026-08-06'),
        toDate: day('2026-08-07'),
        days: 2,
        leaveYear: 2026,
        reason: 'Family',
        status: 'approved',
      },
    })
    for (const date of ['2026-08-06', '2026-08-07']) await mark(org, who.unpaidLeave!, date, 'on_leave')

    // Leave still waiting for a decision — paid leave, so it changes nothing
    // yet, but it has to be pointed out.
    const cl = await prisma.leaveType.create({
      data: { organizationId: org.id, name: 'Casual Leave', code: 'CL', isPaid: true, annualQuota: 12 },
    })
    await prisma.leaveRequest.create({
      data: {
        organizationId: org.id,
        employeeId: who.standard!,
        leaveTypeId: cl.id,
        fromDate: day('2026-08-20'),
        toDate: day('2026-08-21'),
        days: 2,
        leaveYear: 2026,
        reason: 'Travel',
        status: 'pending',
      },
    })

    // Absent Monday 10 August.
    await mark(org, who.incentive!, '2026-08-10', 'absent')
  })

  it('shows what would block a run, without writing anything', async () => {
    const res = await api(org).get('/api/payroll-runs/readiness?year=2026&month=8')
    expect(res.status).toBe(200)

    const d = res.body.data
    expect(d.blocked).toBe(true)
    expect(d.run).toBeNull()
    // Six people are paid in August; the seventh left and nobody said when.
    expect(d.employees).toHaveLength(6)
    expect(d.blockers).toHaveLength(6)
    expect(new Set(d.blockers.map((b: { code: string }) => b.code))).toEqual(new Set(['no_tds_directive']))
    expect(d.warnings.join(' ')).toMatch(/Left Unrecorded/)

    const lop = d.employees.find((e: { employee_id: string }) => e.employee_id === who.lop)
    expect(lop.lop_days).toBe(3)

    // A preview. No run, and no ESI decisions taken on its account.
    expect(await prisma.payrollRun.count({ where: { organizationId: org.id } })).toBe(0)
    expect(await prisma.esiCoverage.count({ where: { organizationId: org.id } })).toBe(0)
  })

  it('refuses to run until everybody has a TDS directive — and names every one of them', async () => {
    const res = await api(org).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('BUSINESS_RULE')
    expect(res.body.error.details.blockers).toHaveLength(6)
    expect(await prisma.payrollRun.count({ where: { organizationId: org.id } })).toBe(0)
  })

  it('refuses a ₹0 directive with no reason — a blank zero looks exactly like forgetting', async () => {
    const res = await api(org).put('/api/payroll/tds-directives', {
      employeeId: who.lop,
      year: 2026,
      month: 4,
      monthlyAmount: 0,
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/reason/)
  })

  it('keeps TDS with the accountant: HR cannot set it', async () => {
    const res = await api(org, 'hr').put('/api/payroll/tds-directives', {
      employeeId: who.standard,
      year: 2026,
      month: 4,
      monthlyAmount: 1_000,
    })
    expect(res.status).toBe(403)
  })

  it('records the directives, a correction replacing the figure it corrects', async () => {
    await tds(org, who.standard!, 1_000)
    // Corrected the same day: one directive, and the audit keeps the 1,000.
    const corrected = await tds(org, who.standard!, 1_500)
    expect(corrected.body.data.monthly_amount).toBe(1_500)
    expect(corrected.body.data.financial_year_label).toBe('2026-27')
    expect(await prisma.employeeTdsDirective.count({ where: { employeeId: who.standard! } })).toBe(1)

    const audits = await prisma.auditLog.findMany({
      where: { organizationId: org.id, action: 'payroll.tds_directive_set', entityId: corrected.body.data.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(audits).toHaveLength(2)
    expect((audits[1]!.details as { previous: { monthlyAmount: number } }).previous.monthlyAmount).toBe(1_000)

    for (const id of [who.lop!, who.unpaidLeave!, who.incentive!, who.leaver!]) await tds(org, id, 0)
    // The joiner's starts the month they joined.
    await tds(org, who.joiner!, 0, AUGUST)

    const list = await api(org).get('/api/payroll/tds-directives?financialYear=2026')
    expect(list.status).toBe(200)
    expect(list.body.data).toHaveLength(6)
  })

  it('lets HR enter an incentive, which replaces rather than adds', async () => {
    const put = (amount: number, role: Role = 'hr') =>
      api(org, role).put('/api/payroll/monthly-entries', {
        employeeId: who.incentive,
        componentCode: 'INCENTIVE',
        ...AUGUST,
        amount,
        note: 'Q2 target',
      })

    expect((await put(4_000)).status).toBe(200)
    const res = await put(5_000)
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ amount: 5_000, component_code: 'INCENTIVE', component_label: 'Incentive' })
    expect(await prisma.employeeMonthlyEntry.count({ where: { employeeId: who.incentive! } })).toBe(1)

    // Both saves are on record, the second knowing what it replaced.
    const audits = await prisma.auditLog.findMany({
      where: { organizationId: org.id, action: 'payroll.entry_set', entityId: res.body.data.id },
      orderBy: { createdAt: 'asc' },
    })
    expect(audits).toHaveLength(2)
    expect((audits[1]!.details as { previous: { amount: number } }).previous.amount).toBe(4_000)

    expect((await put(5_000, 'employee')).status).toBe(403)
  })

  it('refuses a monthly entry that is not one', async () => {
    const entry = (body: object) =>
      api(org, 'hr').put('/api/payroll/monthly-entries', {
        employeeId: who.standard,
        componentCode: 'INCENTIVE',
        ...AUGUST,
        amount: 1_000,
        ...body,
      })

    // Basic comes from the salary record.
    expect((await entry({ componentCode: 'BASIC' })).status).toBe(400)
    // Removing an incentive is a DELETE, not an entry of zero.
    expect((await entry({ amount: 0 })).status).toBe(422)
    // Not employed in July.
    expect((await entry({ employeeId: who.joiner, month: 7 })).status).toBe(400)
  })

  it('removes an entry', async () => {
    const created = await api(org, 'hr').put('/api/payroll/monthly-entries', {
      employeeId: who.standard,
      componentCode: 'INCENTIVE',
      ...AUGUST,
      amount: 750,
    })
    expect((await api(org, 'hr').delete(`/api/payroll/monthly-entries/${created.body.data.id}`)).status).toBe(200)

    const left = await api(org, 'hr').get('/api/payroll/monthly-entries?year=2026&month=8')
    expect(left.body.data.map((e: { employee_id: string }) => e.employee_id)).toEqual([who.incentive])
    expect(
      await prisma.auditLog.count({
        where: { organizationId: org.id, action: 'payroll.entry_removed', entityId: created.body.data.id },
      }),
    ).toBe(1)
  })

  it('creates the run: every payslip, the totals and the audit row, together', async () => {
    const res = await api(org).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(201)
    run = res.body.data

    expect(run.status).toBe('draft')
    expect(run.employee_count).toBe(6)
    expect(run.payslips).toHaveLength(6)
    expect(payslipOf(run, who.gone!)).toBeUndefined()
    expect(run.warnings.join(' ')).toMatch(/Left Unrecorded/)

    // The run is the sum of its payslips, to the paisa.
    const sum = (key: 'gross_earnings' | 'net_payable') =>
      Math.round(run.payslips.reduce((total, slip) => total + slip[key] * 100, 0)) / 100
    expect(run.gross_earnings).toBe(sum('gross_earnings'))
    expect(run.net_payable).toBe(sum('net_payable'))

    const audit = await prisma.auditLog.findFirst({
      where: { organizationId: org.id, action: 'payroll.run_created', entityId: run.id },
    })
    expect(audit).not.toBeNull()

    // And it is listed, as it stands.
    const list = await api(org).get('/api/payroll-runs')
    expect(list.status).toBe(200)
    expect(list.body.data).toEqual([
      expect.objectContaining({ id: run.id, year: 2026, month: 8, status: 'draft', employee_count: 6 }),
    ])
  })

  it('pays a full month in full, with the directive’s TDS', async () => {
    const slip = payslipOf(run, who.standard!)!
    // 20,000 + 2,000 + 10,000.
    expect(slip.gross_earnings).toBe(32_000)
    // PF 1,800 (12% of the 15,000 ceiling) + PT 200 + TDS 1,500.
    expect(slip.net_payable).toBe(28_500)
    expect(slip.lop_days).toBe(0)
    // Nobody marked their attendance, and a leave of theirs is undecided.
    expect(slip.warnings.join(' ')).toMatch(/No attendance on 26 working days/)
    expect(slip.warnings.join(' ')).toMatch(/Casual Leave from 2026-08-20 to 2026-08-21 is waiting/)
  })

  it('docks three days of absence', async () => {
    const slip = payslipOf(run, who.lop!)!
    expect(slip.lop_days).toBe(3)
    expect(slip.paid_days).toBe(28)
    // 28 days of 31, component by component: 18,064.52 + 1,806.45 + 9,032.26.
    expect(slip.gross_earnings).toBe(28_903.23)
    // PF wages 19,870.97, still above the ceiling, so PF stays 1,800. PT 200. TDS 0.
    expect(slip.net_payable).toBe(26_903.23)
  })

  it('docks approved unpaid leave, and pays the rest', async () => {
    const slip = payslipOf(run, who.unpaidLeave!)!
    expect(slip.lop_days).toBe(2)
    // 15,000 × 29 / 31.
    expect(slip.gross_earnings).toBe(14_032.26)
  })

  it('pays the incentive as entered, whatever the attendance', async () => {
    const slip = payslipOf(run, who.incentive!)!
    expect(slip.lop_days).toBe(1)
    // Basic 20,000 × 30 / 31 = 19,354.84, plus the full 5,000.
    expect(slip.gross_earnings).toBe(24_354.84)

    const detail = await api(org).get(`/api/payroll-runs/${run.id}/payslips/${slip.id}`)
    expect(detail.status).toBe(200)
    expect(detail.body.data.earnings).toEqual([
      { code: 'BASIC', label: 'Basic', rate: 20_000, amount: 19_354.84 },
      { code: 'INCENTIVE', label: 'Incentive', rate: null, amount: 5_000 },
    ])
    expect(detail.body.data.basis.monthlyEntries).toEqual([
      expect.objectContaining({ code: 'INCENTIVE', amount: 5_000, note: 'Q2 target' }),
    ])
  })

  it('pays a joiner from the day they joined, and a leaver to the day they left', async () => {
    const joiner = payslipOf(run, who.joiner!)!
    // 16th to 31st: 16 days. 20,000 × 16 / 31.
    expect(joiner.paid_days).toBe(16)
    expect(joiner.gross_earnings).toBe(10_322.58)

    const leaver = payslipOf(run, who.leaver!)!
    // 1st to 10th. 20,000 × 10 / 31.
    expect(leaver.paid_days).toBe(10)
    expect(leaver.gross_earnings).toBe(6_451.61)
  })

  it('keeps on the payslip every fact it was calculated from', async () => {
    const slip = payslipOf(run, who.lop!)!
    const d = (await api(org).get(`/api/payroll-runs/${run.id}/payslips/${slip.id}`)).body.data

    expect(d).toMatchObject({
      days_in_month: 31,
      employment_days: 31,
      lop_days: 3,
      paid_days: 28,
      ncp_days: 3,
      lop_basis: 'calendar_days',
      pay_basis_days: 31,
      payable_days: 28,
    })
    expect(d.deductions.map((line: { code: string }) => line.code)).toEqual(['PF', 'PT'])
    expect(d.basis.rates).toMatchObject({ pfEmployeeRate: 12, pfWageCeiling: 15_000 })
    expect(d.basis.tdsDirective).toMatchObject({ monthlyAmount: 0, reason: 'Below the taxable limit' })
    expect(d.basis.lossOfPay.map((row: { date: string; reason: string }) => [row.date, row.reason])).toEqual([
      ['2026-08-03', 'absent'],
      ['2026-08-04', 'absent'],
      ['2026-08-05', 'absent'],
    ])
  })

  it('is a snapshot: a later rename or raise does not reach it', async () => {
    const slip = payslipOf(run, who.standard!)!

    await prisma.employee.update({ where: { id: who.standard! }, data: { fullName: 'Renamed Later' } })
    await prisma.employeeSalaryComponent.updateMany({
      where: { financial: { employeeId: who.standard! } },
      data: { amount: 99_999 },
    })

    const d = (await api(org).get(`/api/payroll-runs/${run.id}/payslips/${slip.id}`)).body.data
    expect(d.full_name).toBe('Standard')
    expect(d.gross_earnings).toBe(32_000)

    // Put back, for the recalculation below.
    await prisma.employee.update({ where: { id: who.standard! }, data: { fullName: 'Standard' } })
    const financial = await prisma.employeeFinancial.findFirstOrThrow({ where: { employeeId: who.standard! } })
    for (const [code, amount] of Object.entries({ BASIC: 20_000, DA: 2_000, HRA: 10_000 })) {
      await prisma.employeeSalaryComponent.updateMany({
        where: { employeeFinancialId: financial.id, salaryComponentId: org.component[code]! },
        data: { amount },
      })
    }
  })

  it('refuses a second run for the same month', async () => {
    const res = await api(org).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(409)
    expect(await prisma.payrollRun.count({ where: { organizationId: org.id } })).toBe(1)
  })

  it('recalculates a draft from the records as they are now', async () => {
    await mark(org, who.standard!, '2026-08-25', 'absent')

    const res = await api(org).post(`/api/payroll-runs/${run.id}/recalculate`)
    expect(res.status).toBe(200)
    expect(res.body.data.id).toBe(run.id)

    const slip = payslipOf(res.body.data as typeof run, who.standard!)!
    expect(slip.lop_days).toBe(1)
    // Replaced, not added to.
    expect(await prisma.payslip.count({ where: { payrollRunId: run.id } })).toBe(6)
    expect(
      await prisma.auditLog.count({ where: { organizationId: org.id, action: 'payroll.run_recalculated', entityId: run.id } }),
    ).toBe(1)
  })

  it('is not visible from another company', async () => {
    const outsider = await makeOrg('outsider')
    expect((await api(outsider).get(`/api/payroll-runs/${run.id}`)).status).toBe(404)
    expect((await api(outsider).post(`/api/payroll-runs/${run.id}/recalculate`)).status).toBe(404)
    expect((await api(outsider).delete(`/api/payroll-runs/${run.id}`)).status).toBe(404)
  })

  it('closes the month once the run is past draft', async () => {
    // Approval is Day 17's; the rule that follows from it is tested here.
    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'approved' } })

    expect((await api(org).post(`/api/payroll-runs/${run.id}/recalculate`)).status).toBe(409)
    expect((await api(org).delete(`/api/payroll-runs/${run.id}`)).status).toBe(409)

    const entry = await api(org, 'hr').put('/api/payroll/monthly-entries', {
      employeeId: who.incentive,
      componentCode: 'INCENTIVE',
      ...AUGUST,
      amount: 9_000,
    })
    expect(entry.status).toBe(409)

    // A directive from April reaches August; one from September does not.
    expect(
      (await api(org).put('/api/payroll/tds-directives', { employeeId: who.lop, year: 2026, month: 4, monthlyAmount: 200 })).status,
    ).toBe(409)
    expect(
      (await api(org).put('/api/payroll/tds-directives', { employeeId: who.lop, year: 2026, month: 9, monthlyAmount: 200 })).status,
    ).toBe(200)

    await prisma.payrollRun.update({ where: { id: run.id }, data: { status: 'draft' } })
  })

  it('discards a draft, payslips and all', async () => {
    const res = await api(org).delete(`/api/payroll-runs/${run.id}`)
    expect(res.status).toBe(200)

    expect(await prisma.payrollRun.count({ where: { organizationId: org.id } })).toBe(0)
    expect(await prisma.payslip.count({ where: { organizationId: org.id } })).toBe(0)
    expect(await prisma.payslipLine.count({ where: { organizationId: org.id } })).toBe(0)
    expect(
      await prisma.auditLog.count({ where: { organizationId: org.id, action: 'payroll.run_discarded', entityId: run.id } }),
    ).toBe(1)
  })
})

describe('a company on a fixed 30-day month, with the sandwich rule', () => {
  it('docks the Sunday between two absences, a thirtieth each', async () => {
    const org = await makeOrg('fixed30', { lopBasis: 'fixed_30', sandwichRule: true })
    const id = await hire(org, { salary: { BASIC: 30_000 } })
    await tds(org, id, 0)

    // Absent Saturday 8 and Monday 10 August; Sunday the 9th sits between.
    await mark(org, id, '2026-08-08', 'absent')
    await mark(org, id, '2026-08-10', 'absent')

    const res = await api(org).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ lop_basis: 'fixed_30', sandwich_rule: true })

    const slip = res.body.data.payslips[0]
    const d = (await api(org).get(`/api/payroll-runs/${res.body.data.id}/payslips/${slip.id}`)).body.data
    expect(d).toMatchObject({
      lop_days: 3,
      paid_days: 28,
      ncp_days: 3,
      lop_basis: 'fixed_30',
      pay_basis_days: 30,
      payable_days: 27,
    })
    // 30,000 − 3 × 1,000.
    expect(d.gross_earnings).toBe(27_000)
    expect(d.basis.lossOfPay.map((row: { reason: string }) => row.reason)).toEqual(['absent', 'sandwiched', 'absent'])
  })
})

describe('a company that deducts no income tax through payroll — the client’s own setting', () => {
  it('runs without a single TDS directive, and no payslip carries an Income Tax line', async () => {
    const org = await makeOrg('notds', { tdsEnabled: false })
    const id = await hire(org, { salary: { BASIC: 20_000, HRA: 10_000 } })

    const ready = await api(org).get('/api/payroll-runs/readiness?year=2026&month=8')
    expect(ready.body.data).toMatchObject({ tds_enabled: false, blocked: false, blockers: [] })

    const res = await api(org).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(201)

    const slip = res.body.data.payslips[0]
    const d = (await api(org).get(`/api/payroll-runs/${res.body.data.id}/payslips/${slip.id}`)).body.data
    // PF and Professional Tax, and nothing else.
    expect(d.deductions.map((line: { code: string }) => line.code)).toEqual(['PF', 'PT'])
    expect(d.tds).toBe(0)
    expect(d.basis).toMatchObject({ tdsEnabled: false, tdsDirective: null })
    expect(d.employee_id).toBe(id)
  })

  it('refuses a TDS amount rather than store one no run would read', async () => {
    const org = await makeOrg('notds2', { tdsEnabled: false })
    const id = await hire(org, { salary: { BASIC: 20_000 } })
    const res = await api(org).put('/api/payroll/tds-directives', { employeeId: id, year: 2026, month: 4, monthlyAmount: 500 })
    expect(res.status).toBe(422)
    expect(res.body.error.message).toMatch(/turned off in Settings/)
  })
})

describe('the EPF ceiling of ₹25,000, from 17 September 2026', () => {
  async function runFor(label: string, policy: { epsWageCeiling?: number } = {}) {
    // pfWageCeiling null: whatever a new company gets today.
    const org = await makeOrg(label, { pfWageCeiling: null, ...policy })
    const id = await hire(org, { salary: { BASIC: 20_000, DA: 2_000, HRA: 10_000 } })
    await tds(org, id, 0)
    const res = await api(org).post('/api/payroll-runs', AUGUST)
    expect(res.status).toBe(201)
    const slip = res.body.data.payslips[0]
    return (await api(org).get(`/api/payroll-runs/${res.body.data.id}/payslips/${slip.id}`)).body.data
  }

  it('is what a new company starts with: PF on wages up to ₹25,000, pension on ₹15,000', async () => {
    const d = await runFor('ceiling25')
    // PF wages are Basic + DA = 22,000, now under the ceiling: 12% of all of it.
    expect(d.pf_wages).toBe(22_000)
    expect(d.employee_pf).toBe(2_640)
    // The pension share stays at 8.33% of ₹15,000 until the accountant moves it.
    expect(d.employer).toEqual({ pf_total: 2_640, eps: 1_250, epf: 1_390, esi: 0 })
    expect(d.basis.rates).toMatchObject({ pfWageCeiling: 25_000, epsWageCeiling: 15_000 })
  })

  it('puts 8.33% of the whole ₹22,000 into the pension once its ceiling is ₹25,000 too', async () => {
    const d = await runFor('eps25', { epsWageCeiling: 25_000 })
    // 22,000 × 8.33% = 1,832.60 → 1,833. EPF is the rest of the 2,640.
    expect(d.employer).toEqual({ pf_total: 2_640, eps: 1_833, epf: 807, esi: 0 })
  })
})

describe('two accountants pressing Run at the same moment', () => {
  it('makes one run, not two', async () => {
    const org = await makeOrg('race')
    for (let i = 0; i < 2; i++) await tds(org, await hire(org, { salary: { BASIC: 20_000 } }), 0)

    const [a, b] = await Promise.all([
      api(org).post('/api/payroll-runs', AUGUST),
      api(org).post('/api/payroll-runs', AUGUST),
    ])

    expect([a.status, b.status].sort()).toEqual([201, 409])
    expect(await prisma.payrollRun.count({ where: { organizationId: org.id } })).toBe(1)
    expect(await prisma.payslip.count({ where: { organizationId: org.id } })).toBe(2)
  })
})
