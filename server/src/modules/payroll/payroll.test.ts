import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'

/**
 * The salary engine, end to end: stored salary in, calculated month out.
 *
 * The domain tests prove the arithmetic. These prove the WIRING — that the
 * right salary record, the right rates, the right PT slabs and the locked ESI
 * decision all reach the arithmetic. A correct engine fed the wrong month's
 * salary produces a confidently wrong payslip, and none of the domain tests
 * would notice.
 *
 * Every expected figure below is worked out by hand in the comment beside it.
 * If one of them changes, the comment says what it used to mean.
 */

const PREFIX = 'paytest'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
let otherOrgId = ''
const tokens: Record<string, string> = {}
const componentIds: Record<string, string> = {}

type Salary = Partial<Record<'BASIC' | 'DA' | 'HRA' | 'SPECIAL' | 'INCENTIVE', number>>

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.esiCoverage.deleteMany({ where: org })
  await prisma.employeeSalaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.ptSlab.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function login(key: string, role: 'accounts' | 'hr' | 'employee', organizationId = orgId) {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  await prisma.membership.create({
    data: { userId: user.id, organizationId, role, status: 'active' },
  })
  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
}

const as = (key: string) => `Bearer ${tokens[key]}`

let seq = 0

/** Hires somebody with a salary, the way the employee module eventually will. */
async function hire(options: {
  salary: Salary
  dateOfJoining?: string | null
  lastWorkingDate?: string
  salaryFrom?: string
  gender?: 'male' | 'female' | 'other' | null
  ptState?: string | null
  pfApplicable?: boolean
  hasPriorPfMembership?: boolean | null
  organizationId?: string
}): Promise<string> {
  const organizationId = options.organizationId ?? orgId
  const doj = options.dateOfJoining === undefined ? '2021-01-01' : options.dateOfJoining
  seq += 1

  const employee = await prisma.employee.create({
    data: {
      organizationId,
      employeeCode: `${PREFIX}-${seq}`,
      fullName: `Person ${seq}`,
      dateOfJoining: doj ? new Date(`${doj}T00:00:00Z`) : null,
      lastWorkingDate: options.lastWorkingDate ? new Date(`${options.lastWorkingDate}T00:00:00Z`) : null,
      gender: options.gender === undefined ? 'male' : options.gender,
    },
  })

  await prisma.employeeStatutoryIdentity.create({
    data: {
      organizationId,
      employeeId: employee.id,
      ptState: options.ptState === undefined ? 'Maharashtra' : options.ptState,
      pfApplicable: options.pfApplicable ?? true,
      hasPriorPfMembership: options.hasPriorPfMembership === undefined ? true : options.hasPriorPfMembership,
    },
  })

  if (organizationId === orgId) {
    await setSalary(employee.id, options.salaryFrom ?? doj ?? '2020-01-01', options.salary)
  }

  return employee.id
}

/** Opens a salary record, closing whichever one was in force the day before. */
async function setSalary(employeeId: string, from: string, salary: Salary) {
  const start = new Date(`${from}T00:00:00Z`)
  const dayBefore = new Date(start)
  dayBefore.setUTCDate(dayBefore.getUTCDate() - 1)

  await prisma.employeeFinancial.updateMany({
    where: { employeeId, effectiveTo: null },
    data: { effectiveTo: dayBefore },
  })

  const monthly = Object.values(salary).reduce((sum, v) => sum + (v ?? 0), 0)

  await prisma.employeeFinancial.create({
    data: {
      organizationId: orgId,
      employeeId,
      ctc: monthly * 12,
      effectiveFrom: start,
      components: {
        create: Object.entries(salary).map(([code, amount]) => ({
          organizationId: orgId,
          salaryComponentId: componentIds[code]!,
          amount: amount!,
        })),
      },
    },
  })
}

const calculate = (body: Record<string, unknown>, key = 'accounts') =>
  request(app).post('/api/payroll/calculate').set('Authorization', as(key)).send(body)

const esiRows = (employeeId: string) => prisma.esiCoverage.count({ where: { employeeId } })

