// Day 18 browser E2E: seeds a separate company in the LOCAL ems_e2e database
// (never Neon), or removes it again.
//
//   tsx day18-seed.ts seed            → writes day18-fixture.json
//   tsx day18-seed.ts cleanup <stamp>
import { writeFileSync } from 'node:fs'
import { assertLocalDatabase, fixturePath } from './fixture'
import { prisma } from '../../src/platform/db/prisma'
import { hashPassword } from '../../src/platform/auth/password'

const url = new URL(process.env.DATABASE_URL ?? '')
if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.pathname.endsWith('/ems_e2e')) {
  throw new Error(`Refusing: ${url.hostname}${url.pathname} is not the local ems_e2e database`)
}

const FIXTURE = fixturePath('day18-fixture.json')
const PASSWORD = 'Day18E2ePassword1'
const day = (d: string) => new Date(`${d}T00:00:00Z`)

/**
 * `review` — everybody has a salary, bank accounts already recorded (Hema's
 * rejected, Anil's and Hema's not checked), and a paid run from June 2025.
 * `tds` — the company deducts TDS; three people already have directives.
 */
async function seed(variant: 'base' | 'review' | 'tds' = 'base') {
  const stamp = Date.now() % 1_000_000
  const org = await prisma.organization.create({
    data: {
      name: `day18-e2e-${stamp}`, legalName: 'CareerMap Test Private Limited', addressLine: 'Baner Road',
      city: 'Pune', state: 'Maharashtra', pincode: '411045', timezone: 'Asia/Kolkata',
    },
  })
  const organizationId = org.id
  // Reopen allowed until the 10th of the following month.
  await prisma.organizationPolicy.create({
    data: { organizationId, effectiveFrom: day('2026-04-01'), payslipLockDay: 10, tdsEnabled: variant === 'tds' },
  })

  const component: Record<string, string> = {}
  for (const c of [
    { code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    { code: 'HRA', label: 'House Rent Allowance', displayOrder: 2 },
    { code: 'SPECIAL', label: 'Special Allowance', displayOrder: 3 },
    { code: 'INCENTIVE', label: 'Incentive', displayOrder: 6, entry: 'monthly' as const },
  ]) {
    component[c.code] = (await prisma.salaryComponent.create({ data: { organizationId, ...c } })).id
  }

  for (const slab of [
    { gender: 'male', minGross: 0, maxGross: 7500, amount: 0, februaryAmount: null },
    { gender: 'male', minGross: 7500.01, maxGross: 10000, amount: 175, februaryAmount: null },
    { gender: 'male', minGross: 10000.01, maxGross: null, amount: 200, februaryAmount: 300 },
    { gender: 'female', minGross: 0, maxGross: 25000, amount: 0, februaryAmount: null },
    { gender: 'female', minGross: 25000.01, maxGross: null, amount: 200, februaryAmount: 300 },
  ] as const) {
    await prisma.ptSlab.create({ data: { organizationId, state: 'Maharashtra', effectiveFrom: day('2020-04-01'), ...slab } })
  }

  const users: Record<string, { email: string; membershipId: string }> = {}
  for (const [key, role] of [['admin', 'super_admin'], ['acc', 'accounts'], ['hr', 'hr'], ['emp', 'employee']] as const) {
    const email = `d18-${stamp}-${key}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    const m = await prisma.membership.create({ data: { userId: user.id, organizationId, role, status: 'active' } })
    users[key] = { email, membershipId: m.id }
  }

  const people = [
    { key: 'anil', name: 'Anil Accountant', gender: 'male', login: 'acc', salary: { BASIC: 25_000, HRA: 10_000, SPECIAL: 5_000 }, ctc: 480_000 },
    { key: 'hema', name: 'Hema Hiremath', gender: 'female', login: 'hr', salary: { BASIC: 20_000, HRA: 8_000, SPECIAL: 2_000 }, ctc: 360_000 },
    { key: 'priya', name: 'Priya Deshmukh', gender: 'female', login: 'emp', salary: { BASIC: 20_000, HRA: 10_000 }, ctc: 360_000, uan: '101234567890', pan: 'AAAPD1234K' },
    { key: 'ravi', name: 'Ravi Patil', gender: 'male', login: null, salary: { BASIC: 15_000, HRA: 5_000 }, ctc: 240_000 },
    { key: 'neha', name: 'Neha Joshi', gender: 'female', login: null, salary: variant === 'base' ? null : { BASIC: 18_000, HRA: 7_000 }, ctc: 300_000 },
  ] as const

  const employees: Record<string, { id: string; code: string; name: string }> = {}
  let n = 0
  for (const p of people) {
    n += 1
    const code = `D18${stamp}${n}`
    const employee = await prisma.employee.create({
      data: {
        organizationId, employeeCode: code, fullName: p.name, dateOfJoining: day('2025-01-06'), gender: p.gender,
        ...(p.login ? { memberships: { connect: { id: users[p.login]!.membershipId } } } : {}),
      },
    })
    await prisma.employeeStatutoryIdentity.create({
      data: {
        organizationId, employeeId: employee.id, ptState: 'Maharashtra', pfApplicable: true, hasPriorPfMembership: true,
        uan: 'uan' in p ? p.uan : null, pan: 'pan' in p ? p.pan : null,
      },
    })
    if (p.salary) {
      await prisma.employeeFinancial.create({
        data: {
          organizationId, employeeId: employee.id, ctc: p.ctc, effectiveFrom: day('2025-01-06'),
          components: { create: Object.entries(p.salary).map(([code, amount]) => ({ organizationId, salaryComponentId: component[code]!, amount })) },
        },
      })
    }
    employees[p.key] = { id: employee.id, code, name: p.name }
  }

  // September 2026 up to yesterday: present on working days. Priya is absent on
  // the 10th and 11th; Ravi has nothing marked from the 21st.
  const rows = []
  for (const [key, e] of Object.entries(employees)) {
    for (let d = 1; d <= 26; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`
      if (new Date(`${date}T00:00:00Z`).getUTCDay() === 0) continue
      if (key === 'ravi' && d >= 21) continue
      const status = key === 'priya' && (d === 10 || d === 11) ? ('absent' as const) : ('present' as const)
      rows.push({ organizationId, employeeId: e.id, date: day(date), status, source: 'manual' as const })
    }
  }
  await prisma.attendance.createMany({ data: rows })

  if (variant === 'review') {
    const accounts = [
      { key: 'ravi', holder: 'RAVI PATIL', number: '004455667788', ifsc: 'HDFC0001234', bank: 'HDFC Bank', status: 'verified' as const },
      { key: 'priya', holder: 'PRIYA DESHMUKH', number: '112233445566', ifsc: 'ICIC0004321', bank: 'ICICI Bank', status: 'verified' as const },
      { key: 'hema', holder: 'HEMA H', number: '998877665544', ifsc: 'SBIN0001111', bank: 'State Bank of India', status: 'rejected' as const, remarks: 'Name does not match the cheque' },
      { key: 'anil', holder: 'ANIL A', number: '555566667777', ifsc: 'HDFC0009999', bank: 'HDFC Bank', status: 'pending' as const },
    ]
    for (const a of accounts) {
      await prisma.employeeBankAccount.create({
        data: {
          organizationId, employeeId: employees[a.key]!.id, bankName: a.bank, accountHolderName: a.holder,
          accountNumber: a.number, ifsc: a.ifsc, accountType: 'Savings', verificationStatus: a.status,
          verificationRemarks: a.remarks ?? null, verifiedAt: a.status === 'pending' ? null : new Date(),
        },
      })
    }
    // A month more than thirteen back, already paid.
    await prisma.payrollRun.create({
      data: {
        organizationId, year: 2025, month: 6, status: 'paid', lopBasis: 'calendar_days', sandwichRule: false,
        employeeCount: 0, grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0,
        calculatedAt: day('2025-06-30'), approvedAt: day('2025-06-30'), paidOn: day('2025-06-30'), paidAt: day('2025-06-30'),
      },
    })
  }

  if (variant === 'tds') {
    for (const [key, amount, reason] of [['anil', 2_000, null], ['hema', 0, 'Below the taxable limit'], ['ravi', 0, 'Below the taxable limit']] as const) {
      await prisma.employeeTdsDirective.create({
        data: { organizationId, employeeId: employees[key]!.id, financialYear: 2026, effectiveFrom: day('2026-04-01'), monthlyAmount: amount, reason },
      })
    }
  }

  const fixture = {
    stamp, variant, organizationId, password: PASSWORD,
    users: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.email])),
    employees,
  }
  writeFileSync(variant === 'base' ? FIXTURE : FIXTURE.replace('day18-fixture', `day18-${variant}-fixture`), JSON.stringify(fixture, null, 2))
  console.log(JSON.stringify(fixture, null, 2))
}

