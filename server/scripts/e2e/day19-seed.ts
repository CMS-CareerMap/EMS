// Day 19 browser E2E: seeds a separate company in the LOCAL ems_e2e database
// (never Neon), or removes it again.
//
//   tsx day19-seed.ts seed            → writes day19-fixture.json
//   tsx day19-seed.ts cleanup <stamp>
import { writeFileSync } from 'node:fs'
import { assertLocalDatabase, fixturePath } from './fixture'
import { prisma } from '../../src/platform/db/prisma'
import { hashPassword } from '../../src/platform/auth/password'
import { seedForOrganization } from '../../prisma/seed/referenceData'

const url = new URL(process.env.DATABASE_URL ?? '')
if (!/^(localhost|127\.0\.0\.1)$/.test(url.hostname) || !url.pathname.endsWith('/ems_e2e')) {
  throw new Error(`Refusing: ${url.hostname}${url.pathname} is not the local ems_e2e database`)
}

const FIXTURE = fixturePath('day19-fixture.json')
const PASSWORD = 'Day19E2ePassword1'
const day = (d: string) => new Date(`${d}T00:00:00Z`)

async function seed() {
  const stamp = Date.now() % 1_000_000
  const org = await prisma.organization.create({
    data: {
      name: `day19-e2e-${stamp}`, legalName: 'CareerMap Test Private Limited', addressLine: 'Baner Road',
      city: 'Pune', state: 'Maharashtra', pincode: '411045', timezone: 'Asia/Kolkata',
    },
  })
  const organizationId = org.id
  // The company a bootstrap makes: departments, leave types, the eight
  // document types, salary components, Maharashtra PT, fixed holidays, policy.
  await prisma.$transaction((tx) => seedForOrganization(tx, { id: organizationId, timezone: 'Asia/Kolkata' }), { timeout: 60_000 })

  const dept = Object.fromEntries((await prisma.department.findMany({ where: { organizationId } })).map((d) => [d.name, d.id]))
  const component = Object.fromEntries((await prisma.salaryComponent.findMany({ where: { organizationId } })).map((c) => [c.code, c.id]))
  const cl = await prisma.leaveType.findFirstOrThrow({ where: { organizationId, code: 'CL' } })

  const users: Record<string, { email: string; membershipId: string; userId: string }> = {}
  for (const [key, role] of [
    ['sa', 'super_admin'], ['sa2', 'super_admin'], ['admin', 'admin'], ['hr', 'hr'],
    ['mgr', 'manager'], ['acc', 'accounts'], ['emp', 'employee'], ['emp2', 'employee'],
  ] as const) {
    const email = `d19-${stamp}-${key}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    const m = await prisma.membership.create({ data: { userId: user.id, organizationId, role, status: 'active' } })
    users[key] = { email, membershipId: m.id, userId: user.id }
  }

  // sa2 is the bootstrap administrator: a login with no employee record.
  const people = [
    { key: 'sunita', name: 'Sunita Admin', gender: 'female', login: 'sa', dept: 'Operations', salary: { BASIC: 40_000, HRA: 16_000, SPECIAL: 9_000 }, ctc: 780_000 },
    { key: 'arjun', name: 'Arjun Admin', gender: 'male', login: 'admin', dept: 'Operations', salary: { BASIC: 22_000, HRA: 8_000 }, ctc: 360_000 },
    { key: 'hema', name: 'Hema Hiremath', gender: 'female', login: 'hr', dept: 'Human Resources', salary: { BASIC: 20_000, HRA: 8_000, SPECIAL: 2_000 }, ctc: 360_000 },
    { key: 'manoj', name: 'Manoj Manager', gender: 'male', login: 'mgr', dept: 'Sales', salary: { BASIC: 30_000, HRA: 12_000 }, ctc: 504_000 },
    { key: 'anil', name: 'Anil Accountant', gender: 'male', login: 'acc', dept: 'Finance', salary: { BASIC: 25_000, HRA: 10_000, SPECIAL: 5_000 }, ctc: 480_000 },
    { key: 'priya', name: 'Priya Deshmukh', gender: 'female', login: 'emp', dept: 'Sales', salary: { BASIC: 12_000, HRA: 5_000 }, ctc: 204_000, uan: '101234567890', pan: 'AAAPD1234K' },
    { key: 'ravi', name: 'Ravi Patil', gender: 'male', login: 'emp2', dept: 'Sales', salary: { BASIC: 15_000, HRA: 5_000 }, ctc: 240_000 },
    // Joined this month; nothing in the leave ledger yet.
    { key: 'neha', name: 'Neha Joshi', gender: 'female', login: null, dept: 'Technology', salary: { BASIC: 18_000, HRA: 7_000 }, ctc: 300_000, joined: '2026-09-14', noLedger: true },
    // Left this month.
    { key: 'kiran', name: 'Kiran Kumar', gender: 'male', login: null, dept: 'Technology', salary: { BASIC: 16_000, HRA: 6_000 }, ctc: 264_000, left: '2026-09-10' },
  ] as const

  const employees: Record<string, { id: string; code: string; name: string }> = {}
  let n = 0
  for (const p of people) {
    n += 1
    const code = `D19${stamp}${n}`
    const joined = 'joined' in p ? p.joined : '2025-01-06'
    const employee = await prisma.employee.create({
      data: {
        organizationId, employeeCode: code, fullName: p.name, dateOfJoining: day(joined), gender: p.gender,
        departmentId: dept[p.dept], ...(p.login ? { memberships: { connect: { id: users[p.login]!.membershipId } } } : {}),
        ...('left' in p ? { lastWorkingDate: day(p.left), status: 'inactive' as const } : {}),
      },
    })
    await prisma.employeeStatutoryIdentity.create({
      data: {
        organizationId, employeeId: employee.id, ptState: 'Maharashtra', pfApplicable: true, hasPriorPfMembership: true,
        uan: 'uan' in p ? p.uan : null, pan: 'pan' in p ? p.pan : null,
      },
    })
    await prisma.employeeFinancial.create({
      data: {
        organizationId, employeeId: employee.id, ctc: p.ctc, effectiveFrom: day(joined),
        components: { create: Object.entries(p.salary).map(([c, amount]) => ({ organizationId, salaryComponentId: component[c]!, amount })) },
      },
    })
    if (!('noLedger' in p)) {
      await prisma.leaveLedgerEntry.create({ data: { organizationId, employeeId: employee.id, leaveTypeId: cl.id, leaveYear: 2026, days: 12, reason: 'opening_grant' } })
    }
    employees[p.key] = { id: employee.id, code, name: p.name }
  }
  for (const key of ['priya', 'ravi']) {
    await prisma.employee.update({ where: { id: employees[key]!.id }, data: { reportingManagerId: employees.manoj!.id } })
  }

  // Attendance. August: present on every working day but Independence Day.
  // September to the 26th: Priya absent on the 10th and 11th, Ravi unmarked
  // from the 21st, Kiran until he left on the 10th, Neha from the 14th.
  const rows = []
  const isSunday = (date: string) => day(date).getUTCDay() === 0
  for (const [key, e] of Object.entries(employees)) {
    for (let d = 1; d <= 31; d++) {
      const date = `2026-08-${String(d).padStart(2, '0')}`
      if (isSunday(date) || date === '2026-08-15' || key === 'neha') continue
      rows.push({ organizationId, employeeId: e.id, date: day(date), status: 'present' as const, source: 'manual' as const })
    }
    for (let d = 1; d <= 26; d++) {
      const date = `2026-09-${String(d).padStart(2, '0')}`
      if (isSunday(date)) continue
      if (key === 'ravi' && d >= 21) continue
      if (key === 'kiran' && d > 10) continue
      if (key === 'neha' && d < 14) continue
      const status = key === 'priya' && (d === 10 || d === 11) ? ('absent' as const) : key === 'hema' && d === 4 ? ('half_day' as const) : ('present' as const)
      rows.push({ organizationId, employeeId: e.id, date: day(date), status, source: 'manual' as const })
    }
  }
  await prisma.attendance.createMany({ data: rows })

  // Ravi's salary account, already checked, for Accounts to attach a proof to.
  await prisma.employeeBankAccount.create({
    data: {
      organizationId, employeeId: employees.ravi!.id, bankName: 'HDFC Bank', accountHolderName: 'RAVI PATIL',
      accountNumber: '004455667788', ifsc: 'HDFC0001234', accountType: 'Savings', verificationStatus: 'verified', verifiedAt: new Date(),
    },
  })

  // Thirty-five old notices for Ravi, so the bell has more than one page.
  await prisma.notification.createMany({
    data: Array.from({ length: 35 }, (_, i) => ({
      organizationId, userId: users.emp2!.userId, event: 'company_document.published', kind: 'announcement' as const,
      title: `Old notice ${String(i + 1).padStart(2, '0')}`, message: 'From before this test',
      createdAt: new Date(Date.UTC(2026, 6, 1 + i, 9, 0, 0)), readAt: new Date(Date.UTC(2026, 6, 2 + i)),
    })),
  })

  const fixture = {
    stamp, organizationId, password: PASSWORD,
    users: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.email])),
    userIds: Object.fromEntries(Object.entries(users).map(([k, v]) => [k, v.userId])),
    employees,
    departments: dept,
    leaveTypeId: cl.id,
  }
  writeFileSync(FIXTURE, JSON.stringify(fixture, null, 2))
  console.log(JSON.stringify(fixture, null, 2))
}

async function cleanup(stamp: string) {
  const org = await prisma.organization.findFirst({ where: { name: `day19-e2e-${stamp}` } })
  if (!org) {
    console.log('nothing to clean for', stamp)
    return
  }
  const where = { organizationId: org.id }
  await prisma.notification.deleteMany({ where })
  await prisma.notificationSetting.deleteMany({ where })
  await prisma.employeeDocument.deleteMany({ where })
  await prisma.companyDocument.deleteMany({ where })
  await prisma.documentType.deleteMany({ where })
  await prisma.payslipLine.deleteMany({ where })
  await prisma.payslip.deleteMany({ where })
  await prisma.payrollRun.deleteMany({ where })
  await prisma.employeeTdsDirective.deleteMany({ where })
  await prisma.employeeMonthlyEntry.deleteMany({ where })
  await prisma.bankFileTemplate.deleteMany({ where })
  await prisma.employeeBankAccount.deleteMany({ where })
  await prisma.leaveLedgerEntry.deleteMany({ where })
  await prisma.leaveRequest.deleteMany({ where })
  await prisma.attendance.deleteMany({ where })
  await prisma.esiCoverage.deleteMany({ where })
  await prisma.employeeSalaryComponent.deleteMany({ where })
  await prisma.employeeFinancial.deleteMany({ where })
  await prisma.employeeStatutoryIdentity.deleteMany({ where })
  await prisma.auditLog.deleteMany({ where })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: `d19-${stamp}-` } } } }).catch(() => undefined)
  await prisma.passwordResetToken.deleteMany({ where: { user: { email: { startsWith: `d19-${stamp}-` } } } }).catch(() => undefined)
  await prisma.employee.updateMany({ where, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where })
  await prisma.membership.deleteMany({ where })
  await prisma.user.deleteMany({ where: { email: { startsWith: `d19-${stamp}-` } } })
  // Reference data (departments, leave types, components, PT, holidays, policy)
  // goes with the company.
  await prisma.organization.delete({ where: { id: org.id } })
  console.log('cleaned up', org.name)
}

assertLocalDatabase()
const [mode, arg] = process.argv.slice(2)
;(mode === 'cleanup' ? cleanup(arg ?? '') : seed())
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