beforeAll(async () => {
  await cleanup()

  const org = await prisma.organization.create({
    data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' },
  })
  orgId = org.id

  const other = await prisma.organization.create({ data: { name: `${PREFIX}-other` } })
  otherOrgId = other.id

  // Statutory defaults — PF 12% / 12%, ESI 0.75% / 3.25% up to ₹21,000 —
  // except the PF ceiling, pinned at ₹15,000: every figure below was worked
  // out before the September 2026 revision to ₹25,000, which has tests of its
  // own in payrollRun.test.ts.
  await prisma.organizationPolicy.create({
    data: { organizationId: orgId, effectiveFrom: new Date('2020-04-01T00:00:00Z'), pfWageCeiling: 15_000 },
  })

  for (const c of [
    { code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    { code: 'DA', label: 'Dearness Allowance', countsForPf: true, displayOrder: 2 },
    { code: 'HRA', label: 'House Rent Allowance', countsForPf: false, displayOrder: 3 },
    { code: 'SPECIAL', label: 'Special Allowance', countsForPf: false, displayOrder: 5 },
    // Entered per month, as the client specified — never on a salary record.
    { code: 'INCENTIVE', label: 'Incentive', countsForPf: false, displayOrder: 6, entry: 'monthly' as const },
  ]) {
    const row = await prisma.salaryComponent.create({ data: { organizationId: orgId, ...c } })
    componentIds[c.code] = row.id
  }

  const from = new Date('2020-04-01T00:00:00Z')
  for (const slab of [
    { gender: 'male', minGross: 0, maxGross: 7500, amount: 0, februaryAmount: null },
    { gender: 'male', minGross: 7500.01, maxGross: 10000, amount: 175, februaryAmount: null },
    { gender: 'male', minGross: 10000.01, maxGross: null, amount: 200, februaryAmount: 300 },
    { gender: 'female', minGross: 0, maxGross: 25000, amount: 0, februaryAmount: null },
    { gender: 'female', minGross: 25000.01, maxGross: null, amount: 200, februaryAmount: 300 },
  ] as const) {
    await prisma.ptSlab.create({
      data: { organizationId: orgId, state: 'Maharashtra', effectiveFrom: from, ...slab },
    })
  }

  await login('accounts', 'accounts')
  await login('hr', 'hr')
  await login('employee', 'employee')
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('who may see payroll', () => {
  it('lets Accounts calculate', async () => {
    const id = await hire({ salary: { BASIC: 20_000 } })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })
    expect(res.status).toBe(200)
  })

  it('refuses HR, per the client matrix', async () => {
    const id = await hire({ salary: { BASIC: 20_000 } })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 }, 'hr')
    expect(res.status).toBe(403)
  })

  it('refuses an employee', async () => {
    const id = await hire({ salary: { BASIC: 20_000 } })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 }, 'employee')
    expect(res.status).toBe(403)
  })

  it('lists the components in display order, for Accounts only', async () => {
    const ok = await request(app).get('/api/payroll/components').set('Authorization', as('accounts'))
    expect(ok.status).toBe(200)
    expect(ok.body.data.map((c: { code: string }) => c.code)).toEqual([
      'BASIC',
      'DA',
      'HRA',
      'SPECIAL',
      'INCENTIVE',
    ])
    // Says how each one gets its amount, so a screen knows where to ask for it.
    expect(ok.body.data.find((c: { code: string }) => c.code === 'INCENTIVE').entry).toBe('monthly')
    expect(ok.body.data.find((c: { code: string }) => c.code === 'BASIC').entry).toBe('fixed')

    const denied = await request(app).get('/api/payroll/components').set('Authorization', as('hr'))
    expect(denied.status).toBe(403)
  })
})

describe('another company', () => {
  it('does not exist, and leaves no trace', async () => {
    const foreign = await hire({ salary: {}, organizationId: otherOrgId })

    const res = await calculate({ employeeId: foreign, year: 2026, month: 9 })
    expect(res.status).toBe(404)

    // The bug this guards: every scoped read of a foreign employee returns
    // nothing, and nothing looks exactly like "no salary on record" — which
    // used to WRITE an ESI decision for a person in someone else's company.
    expect(await esiRows(foreign)).toBe(0)
  })

  it('cannot have its ESI decisions rewritten either', async () => {
    const foreign = await hire({ salary: {}, organizationId: otherOrgId })

    const res = await request(app)
      .post('/api/payroll/esi-coverage/redecide')
      .set('Authorization', as('accounts'))
      .send({ employeeId: foreign, year: 2026, month: 9 })

    expect(res.status).toBe(404)
    expect(await esiRows(foreign)).toBe(0)
  })
})