async function cleanup(stamp: string) {
  const org = await prisma.organization.findFirst({ where: { name: `day18-e2e-${stamp}` } })
  if (!org) {
    console.log('nothing to clean for', stamp)
    return
  }
  const where = { organizationId: org.id }
  await prisma.payslipLine.deleteMany({ where })
  await prisma.payslip.deleteMany({ where })
  await prisma.payrollRun.deleteMany({ where })
  await prisma.employeeTdsDirective.deleteMany({ where })
  await prisma.employeeMonthlyEntry.deleteMany({ where })
  await prisma.bankFileTemplate.deleteMany({ where })
  await prisma.employeeBankAccount.deleteMany({ where })
  await prisma.attendance.deleteMany({ where })
  await prisma.esiCoverage.deleteMany({ where })
  await prisma.employeeSalaryComponent.deleteMany({ where })
  await prisma.employeeFinancial.deleteMany({ where })
  await prisma.employeeStatutoryIdentity.deleteMany({ where })
  await prisma.salaryComponent.deleteMany({ where })
  await prisma.ptSlab.deleteMany({ where })
  await prisma.organizationPolicy.deleteMany({ where })
  await prisma.auditLog.deleteMany({ where })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: `d18-${stamp}-` } } } }).catch(() => undefined)
  await prisma.employee.deleteMany({ where })
  await prisma.membership.deleteMany({ where })
  await prisma.user.deleteMany({ where: { email: { startsWith: `d18-${stamp}-` } } })
  await prisma.organization.delete({ where: { id: org.id } })
  console.log('cleaned up', org.name)
}

assertLocalDatabase()
const [mode, arg] = process.argv.slice(2)
;(mode === 'cleanup' ? cleanup(arg ?? '') : seed((arg as 'base' | 'review' | 'tds' | undefined) ?? 'base'))
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
