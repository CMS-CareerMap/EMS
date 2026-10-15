import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { isoInstant, toDateColumn } from '../../domain/shared/dates'

/**
 * Whose payroll (client, 15 Oct 2026), working as "Whose leave" does: a
 * payroll role limited to one department is shown that department's
 * salaries, bank accounts, payslips and bank file lines and nobody else's
 * (404 outside, as everywhere); its share of a run is its people's figures,
 * never the company's; what it may do is its permissions, and a refusal names
 * only its people, the rest counted.
 */

const PREFIX = 'payscope'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

let orgId = ''
const tokens: Record<string, string> = {}
const people: Record<'lead' | 'rep' | 'ops', string> = { lead: '', rep: '', ops: '' }
let roleId = ''
let runId = ''

const SALARY = [
  { code: 'BASIC', amount: 20_000 },
  { code: 'HRA', amount: 8_000 },
]

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.payslipLine.deleteMany({ where: org })
  await prisma.payslip.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.employeeBankAccount.deleteMany({ where: org })
  await prisma.esiCoverage.deleteMany({ where: org })
  await prisma.employeeSalaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.notification.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.department.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function login(key: string, role: string, employeeId: string | null = null) {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active', employeeId },
  })
  tokens[key] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
}

const as = (key: string) => `Bearer ${tokens[key]}`
const get = (path: string, key: string) => request(app).get(`/api${path}`).set('Authorization', as(key))
const send = (method: 'post' | 'put' | 'delete', path: string, key: string, body: Record<string, unknown> = {}) =>
  request(app)[method](`/api${path}`).set('Authorization', as(key)).send(body)

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org` } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01') } })
  for (const c of [
    { code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    { code: 'HRA', label: 'House Rent Allowance', displayOrder: 3 },
  ]) {
    await prisma.salaryComponent.create({ data: { organizationId: orgId, ...c } })
  }
  const sales = (await prisma.department.create({ data: { organizationId: orgId, name: 'Sales' } })).id
  const ops = (await prisma.department.create({ data: { organizationId: orgId, name: 'Operations' } })).id
  const hire = async (code: string, name: string, departmentId: string) =>
    (await prisma.employee.create({ data: { organizationId: orgId, employeeCode: `${PREFIX}-${code}`, fullName: name, departmentId, dateOfJoining: toDateColumn('2026-01-01') } })).id
  people.lead = await hire('lead', 'Sales Lead', sales)
  people.rep = await hire('rep', 'Sales Rep', sales)
  people.ops = await hire('ops', 'Ops Person', ops)

  // A payroll role for one department, as the Super Admin would make it on the Roles screen.
  const top = await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'super_admin' } })
  roleId = (await prisma.role.create({
    data: {
      organizationId: orgId, key: 'payroll_sales', name: 'Payroll Sales', parentId: top.id,
      permissions: ['dashboard:read', 'employee:read', 'employee:compensation:read', 'payroll:structure:read', 'payroll:structure:manage', 'payroll:entry:manage', 'employee:bank:read', 'employee:bank:manage', 'report:read'],
      scopes: { employee: 'ORGANIZATION', compensation: 'DEPARTMENT', payroll: 'DEPARTMENT' },
    },
  })).id

  await login('accounts', 'accounts')
  await login('sa', 'super_admin')
  await login('sales', 'payroll_sales', people.lead)

  // By the Super Admin: the Sales lead enters salaries too, so theirs goes up the tree (Day 22).
  for (const id of Object.values(people)) {
    const res = await send('put', `/payroll/employees/${id}/salary`, 'sa', { effectiveFrom: '2026-01-01', ctc: 360_000, components: SALARY })
    expect(res.status).toBe(200)
  }
  const run = await send('post', '/payroll-runs', 'accounts', { year: 2026, month: 8 })
  expect(run.status).toBe(201)
  runId = run.body.data.id
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('a payroll role for one department', () => {
  it('is told its reach with the session', async () => {
    const res = await get('/auth/session', 'sales')
    expect(res.body.data.user.payrollReach).toBe('DEPARTMENT')
    expect((await get('/auth/session', 'accounts')).body.data.user.payrollReach).toBe('ORGANIZATION')
  })

  it('sees and sets the salaries of its department only', async () => {
    const roster = await get('/payroll/employees', 'sales')
    expect(roster.status).toBe(200)
    expect(roster.body.data.map((r: { employee_id: string }) => r.employee_id).sort()).toEqual([people.lead, people.rep].sort())
    expect((await get('/payroll/employees', 'accounts')).body.data).toHaveLength(3)

    expect((await get(`/payroll/employees/${people.ops}/salary`, 'sales')).status).toBe(404)
    expect((await get(`/payroll/employees/${people.rep}/salary`, 'sales')).status).toBe(200)
    expect((await send('put', `/payroll/employees/${people.ops}/salary`, 'sales', { effectiveFrom: '2026-11-01', ctc: 400_000, components: SALARY })).status).toBe(404)
    expect((await send('post', '/payroll/calculate', 'sales', { employeeId: people.ops, year: 2026, month: 8 })).status).toBe(404)
    expect((await send('post', '/payroll/calculate', 'sales', { employeeId: people.rep, year: 2026, month: 8 })).status).toBe(200)
  })

  it('keeps the bank accounts of its department only — on Payroll and on the profile', async () => {
    const list = await get('/payroll/bank-accounts', 'sales')
    expect(list.body.data.map((r: { employee_id: string }) => r.employee_id).sort()).toEqual([people.lead, people.rep].sort())
    const account = { bankName: 'HDFC Bank', accountHolderName: 'OPS PERSON', accountNumber: '123456789012', ifsc: 'HDFC0001234' }
    expect((await send('put', `/payroll/employees/${people.ops}/bank-account`, 'sales', account)).status).toBe(404)
    expect((await send('put', `/payroll/employees/${people.ops}/bank-account`, 'accounts', account)).status).toBe(200)
    const saved = await prisma.employeeBankAccount.findFirstOrThrow({ where: { employeeId: people.ops } })
    expect((await send('post', `/payroll/employees/${people.ops}/bank-account/verify`, 'sales', { decision: 'verified', accountUpdatedAt: isoInstant(saved.updatedAt) })).status).toBe(404)

    // Outside the reach, the profile leaves the account OUT — never "none recorded".
    const ops = await get(`/employees/${people.ops}`, 'sales')
    expect(ops.status).toBe(200)
    expect(ops.body.data).not.toHaveProperty('bank_name')
    const rep = await get(`/employees/${people.rep}`, 'sales')
    expect(rep.body.data).toHaveProperty('bank_name', null)
  })

  it('sees its share of a run — its people’s figures, never the company’s', async () => {
    const whole = (await get(`/payroll-runs/${runId}`, 'accounts')).body.data
    expect(whole.partial).toBe(false)
    expect(whole.payslips).toHaveLength(3)

    const share = (await get(`/payroll-runs/${runId}`, 'sales')).body.data
    expect(share.partial).toBe(true)
    expect(share.payslips.map((p: { employee_id: string }) => p.employee_id).sort()).toEqual([people.lead, people.rep].sort())
    const net = whole.payslips.filter((p: { employee_id: string }) => p.employee_id !== people.ops).reduce((s: number, p: { net_payable: number }) => s + p.net_payable, 0)
    expect(share.employee_count).toBe(2)
    expect(share.net_payable).toBeCloseTo(net, 2)
    expect(share.net_payable).toBeLessThan(whole.net_payable)
    expect(share.warnings).toEqual([])

    const listed = (await get('/payroll-runs', 'sales')).body.data.find((r: { id: string }) => r.id === runId)
    expect(listed).toMatchObject({ partial: true, employee_count: 2 })
    expect(listed.net_payable).toBeCloseTo(net, 2)

    const home = (await get('/dashboard/payroll', 'sales')).body.data
    expect(home.latest).toMatchObject({ partial: true, employees: 2 })

    const opsSlip = whole.payslips.find((p: { employee_id: string }) => p.employee_id === people.ops)
    expect((await get(`/payroll-runs/${runId}/payslips/${opsSlip.id}`, 'sales')).status).toBe(404)
    expect((await get(`/payroll-runs/${runId}/payslips/${opsSlip.id}/pdf`, 'sales')).status).toBe(404)
  })

  it('checks the next month for its people only', async () => {
    const res = await get('/payroll-runs/readiness?year=2026&month=9', 'sales')
    expect(res.status).toBe(200)
    expect(res.body.data.employees.map((e: { employee_id: string }) => e.employee_id).sort()).toEqual([people.lead, people.rep].sort())
  })

  it('reports its people’s payroll, the chart summed over the same payslips', async () => {
    const res = await get('/reports/payroll-summary?year=2026&month=8', 'sales')
    expect(res.status).toBe(200)
    expect(res.body.data.rows).toHaveLength(2)
    expect(res.body.data.chart.label).toMatch(/the people in your payroll/)
    const august = res.body.data.chart.points.at(-1).value
    expect(august).toBeCloseTo(res.body.data.totals.net, 2)
  })

  it('does what its role holds, as any module — shown its own people throughout, the others counted and never named', async () => {
    // The company's components and the bank's layout: by the permission alone.
    expect((await send('post', '/payroll/components', 'sales', { code: 'SALES_X', label: 'Sales Extra', type: 'earning' })).status).toBe(201)
    const t = (await get('/payroll/bank-file-template', 'sales')).body.data
    const layout = await send('put', '/payroll/bank-file-template', 'sales', {
      columns: t.columns.map((c: { header: string; field: string; text: string | null }) => ({ header: c.header, field: c.field, ...(c.text === null ? {} : { text: c.text }) })),
      includeHeader: t.include_header, dateFormat: t.date_format, narration: t.narration, onlyVerified: t.only_verified,
    })
    expect(layout.status).toBe(200)

    // Given the month's steps on the Roles screen, with "Their department".
    const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } })
    await prisma.role.update({ where: { id: roleId }, data: { permissions: [...role.permissions, 'payroll:run:create', 'payroll:run:approve'] } })
    try {
      const recalculated = await send('post', `/payroll-runs/${runId}/recalculate`, 'sales')
      expect(recalculated.status).toBe(200)
      expect(recalculated.body.data).toMatchObject({ partial: true, employee_count: 2 })

      // August has no attendance: every day was paid on no record. Asked about — for its own people by name.
      const asked = await send('post', `/payroll-runs/${runId}/approve`, 'sales')
      expect(asked.status).toBe(422)
      const named = asked.body.error.details.employees.map((e: { employee_id: string }) => e.employee_id).sort()
      expect(named).toEqual([people.lead, people.rep].sort())
      expect(asked.body.error.details.others).toBe(1)
      const approved = await send('post', `/payroll-runs/${runId}/approve`, 'sales', { confirmAssumedDays: true })
      expect(approved.status).toBe(200)
      expect(approved.body.data).toMatchObject({ status: 'approved', partial: true })

      // The bank file: its own people's lines only.
      const file = await get(`/payroll-runs/${runId}/bank-file/preview`, 'sales')
      expect(file.status).toBe(200)
      const lines = [...file.body.data.payments, ...file.body.data.excluded].map((l: { employee_id: string }) => l.employee_id)
      expect(lines.sort()).toEqual([people.lead, people.rep].sort())
      // …and it says so: the month's other payslip is not in it.
      expect(file.body.data).toMatchObject({ partial: true, others: 1 })
      const everybody = await get(`/payroll-runs/${runId}/bank-file/preview`, 'accounts')
      expect([...everybody.body.data.payments, ...everybody.body.data.excluded]).toHaveLength(3)
    } finally {
      await prisma.role.update({ where: { id: roleId }, data: { permissions: role.permissions } })
    }
  })

  it('“Whose payslips” lists and opens the paid payslips of exactly the people chosen — every choice, as the other modules', async () => {
    expect((await send('post', `/payroll-runs/${runId}/mark-paid`, 'accounts', { paidOn: '2026-09-01' })).status).toBe(200)
    const slipOf = async (who: string) => (await prisma.payslip.findFirstOrThrow({ where: { payrollRunId: runId, employeeId: who } })).id
    await prisma.employee.update({ where: { id: people.rep }, data: { reportingManagerId: people.lead } })
    const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } })
    const expected: Record<string, string[]> = {
      SELF: [people.lead],
      DIRECT_REPORTS: [people.lead, people.rep],
      DEPARTMENT: [people.lead, people.rep],
      ORGANIZATION: [people.lead, people.rep, people.ops],
    }
    try {
      for (const [scope, whom] of Object.entries(expected)) {
        await prisma.role.update({ where: { id: roleId }, data: { permissions: [...role.permissions, 'payslip:read'], scopes: { ...(role.scopes as object), payslip: scope } } })
        const list = await get('/payslips', 'sales')
        expect(list.status).toBe(200)
        expect(list.body.data).toMatchObject({ year: 2026, month: 8, months: [{ year: 2026, month: 8 }] })
        expect({ scope, shown: list.body.data.payslips.map((p: { employee_id: string }) => p.employee_id).sort() }).toEqual({ scope, shown: [...whom].sort() })
        // Opening one follows the same choice: inside it, the PDF; outside it, nothing there.
        expect((await get(`/payslips/${await slipOf(people.ops)}/pdf`, 'sales')).status).toBe(whom.includes(people.ops) ? 200 : 404)
      }
      expect((await get('/payslips?year=2026', 'sales')).status).toBe(422)
    } finally {
      await prisma.role.update({ where: { id: roleId }, data: { permissions: role.permissions, scopes: role.scopes as object } })
      await prisma.employee.update({ where: { id: people.rep }, data: { reportingManagerId: null } })
    }
  })

  it('a component on salaries cannot be archived — and the refusal names only its own people', async () => {
    const basic = (await get('/payroll/components/all', 'sales')).body.data.find((c: { code: string }) => c.code === 'BASIC')
    const res = await send('delete', `/payroll/components/${basic.id}`, 'sales')
    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/Sales Lead/)
    expect(res.body.error.message).toMatch(/Sales Rep/)
    expect(res.body.error.message).toMatch(/1 more person outside your payroll/)
    expect(res.body.error.message).not.toMatch(/Ops Person/)
  })

  it('what stops a month about people outside its payroll is counted, never named — and stops it all the same', async () => {
    // Ops Person with no salary: September cannot be run.
    await prisma.employeeSalaryComponent.deleteMany({ where: { financial: { employeeId: people.ops } } })
    await prisma.employeeFinancial.deleteMany({ where: { employeeId: people.ops } })
    const readiness = (await get('/payroll-runs/readiness?year=2026&month=9', 'sales')).body.data
    expect(readiness).toMatchObject({ blocked: true, others_blocking: 1, blockers: [] })
    const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } })
    await prisma.role.update({ where: { id: roleId }, data: { permissions: [...role.permissions, 'payroll:run:create'] } })
    try {
      const refused = await send('post', '/payroll-runs', 'sales', { year: 2026, month: 9 })
      expect(refused.status).toBe(422)
      expect(refused.body.error.details).toMatchObject({ blockers: [], others: 1 })
      expect(JSON.stringify(refused.body)).not.toMatch(/Ops Person/)
    } finally {
      await prisma.role.update({ where: { id: roleId }, data: { permissions: role.permissions } })
    }
    // Whoever has the whole company's payroll is told who.
    const told = (await get('/payroll-runs/readiness?year=2026&month=9', 'accounts')).body.data
    expect(told.blockers.map((b: { employee_id: string }) => b.employee_id)).toEqual([people.ops])
  })

  it('every “Whose payroll” choice reaches exactly whom the same choice reaches under Employees — all six', async () => {
    // A small tree: Ops Person above the Sales Lead; the Sales Rep under the lead; somebody in Operations under the rep.
    const deep = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: `${PREFIX}-deep`, fullName: 'Deep Report', departmentId: (await prisma.employee.findUniqueOrThrow({ where: { id: people.ops } })).departmentId, dateOfJoining: toDateColumn('2026-01-01'), reportingManagerId: people.rep },
    })).id
    await prisma.employee.update({ where: { id: people.lead }, data: { reportingManagerId: people.ops } })
    await prisma.employee.update({ where: { id: people.rep }, data: { reportingManagerId: people.lead } })
    const role = await prisma.role.findUniqueOrThrow({ where: { id: roleId } })
    const expected: Record<string, string[]> = {
      SELF: [people.lead],
      DIRECT_REPORTS: [people.lead, people.rep],
      ALL_REPORTS: [people.lead, people.rep, deep],
      DEPARTMENT: [people.lead, people.rep],
      ORGANIZATION_EXCEPT_ABOVE: [people.lead, people.rep, deep],
      ORGANIZATION: [people.lead, people.rep, people.ops, deep],
    }
    try {
      for (const [scope, whom] of Object.entries(expected)) {
        // The same choice under Employees and under Payroll.
        await prisma.role.update({ where: { id: roleId }, data: { scopes: { ...(role.scopes as object), employee: scope, payroll: scope } } })
        const payroll = (await get('/payroll/employees', 'sales')).body.data.map((r: { employee_id: string }) => r.employee_id).sort()
        const records = (await get('/employees?limit=100', 'sales')).body.data.map((e: { id: string }) => e.id).sort()
        expect({ scope, payroll }).toEqual({ scope, payroll: [...whom].sort() })
        expect({ scope, records }).toEqual({ scope, records: payroll })
      }
    } finally {
      await prisma.role.update({ where: { id: roleId }, data: { scopes: role.scopes as object } })
      await prisma.employee.updateMany({ where: { id: { in: [people.lead, people.rep] } }, data: { reportingManagerId: null } })
      await prisma.employee.delete({ where: { id: deep } })
    }
  })

  it('the migration gives every role with no payroll reach the one it had', async () => {
    // The migration's own UPDATE, run on roles made as they were before it: no "payroll" key.
    const sql = readFileSync(join(__dirname, '../../../prisma/schema/migrations/20261015120000_payroll_scope/migration.sql'), 'utf8')
    const update = sql.slice(sql.indexOf('UPDATE "Role"'), sql.indexOf(';', sql.indexOf('UPDATE "Role"')) + 1)
    expect(update).toMatch(/^UPDATE "Role"[\s\S]*WHERE NOT[\s\S]*;$/)
    const top = await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'super_admin' } })
    const old = {
      opens_payroll: { permissions: ['payroll:structure:read'], scopes: { compensation: 'DEPARTMENT' } },
      keeps_banks: { permissions: ['employee:bank:read'], scopes: {} },
      incentives: { permissions: ['employee:compensation:read', 'payroll:entry:manage'], scopes: { compensation: 'ORGANIZATION_EXCEPT_ABOVE' } },
      odd_value: { permissions: ['employee:compensation:read', 'payroll:entry:manage'], scopes: { compensation: 'EVERYONE' } },
      no_payroll: { permissions: ['leave:read'], scopes: { leave: 'ORGANIZATION' } },
      already_set: { permissions: ['payroll:structure:read'], scopes: { payroll: 'DEPARTMENT' } },
    }
    for (const [key, r] of Object.entries(old)) {
      await prisma.role.create({ data: { organizationId: orgId, key: `mig_${key}`, name: `Mig ${key}`, parentId: top.id, permissions: r.permissions, scopes: r.scopes } })
    }
    await prisma.$executeRawUnsafe(update)
    const reach = async (key: string) => ((await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, key: `mig_${key}` } })).scopes as Record<string, string>).payroll
    expect(await reach('opens_payroll')).toBe('ORGANIZATION')
    expect(await reach('keeps_banks')).toBe('ORGANIZATION')
    expect(await reach('incentives')).toBe('ORGANIZATION_EXCEPT_ABOVE')
    expect(await reach('odd_value')).toBe('SELF')
    expect(await reach('no_payroll')).toBe('SELF')
    expect(await reach('already_set')).toBe('DEPARTMENT')
    // The rest of each role's reach is untouched.
    expect(((await prisma.role.findFirstOrThrow({ where: { organizationId: orgId, key: 'mig_incentives' } })).scopes as Record<string, string>).compensation).toBe('ORGANIZATION_EXCEPT_ABOVE')
  })

  it('is saved with whatever “Whose payroll” is chosen, the month’s steps included', async () => {
    const res = await send('post', '/roles', 'sa', {
      name: 'Payroll Runner', description: '', parentKey: 'super_admin',
      permissions: ['payroll:structure:read', 'payroll:run:create', 'payroll:run:approve'], scopes: { payroll: 'DEPARTMENT' },
    })
    expect(res.status).toBe(201)
  })
})