describe('a standard month', () => {
  it('caps PF at the ceiling and deducts Maharashtra PT', async () => {
    const id = await hire({ salary: { BASIC: 20_000, HRA: 8_000, SPECIAL: 12_000 } })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })

    expect(res.status).toBe(200)
    const d = res.body.data

    // 20,000 + 8,000 + 12,000.
    expect(d.gross_earnings).toBe(40_000)
    // PF wages are Basic alone here (no DA), capped at 15,000 because the
    // company restricts to the ceiling: 12% of 15,000.
    expect(d.pf_wages).toBe(15_000)
    expect(d.employee_pf).toBe(1_800)
    // 40,000 is far above 21,000.
    expect(d.employee_esi).toBe(0)
    expect(d.basis.esi.covered).toBe(false)
    // Maharashtra, a man, above 10,000, not February.
    expect(d.professional_tax).toBe(200)
    expect(d.net_payable).toBe(40_000 - 1_800 - 200)

    expect(d.paid_days).toBe(30)
    expect(d.is_preview).toBe(true)
  })

  it('charges ₹300 PT in February', async () => {
    const id = await hire({ salary: { BASIC: 20_000, HRA: 8_000, SPECIAL: 12_000 } })
    const res = await calculate({ employeeId: id, year: 2027, month: 2 })

    expect(res.body.data.professional_tax).toBe(300)
    expect(res.body.data.days_in_month).toBe(28)
  })

  it('exempts a woman below ₹25,000 where a man on the same pay is charged', async () => {
    const salary = { BASIC: 12_000, HRA: 4_800, SPECIAL: 5_200 }
    const woman = await hire({ salary, gender: 'female' })
    const man = await hire({ salary, gender: 'male' })

    const w = await calculate({ employeeId: woman, year: 2026, month: 9 })
    const m = await calculate({ employeeId: man, year: 2026, month: 9 })

    // Same 22,000 gross. The men's slab applied to her would take ₹200 a
    // month she does not owe.
    expect(w.body.data.gross_earnings).toBe(22_000)
    expect(w.body.data.professional_tax).toBe(0)
    expect(m.body.data.professional_tax).toBe(200)
  })


  it('deducts no PF from somebody PF does not apply to', async () => {
    const id = await hire({ salary: { BASIC: 20_000 }, pfApplicable: false })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })

    expect(res.body.data.employee_pf).toBe(0)
    expect(res.body.data.employer.pf_total).toBe(0)
  })
})

describe('incentive, entered for the month', () => {
  it('is paid as entered, even in a part month', async () => {
    // Joined on the 16th: the salary is prorated to half, the incentive is not.
    const id = await hire({ salary: { BASIC: 15_000, HRA: 6_000, SPECIAL: 9_000 }, dateOfJoining: '2026-09-16' })
    const res = await calculate({ employeeId: id, year: 2026, month: 9, monthlyAmounts: { INCENTIVE: 4_000 } })

    expect(res.status).toBe(200)
    const d = res.body.data

    // Half of 30,000, plus the full 4,000.
    expect(d.gross_earnings).toBe(19_000)
    expect(d.earnings.find((e: { code: string }) => e.code === 'INCENTIVE').amount).toBe(4_000)
    // PF on the prorated basic only: 12% of 7,500.
    expect(d.employee_pf).toBe(900)
    expect(d.net_payable).toBe(19_000 - 900 - 200)
  })

  it('does not move ESI cover, which is decided on the fixed wage', async () => {
    // 20,000 fixed is inside the threshold; a 6,000 incentive in April takes the
    // month's pay over it. Cover is about the RATE, so it holds.
    const id = await hire({ salary: { BASIC: 10_000, HRA: 4_000, SPECIAL: 6_000 } })
    const d = (await calculate({ employeeId: id, year: 2026, month: 4, monthlyAmounts: { INCENTIVE: 6_000 } })).body.data

    expect(d.basis.esi.covered).toBe(true)
    expect(d.basis.esi.locked_wage_rate).toBe(20_000)
    // Contributions ARE on what was paid: 0.75% of 26,000 is 195.
    expect(d.employee_esi).toBe(195)
  })

  it('leaves no line when the amount entered is zero', async () => {
    const id = await hire({ salary: { BASIC: 20_000 } })
    const d = (await calculate({ employeeId: id, year: 2026, month: 9, monthlyAmounts: { INCENTIVE: 0 } })).body.data

    expect(d.earnings.map((e: { code: string }) => e.code)).toEqual(['BASIC'])
  })

  it('refuses an incentive stored on the salary record', async () => {
    // Paid every month at one figure, and prorated in a short one — neither of
    // which anybody decided. Refused rather than guessed at.
    const id = await hire({ salary: { BASIC: 15_000, INCENTIVE: 4_000 } })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })

    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/Incentive is entered each month/)
  })

  it('refuses a month-amount for a fixed component, or one that does not exist', async () => {
    const id = await hire({ salary: { BASIC: 20_000 } })

    // Basic comes from the salary record. Overriding it for one month would
    // produce a payslip that matches nothing stored.
    const fixed = await calculate({ employeeId: id, year: 2026, month: 9, monthlyAmounts: { BASIC: 99_000 } })
    expect(fixed.status).toBe(400)

    const unknown = await calculate({ employeeId: id, year: 2026, month: 9, monthlyAmounts: { BONUS: 1_000 } })
    expect(unknown.status).toBe(400)
    expect(unknown.body.error.message).toMatch(/BONUS is not a salary component/)
  })
})

