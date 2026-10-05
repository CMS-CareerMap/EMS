import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { forOrg } from '../../platform/db/scoped'
import * as repo from './employee.repository'

/**
 * Employee reads: who you can see, and what you can see about them.
 *
 * These are the two failures that matter, and they fail differently. Seeing the
 * wrong PEOPLE is loud — a manager notices the whole company in their list.
 * Seeing the wrong FIELDS is silent: a salary column appears for someone who
 * should not have it, and nobody who can see it thinks anything is wrong.
 *
 * So every role here is checked against both, on the same endpoint.
 */

const PREFIX = 'emptest'
const PASSWORD = 'CorrectHorseBattery1'

/** None of the three sensitive blocks — what the scope tests read with. */
const NO_SENSITIVE = { includeCompensation: false, includeBank: false, includeIdentity: false, includeLogins: false, today: '2026-10-03', lifecycleOf: { everybody: false, employeeId: null, notTheirs: [] } } as const

const app = createApp()

let orgId = ''
let otherOrgId = ''
let managerEmpId = ''
let reportEmpId = ''
let strangerEmpId = ''
let otherCompanyEmpId = ''

const tokens: Record<string, string> = {}

async function cleanup(): Promise<void> {
  await prisma.employeeFinancial.deleteMany({ where: { employee: { employeeCode: { startsWith: PREFIX } } } })
  await prisma.employeeBankAccount.deleteMany({ where: { employee: { employeeCode: { startsWith: PREFIX } } } })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: { employee: { employeeCode: { startsWith: PREFIX } } } })
  await prisma.employee.deleteMany({ where: { employeeCode: { startsWith: PREFIX } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.department.deleteMany({ where: { name: { startsWith: PREFIX } } })
  await prisma.designation.deleteMany({ where: { name: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

/** Creates a user with a login and, optionally, an employee record. */
async function makeUser(
  role: 'super_admin' | 'hr' | 'manager' | 'accounts' | 'employee' | 'admin',
  options: { withEmployee?: boolean; reportsTo?: string } = {},
): Promise<{ employeeId: string | null; token: string }> {
  const email = `${PREFIX}-${role}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })

  let employeeId: string | null = null
  if (options.withEmployee !== false) {
    const employee = await prisma.employee.create({
      data: {
        organizationId: orgId,
        memberships: { connect: { id: membership.id } },
        employeeCode: `${PREFIX}-${role}`,
        fullName: `${role} person`,
        reportingManagerId: options.reportsTo ?? null,
      },
    })
    employeeId = employee.id
  }

  const res = await request(app)
    .post('/api/auth/login')
    .send({ identifier: email, password: PASSWORD })

  tokens[role] = res.body.data.accessToken
  return { employeeId, token: res.body.data.accessToken }
}

function listAs(role: string) {
  return request(app).get('/api/employees').set('Authorization', `Bearer ${tokens[role]}`)
}

function getAs(role: string, id: string) {
  return request(app).get(`/api/employees/${id}`).set('Authorization', `Bearer ${tokens[role]}`)
}

beforeAll(async () => {
  await cleanup()

  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org` } })
  orgId = org.id
  const other = await prisma.organization.create({ data: { name: `${PREFIX}-other` } })
  otherOrgId = other.id

  const department = await prisma.department.create({
    data: { organizationId: orgId, name: `${PREFIX}-Sales` },
  })
  const designation = await prisma.designation.create({
    data: { organizationId: orgId, name: `${PREFIX}-Executive` },
  })

  await makeUser('super_admin')
  await makeUser('hr')
  await makeUser('accounts')
  await makeUser('admin')

  const manager = await makeUser('manager')
  managerEmpId = manager.employeeId!

  // Reports to the manager, so DIRECT_REPORTS scope has something to find.
  const report = await makeUser('employee', { reportsTo: managerEmpId })
  reportEmpId = report.employeeId!

  // In the same company but under nobody — the manager must NOT see this one.
  const stranger = await prisma.employee.create({
    data: {
      organizationId: orgId,
      employeeCode: `${PREFIX}-stranger`,
      fullName: 'Unmanaged Stranger',
      departmentId: department.id,
      designationId: designation.id,
    },
  })
  strangerEmpId = stranger.id

  // Sensitive data, attached to the stranger so every role's view of one row
  // can be compared directly.
  // Components are rows now: the catalogue first, then the amounts against it.
  const [basicComponent, hraComponent, shiftComponent] = await Promise.all(
    [
      { code: 'BASIC', label: 'Basic', displayOrder: 1, countsForPf: true },
      { code: 'HRA', label: 'House Rent Allowance', displayOrder: 3, countsForPf: false },
      // A component the company added itself. It has no column anywhere and
      // never did — which is the point of components being rows.
      { code: 'SHIFT', label: 'Shift Allowance', displayOrder: 7, countsForPf: false },
    ].map((c) => prisma.salaryComponent.create({ data: { organizationId: orgId, ...c } })),
  )

  await prisma.employeeFinancial.create({
    data: {
      organizationId: orgId,
      employeeId: strangerEmpId,
      ctc: 900000,
      effectiveFrom: new Date('2026-04-01'),
      components: {
        create: [
          { organizationId: orgId, salaryComponentId: basicComponent!.id, amount: 30000 },
          { organizationId: orgId, salaryComponentId: hraComponent!.id, amount: 15000 },
          { organizationId: orgId, salaryComponentId: shiftComponent!.id, amount: 5000 },
        ],
      },
    },
  })
  await prisma.employeeBankAccount.create({
    data: {
      organizationId: orgId,
      employeeId: strangerEmpId,
      bankName: 'HDFC Bank',
      accountHolderName: 'Unmanaged Stranger',
      accountNumber: '00123456789',
      ifsc: 'HDFC0001234',
    },
  })
  await prisma.employeeStatutoryIdentity.create({
    data: {
      organizationId: orgId,
      employeeId: strangerEmpId,
      pan: 'ABCDE1234F',
      ptState: 'Maharashtra',
    },
  })

  // A different company entirely.
  const foreign = await prisma.employee.create({
    data: {
      organizationId: otherOrgId,
      employeeCode: `${PREFIX}-foreign`,
      fullName: 'Someone Else Entirely',
    },
  })
  otherCompanyEmpId = foreign.id

  // Archived — hidden from the default list.
  await prisma.employee.create({
    data: {
      organizationId: orgId,
      employeeCode: `${PREFIX}-archived`,
      fullName: 'Left The Company',
      archivedAt: new Date(),
    },
  })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('which people you can see', () => {
  it('shows the whole company to HR', async () => {
    const res = await listAs('hr')
    expect(res.status).toBe(200)
    const codes = res.body.data.map((e: { employee_id: string }) => e.employee_id)
    expect(codes).toContain(`${PREFIX}-stranger`)
    expect(codes).toContain(`${PREFIX}-manager`)
  })

  it('shows a manager the whole directory too', async () => {
    // §4.4 is explicit: "Employees | View all (read-only)", and the data-scope
    // note that follows limits them on ATTENDANCE AND LEAVE, not on the staff
    // list. A manager can look up anyone's extension; they cannot see anyone's
    // attendance but their team's.
    const res = await listAs('manager')
    const codes = res.body.data.map((e: { employee_id: string }) => e.employee_id)

    expect(res.status).toBe(200)
    expect(codes).toContain(`${PREFIX}-stranger`)
  })

  it('refuses an ordinary employee entirely', async () => {
    // §3.1 gives Employee no access to the Employees module at all — not a
    // narrowed list, none. They see their own details through the session.
    const res = await listAs('employee')
    expect(res.status).toBe(403)
  })

  it('refuses Accounts, who reach salary through payroll instead', async () => {
    // §4.5: "No access to: Employees page", while still being able to view
    // financial data within payslip context. Finance stays out of people ops.
    const res = await listAs('accounts')
    expect(res.status).toBe(403)
  })

  it('hides archived employees unless asked', async () => {
    const withoutArchived = await listAs('hr')
    const codes = withoutArchived.body.data.map((e: { employee_id: string }) => e.employee_id)
    expect(codes).not.toContain(`${PREFIX}-archived`)

    const withArchived = await request(app)
      .get('/api/employees?includeArchived=true')
      .set('Authorization', `Bearer ${tokens.hr}`)
    const all = withArchived.body.data.map((e: { employee_id: string }) => e.employee_id)
    expect(all).toContain(`${PREFIX}-archived`)
  })

  it('filters by search', async () => {
    const res = await request(app)
      .get('/api/employees?search=Stranger')
      .set('Authorization', `Bearer ${tokens.hr}`)

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].full_name).toBe('Unmanaged Stranger')
  })
})

describe('the data scope itself', () => {
  /**
   * Tested at the repository rather than over HTTP, because no role currently
   * combines employee:read with a narrowed scope — everyone who can open the
   * directory sees all of it.
   *
   * It is still tested, and deliberately so: attendance and leave (Days 11-14)
   * use this same machinery with DIRECT_REPORTS and SELF, and finding out then
   * that the filter was wrong would mean finding out with real attendance data
   * in front of a client.
   */
  it('DIRECT_REPORTS returns the manager and their reports, nobody else', async () => {
    const rows = await repo.list(
      forOrg(orgId),
      { scope: 'DIRECT_REPORTS', employeeId: managerEmpId },
      { ...NO_SENSITIVE, compensationScope: { scope: 'SELF', employeeId: null } },
    )

    const codes = rows.map((r) => r.employeeCode)
    expect(codes).toContain(`${PREFIX}-manager`)
    expect(codes).toContain(`${PREFIX}-employee`)
    expect(codes).not.toContain(`${PREFIX}-stranger`)
  })

  it('SELF returns exactly one row', async () => {
    const rows = await repo.list(
      forOrg(orgId),
      { scope: 'SELF', employeeId: reportEmpId },
      { ...NO_SENSITIVE, compensationScope: { scope: 'SELF', employeeId: null } },
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(reportEmpId)
  })

  it('returns NOTHING when a scoped caller has no employee record', async () => {
    // An operator with no Employee row manages nobody. The dangerous bug here
    // is matching `reportingManagerId: null`, which would return every
    // unmanaged employee in the company instead of none.
    const rows = await repo.list(
      forOrg(orgId),
      { scope: 'DIRECT_REPORTS', employeeId: null },
      { ...NO_SENSITIVE, compensationScope: { scope: 'SELF', employeeId: null } },
    )

    expect(rows).toEqual([])
  })

  it('gives a department scope with no department of their own only themselves, never everybody without one', async () => {
    // Day 21 implemented DEPARTMENT, which used to throw. The failure it must
    // never have is "no department" matching every other person with none.
    const rows = await repo.list(
      forOrg(orgId),
      { scope: 'DEPARTMENT', employeeId: managerEmpId, departmentId: null },
      { ...NO_SENSITIVE, compensationScope: { scope: 'SELF', employeeId: managerEmpId } },
    )
    expect(rows.map((r) => r.id)).toEqual([managerEmpId])
  })
})

describe('reading one employee by id', () => {
  it('lets HR read anyone in the company', async () => {
    const res = await getAs('hr', strangerEmpId)
    expect(res.status).toBe(200)
    expect(res.body.data.full_name).toBe('Unmanaged Stranger')
  })

  it('answers 404 — not 403 — for an employee of another company', async () => {
    // The row exists. Saying 403 would confirm that, and confirming which ids
    // are real employees is enough to map an organization one guess at a time.
    const res = await getAs('super_admin', otherCompanyEmpId)

    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('NOT_FOUND')
  })

  it('rejects a malformed id before touching the database', async () => {
    const res = await getAs('hr', 'not-a-uuid')
    expect(res.status).toBe(422)
  })
})

describe('which fields you can see', () => {
  it('gives HR the person, their PAN and their salary — but not their bank account (Day 22)', async () => {
    const res = await getAs('hr', strangerEmpId)

    expect(res.body.data.full_name).toBe('Unmanaged Stranger')
    // HR agrees salaries with the employee, so sees them on the record.
    expect(res.body.data).toHaveProperty('ctc')
    expect(res.body.data).not.toHaveProperty('bank_account')
    // HR does hold employee:identity:read — statutory filing needs the PAN.
    expect(res.body.data.pan).toBe('ABCDE1234F')
    expect(res.body.meta.fields).toEqual({
      compensation: true,
      bank: false,
      identity: true,
    })
  })

  it('never shows HR the salary of somebody above them in the company tree', async () => {
    const hrRecord = await prisma.employee.findFirstOrThrow({ where: { employeeCode: `${PREFIX}-hr` } })
    // The stranger becomes HR's manager: a senior.
    await prisma.employee.update({ where: { id: hrRecord.id }, data: { reportingManagerId: strangerEmpId } })
    try {
      const senior = await getAs('hr', strangerEmpId)
      expect(senior.status).toBe(200)
      expect(senior.body.data.full_name).toBe('Unmanaged Stranger')
      expect(senior.body.data).not.toHaveProperty('ctc')
    } finally {
      await prisma.employee.update({ where: { id: hrRecord.id }, data: { reportingManagerId: null } })
    }
  })

  it('gives super_admin all three, from the same endpoint', async () => {
    // This is the pair that matters: one URL, two roles, different fields.
    const res = await getAs('super_admin', strangerEmpId)

    expect(res.body.data.ctc).toBe(900000)
    expect(res.body.data.basic).toBe(30000)
    expect(res.body.data.bank_account).toBe('00123456789')
    expect(res.body.data.pan).toBe('ABCDE1234F')
    expect(res.body.meta.fields).toEqual({
      compensation: true,
      bank: true,
      identity: true,
    })
  })

  it('gives Admin neither salary, bank nor PAN', async () => {
    const res = await getAs('admin', strangerEmpId)

    expect(res.status).toBe(200)
    expect(res.body.data.full_name).toBe('Unmanaged Stranger')
    expect(res.body.data).not.toHaveProperty('ctc')
    expect(res.body.data).not.toHaveProperty('bank_account')
    expect(res.body.data).not.toHaveProperty('pan')
  })

  it('never sends the storage key for a bank proof', async () => {
    const res = await getAs('super_admin', strangerEmpId)
    expect(JSON.stringify(res.body)).not.toContain('proofKey')
    expect(res.body.data).not.toHaveProperty('proof_key')
  })

  it('reads salary components from rows, including ones that never had a column', async () => {
    const res = await getAs('super_admin', strangerEmpId)

    // The same flat keys every screen already reads, derived from the rows.
    expect(res.body.data.basic).toBe(30000)
    expect(res.body.data.hra).toBe(15000)

    // Incentive is entered per month, so a salary record carries no such key.
    expect(res.body.data).not.toHaveProperty('incentive')

    // A component this person is not paid is null, not zero.
    expect(res.body.data.da).toBeNull()

    // And the full list, in display order, for a screen that renders whatever
    // components the company has without knowing their names in advance.
    // Shift Allowance appears with no code change anywhere: a company adds a
    // component and it is on the record the same day.
    expect(res.body.data.components).toEqual([
      { code: 'BASIC', label: 'Basic', type: 'earning', amount: 30000 },
      { code: 'HRA', label: 'House Rent Allowance', type: 'earning', amount: 15000 },
      { code: 'SHIFT', label: 'Shift Allowance', type: 'earning', amount: 5000 },
    ])
  })

  it('reports an unknown salary as null, never as zero', async () => {
    // The manager has no financial record at all.
    const res = await getAs('super_admin', managerEmpId)

    expect(res.body.data.ctc).toBeNull()
    expect(res.body.data.basic).toBeNull()
    // Zero would read as "this person earns nothing", which is a different and
    // false statement. This is the fabricated-data habit the audit found.
    expect(res.body.data.ctc).not.toBe(0)
  })

  it('never derives a UAN from anything', async () => {
    const res = await getAs('super_admin', strangerEmpId)
    expect(res.body.data.pan).toBe('ABCDE1234F')
    // EPFO has not issued one. It stays null rather than being invented from
    // the PAN, which the old app did.
    expect(res.body.data.uan).toBeNull()
  })

  it('never exposes a password hash', async () => {
    const res = await listAs('super_admin')
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/)
  })
})

describe('permission to read employees at all', () => {
  it('refuses an unauthenticated request', async () => {
    const res = await request(app).get('/api/employees')
    expect(res.status).toBe(401)
  })
})