describe('the pension split', () => {
  it('sends the whole employer share to EPF for a new high earner with no prior membership', async () => {
    const id = await hire({
      salary: { BASIC: 20_000 },
      dateOfJoining: '2022-01-01',
      hasPriorPfMembership: false,
    })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })
    const d = res.body.data

    expect(d.basis.eps_member).toBe(false)
    expect(d.employer.eps).toBe(0)
    expect(d.employer.epf).toBe(1_800)
    // Same total either way — which is exactly why nobody notices it is wrong.
    expect(d.employer.pf_total).toBe(1_800)
  })

  it('warns when nobody has asked about prior membership', async () => {
    const id = await hire({
      salary: { BASIC: 20_000 },
      dateOfJoining: '2022-01-01',
      hasPriorPfMembership: null,
    })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })

    expect(res.body.data.basis.eps_member).toBe(false)
    expect(res.body.data.warnings.join(' ')).toMatch(/never a member before/)
  })

  it('splits for a member: 8.33% of wages to EPS, the rest to EPF', async () => {
    const id = await hire({ salary: { BASIC: 12_000 }, dateOfJoining: '2022-01-01', hasPriorPfMembership: false })
    const d = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data

    // PF 12% of 12,000 = 1,440. EPS 8.33% of 12,000 = 999.60 → 1,000.
    // EPF is the remainder so the halves always add up: 440.
    expect(d.basis.eps_member).toBe(true)
    expect(d.employer.pf_total).toBe(1_440)
    expect(d.employer.eps).toBe(1_000)
    expect(d.employer.epf).toBe(440)
  })
})

describe('ESI, locked for the contribution period', () => {
  it('keeps somebody covered after a mid-period raise takes them over ₹21,000', async () => {
    // 20,000 from 2020; raised to 25,000 from 1 July 2026.
    const id = await hire({ salary: { BASIC: 10_000, HRA: 4_000, SPECIAL: 6_000 }, dateOfJoining: '2020-01-01' })
    await setSalary(id, '2026-07-01', { BASIC: 12_500, HRA: 5_000, SPECIAL: 7_500 })

    const april = (await calculate({ employeeId: id, year: 2026, month: 4 })).body.data
    // Covered on 1 April at 20,000. 0.75% of 20,000 = 150.
    expect(april.basis.esi.covered).toBe(true)
    expect(april.employee_esi).toBe(150)

    const july = (await calculate({ employeeId: id, year: 2026, month: 7 })).body.data
    expect(july.gross_earnings).toBe(25_000)
    // STILL covered. This is the rule: the April decision holds to 30 Sep.
    // 0.75% of 25,000 = 187.50, rounded UP to 188; 3.25% = 812.50 → 813.
    expect(july.basis.esi.covered).toBe(true)
    expect(july.employee_esi).toBe(188)
    expect(july.employer.esi).toBe(813)
    // And it says what it was decided on.
    expect(july.basis.esi.locked_wage_rate).toBe(20_000)
    expect(july.basis.esi.period_start).toBe('2026-04-01')

    // One decision for the whole period, not one per month.
    expect(await esiRows(id)).toBe(1)

    const october = (await calculate({ employeeId: id, year: 2026, month: 10 })).body.data
    // A new period, tested afresh on 1 October at 25,000: out.
    expect(october.basis.esi.covered).toBe(false)
    expect(october.employee_esi).toBe(0)
    expect(await esiRows(id)).toBe(2)
  })

  it('decides on the wage at the period start, even when July is looked at first', async () => {
    // Nobody ran April. The decision must still be April's — otherwise
    // coverage would depend on which month happened to be calculated first.
    const id = await hire({ salary: { BASIC: 10_000, HRA: 4_000, SPECIAL: 6_000 }, dateOfJoining: '2020-01-01' })
    await setSalary(id, '2026-07-01', { BASIC: 12_500, HRA: 5_000, SPECIAL: 7_500 })

    const july = (await calculate({ employeeId: id, year: 2026, month: 7 })).body.data
    expect(july.basis.esi.covered).toBe(true)
    expect(july.basis.esi.locked_wage_rate).toBe(20_000)
  })

  it('reads the same decision on a second run', async () => {
    const id = await hire({ salary: { BASIC: 10_000, HRA: 4_000, SPECIAL: 6_000 } })

    await calculate({ employeeId: id, year: 2026, month: 5 })
    await calculate({ employeeId: id, year: 2026, month: 5 })
    await calculate({ employeeId: id, year: 2026, month: 6 })

    expect(await esiRows(id)).toBe(1)
  })

  it('tests a mid-period joiner on their joining date, against the wage rate', async () => {
    const id = await hire({ salary: { BASIC: 8_000, HRA: 3_200, SPECIAL: 4_800 }, dateOfJoining: '2026-09-16' })
    const d = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data

    // Rate 16,000 → covered, even though only half a month is paid.
    expect(d.basis.esi.covered).toBe(true)
    expect(d.basis.esi.reason).toBe('joined_mid_period')
    // Contributions on what was PAID: 8,000 × 0.75% = 60.
    expect(d.gross_earnings).toBe(8_000)
    expect(d.employee_esi).toBe(60)
  })

  it('lets Accounts re-decide a period that was decided on a typo', async () => {
    // Entered as 30,000 by mistake; really 18,000.
    const id = await hire({ salary: { BASIC: 15_000, HRA: 6_000, SPECIAL: 9_000 } })
    const before = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data
    expect(before.basis.esi.covered).toBe(false)

    // Correct the amounts on the same record — a data-entry fix, not a raise.
    await prisma.employeeSalaryComponent.updateMany({
      where: { financial: { employeeId: id }, salaryComponentId: componentIds.BASIC },
      data: { amount: 9_000 },
    })
    await prisma.employeeSalaryComponent.updateMany({
      where: { financial: { employeeId: id }, salaryComponentId: componentIds.HRA },
      data: { amount: 3_600 },
    })
    await prisma.employeeSalaryComponent.updateMany({
      where: { financial: { employeeId: id }, salaryComponentId: componentIds.SPECIAL },
      data: { amount: 5_400 },
    })

    // Still locked on the old decision — the lock does not chase the data.
    const still = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data
    expect(still.basis.esi.covered).toBe(false)

    const hrTry = await request(app)
      .post('/api/payroll/esi-coverage/redecide')
      .set('Authorization', as('hr'))
      .send({ employeeId: id, year: 2026, month: 9 })
    expect(hrTry.status).toBe(403)

    const redecided = await request(app)
      .post('/api/payroll/esi-coverage/redecide')
      .set('Authorization', as('accounts'))
      .send({ employeeId: id, year: 2026, month: 9 })

    expect(redecided.status).toBe(200)
    expect(redecided.body.data.covered).toBe(true)
    expect(redecided.body.data.locked_wage_rate).toBe(18_000)

    const after = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data
    // 0.75% of 18,000 = 135.
    expect(after.employee_esi).toBe(135)
    expect(await esiRows(id)).toBe(1)
  })
})

describe('part months', () => {
  it('prorates a mid-month joiner from their first day', async () => {
    const id = await hire({ salary: { BASIC: 15_000, HRA: 6_000, SPECIAL: 9_000 }, dateOfJoining: '2026-09-16' })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })

    // Their salary record starts on the 16th. Looking it up on the 1st used to
    // find nothing and report a new joiner as having no salary.
    expect(res.status).toBe(200)
    const d = res.body.data

    // 16th to 30th inclusive: 15 of 30 days, so exactly half.
    expect(d.employment_days).toBe(15)
    expect(d.paid_days).toBe(15)
    expect(d.gross_earnings).toBe(15_000)
    // PF on the prorated basic: 12% of 7,500.
    expect(d.employee_pf).toBe(900)
    expect(d.professional_tax).toBe(200)
    expect(d.net_payable).toBe(15_000 - 900 - 200)
  })

  it('stops a mid-month leaver on their last working day', async () => {
    const id = await hire({
      salary: { BASIC: 15_000, HRA: 6_000, SPECIAL: 9_000 },
      dateOfJoining: '2021-01-01',
      lastWorkingDate: '2026-09-10',
    })
    const d = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data

    // 1st to 10th: a third of the month, 10,000 of 30,000.
    expect(d.paid_days).toBe(10)
    expect(d.gross_earnings).toBe(10_000)
    expect(d.employee_pf).toBe(600)
    // 10,000 exactly sits in the ₹175 slab (7,500.01 to 10,000).
    expect(d.professional_tax).toBe(175)
    expect(d.net_payable).toBe(10_000 - 600 - 175)
  })

  it('takes loss-of-pay days off the paid days', async () => {
    const id = await hire({ salary: { BASIC: 20_000, HRA: 8_000, SPECIAL: 12_000 } })
    const d = (await calculate({ employeeId: id, year: 2026, month: 9, lopDays: 3 })).body.data

    // 27 of 30 days: 36,000 of 40,000.
    expect(d.lop_days).toBe(3)
    expect(d.paid_days).toBe(27)
    expect(d.gross_earnings).toBe(36_000)
    // Prorated basic 18,000 is still above the ceiling, so PF stays 1,800.
    expect(d.employee_pf).toBe(1_800)
  })

  it('refuses more loss of pay than days employed', async () => {
    const id = await hire({ salary: { BASIC: 20_000 }, dateOfJoining: '2026-09-25' })
    // Employed 25th–30th: six days. Ten days' LOP is a typo, not a payslip.
    const res = await calculate({ employeeId: id, year: 2026, month: 9, lopDays: 10 })
    expect(res.status).toBe(400)
  })

  it('refuses a month before they joined', async () => {
    const id = await hire({ salary: { BASIC: 20_000 }, dateOfJoining: '2026-10-05' })
    const res = await calculate({ employeeId: id, year: 2026, month: 9 })

    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/not employed in 2026-09/)
  })
})

describe('missing facts', () => {
  it('reports a missing salary as missing, never as zero', async () => {
    const employee = await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: `${PREFIX}-nosal`, fullName: 'No Salary' },
    })
    const res = await calculate({ employeeId: employee.id, year: 2026, month: 9 })

    expect(res.status).toBe(404)
    expect(res.body.error.message).toMatch(/No salary is on record/)
  })

  it('says so when a state has no PT slabs, rather than quietly charging nothing', async () => {
    const id = await hire({ salary: { BASIC: 20_000 }, ptState: 'Karnataka' })
    const d = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data

    expect(d.professional_tax).toBe(0)
    expect(d.warnings.join(' ')).toMatch(/No PT slabs are configured for Karnataka/)
  })

  it('says so when PT is gendered and no gender is recorded', async () => {
    const id = await hire({ salary: { BASIC: 20_000 }, gender: null })
    const d = (await calculate({ employeeId: id, year: 2026, month: 9 })).body.data

    expect(d.professional_tax).toBe(0)
    expect(d.warnings.join(' ')).toMatch(/no gender is recorded/)
  })

  it('rejects nonsense input before any arithmetic', async () => {
    const id = await hire({ salary: { BASIC: 20_000 } })

    expect((await calculate({ employeeId: id, year: 2026, month: 13 })).status).toBe(422)
    // Half days are real; a third of a day is not.
    expect((await calculate({ employeeId: id, year: 2026, month: 9, lopDays: 0.3 })).status).toBe(422)
    expect((await calculate({ employeeId: id, year: 2026, month: 9, tds: -1 })).status).toBe(422)
    expect((await calculate({ employeeId: 'not-a-uuid', year: 2026, month: 9 })).status).toBe(422)
    // A misspelt field is refused, not ignored — "lopDay" dropped in silence
    // would calculate the month as though nobody had been absent.
    expect((await calculate({ employeeId: id, year: 2026, month: 9, lopDay: 3 })).status).toBe(422)
    expect((await calculate({ employeeId: id, year: 2026, month: 9, monthlyAmounts: { INCENTIVE: -5 } })).status).toBe(422)
  })
})
