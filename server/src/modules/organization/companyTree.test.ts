import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { toDateColumn, zonedToday } from '../../domain/shared/dates'

/**
 * Day 22 through the API: the company tree, the owner, Settings → Approvals,
 * "your own work goes up", and the two scopes that follow the tree.
 *
 *   owner (Super Admin, marked) ─┬─ sa2 (Super Admin)
 *                                ├─ hrHead (HR) ── hrExec (HR)
 *                                ├─ acHead (Accounts) ── accountant (Accounts)
 *                                └─ mgr (Manager) ── agent ── trainee
 *   loose (nobody above)         gone (left the company)
 */

const PREFIX = 'treetest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

type Who = 'owner' | 'sa2' | 'hrHead' | 'hrExec' | 'acHead' | 'accountant' | 'mgr' | 'agent' | 'trainee' | 'loose'
const PEOPLE: [Who, string, Who | null][] = [
  ['owner', 'super_admin', null],
  ['sa2', 'super_admin', 'owner'],
  ['hrHead', 'hr', 'owner'],
  ['hrExec', 'hr', 'hrHead'],
  ['acHead', 'accounts', 'owner'],
  ['accountant', 'accounts', 'acHead'],
  ['mgr', 'manager', 'owner'],
  ['agent', 'employee', 'mgr'],
  ['trainee', 'employee', 'agent'],
  ['loose', 'employee', null],
]

let orgId = ''
let goneId = ''
let clId = ''
const emp = {} as Record<Who, string>
const tokens = {} as Record<Who, string>
const names = {} as Record<Who, string>

const as = (who: Who) => `Bearer ${tokens[who]}`
const get = (who: Who, url: string) => request(app).get(url).set('Authorization', as(who))
const put = (who: Who, url: string, body: object) => request(app).put(url).set('Authorization', as(who)).send(body)
const patch = (who: Who, url: string, body: object) => request(app).patch(url).set('Authorization', as(who)).send(body)
const post = (who: Who, url: string, body: object) => request(app).post(url).set('Authorization', as(who)).send(body)

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.organization.updateMany({ where: { name: { startsWith: PREFIX } }, data: { ownerEmployeeId: null, leaveNoManagerApproverId: null } })
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employeeBankAccount.deleteMany({ where: org })
  await prisma.employeeMonthlyEntry.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  clId = (await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })).id

  for (const [who, role] of PEOPLE) {
    const user = await prisma.user.create({ data: { email: `${PREFIX}-${who.toLowerCase()}@example.com`, passwordHash: await hashPassword(PASSWORD) } })
    const m = await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
    names[who] = `${who[0]!.toUpperCase()}${who.slice(1)} Person`
    emp[who] = (await prisma.employee.create({
      data: { organizationId: orgId, membershipId: m.id, employeeCode: `${PREFIX}-${who}`, fullName: names[who], dateOfJoining: toDateColumn('2024-01-08') },
    })).id
  }
  for (const [who, , above] of PEOPLE) {
    if (above) await prisma.employee.update({ where: { id: emp[who] }, data: { reportingManagerId: emp[above] } })
  }
  goneId = (await prisma.employee.create({
    data: { organizationId: orgId, employeeCode: `${PREFIX}-gone`, fullName: 'Gone Person', archivedAt: new Date(), reportingManagerId: emp.mgr },
  })).id
  // Salaries, so "who sees whose" has something to show.
  for (const who of ['hrHead', 'agent', 'owner'] as const) {
    await prisma.employeeFinancial.create({ data: { organizationId: orgId, employeeId: emp[who], ctc: 600000, effectiveFrom: toDateColumn('2024-01-08') } })
  }
  for (const [who] of PEOPLE) {
    const res = await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-${who.toLowerCase()}@example.com`, password: PASSWORD })
    expect(res.status, who).toBe(200)
    tokens[who] = res.body.data.accessToken
  }
}, 60_000)

afterAll(cleanup)

describe('Settings → Company tree', () => {
  it('shows the Super Admin who reports to whom, and who has nobody above — and nobody else', async () => {
    const res = await get('owner', '/api/company-tree')
    expect(res.status).toBe(200)
    const people = res.body.data.people as { id: string; manager_id: string | null; role: string | null; is_owner: boolean }[]
    expect(people.find((p) => p.id === emp.agent)).toMatchObject({ manager_id: emp.mgr, role: 'Employee' })
    // Somebody who has left is not on the chart.
    expect(people.map((p) => p.id)).not.toContain(goneId)
    expect(res.body.data.owner_id).toBeNull()
    // No owner marked yet: the person at the top is listed with the others.
    expect([...res.body.data.unplaced].sort()).toEqual([emp.owner, emp.loose].sort())
    expect((await get('hrHead', '/api/company-tree')).status).toBe(403)
  })

  it('marks the owner only on somebody holding the Super Admin panel, and once', async () => {
    const version = (await get('owner', '/api/company-tree')).body.data.version as string
    const notSa = await put('owner', '/api/company-tree/owner', { employeeId: emp.hrHead, version })
    expect(notSa.status).toBe(400)
    expect(notSa.body.error.message).toMatch(/must hold the Super Admin panel/)

    expect((await put('owner', '/api/company-tree/owner', { employeeId: emp.owner, version })).status).toBe(204)
    const after = await get('owner', '/api/company-tree')
    expect(after.body.data.owner_id).toBe(emp.owner)
    expect(after.body.data.unplaced).toEqual([emp.loose])
    // The copy read before is out of date now.
    expect((await put('owner', '/api/company-tree/owner', { employeeId: emp.sa2, version })).status).toBe(409)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'company.owner_marked' } })
    expect(log.entityId).toBe(emp.owner)
  })

  it('takes the reporting manager off a person marked owner — they sit at the top', async () => {
    const version = (await get('owner', '/api/company-tree')).body.data.version as string
    expect((await put('owner', '/api/company-tree/owner', { employeeId: emp.sa2, version })).status).toBe(204)
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.sa2 } })).reportingManagerId).toBeNull()
    // Back as it was: the owner is the owner, sa2 under them.
    const again = (await get('owner', '/api/company-tree')).body.data.version as string
    expect((await put('owner', '/api/company-tree/owner', { employeeId: emp.owner, version: again })).status).toBe(204)
    expect((await patch('owner', `/api/employees/${emp.sa2}`, { reportingManagerId: emp.owner })).status).toBe(200)
  })
})

describe('moving people', () => {
  it('refuses a reporting line that would loop, a person under themselves, or under somebody who has left', async () => {
    const loop = await patch('owner', `/api/employees/${emp.mgr}`, { reportingManagerId: emp.trainee })
    expect(loop.status).toBe(400)
    expect(loop.body.error.message).toBe(`${names.trainee} already reports to ${names.mgr}, directly or through others, so this would make the company tree go in a loop.`)
    expect((await patch('owner', `/api/employees/${emp.agent}`, { reportingManagerId: emp.agent })).body.error.message).toBe('Somebody cannot report to themselves.')
    expect((await patch('owner', `/api/employees/${emp.agent}`, { reportingManagerId: goneId })).body.error.message).toBe('Gone Person has left the company, so nobody can report to them.')
    // The owner sits at the top.
    expect((await patch('owner', `/api/employees/${emp.owner}`, { reportingManagerId: emp.mgr })).body.error.message).toMatch(/the owner, at the top of the company tree/)
  })

  it('never lets anybody but the Super Admin move a person under themselves, or under anybody below them', async () => {
    // HR could otherwise take over the leave of anybody it may edit.
    const toSelf = await patch('hrHead', `/api/employees/${emp.agent}`, { reportingManagerId: emp.hrHead })
    expect(toSelf.status).toBe(403)
    expect(toSelf.body.error.message).toMatch(/would make their leave and their work yours to decide/)
    expect((await patch('hrHead', `/api/employees/${emp.agent}`, { reportingManagerId: emp.hrExec })).status).toBe(403)
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.agent } })).reportingManagerId).toBe(emp.mgr)
    // Moving somebody elsewhere is still HR's to do.
    expect((await patch('hrHead', `/api/employees/${emp.loose}`, { reportingManagerId: emp.mgr })).status).toBe(200)
    expect((await patch('hrHead', `/api/employees/${emp.loose}`, { reportingManagerId: null })).status).toBe(200)
  })

  it('places somebody with nobody above, and says where in the log', async () => {
    const res = await patch('owner', `/api/employees/${emp.loose}`, { reportingManagerId: emp.mgr })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect((await get('owner', '/api/company-tree')).body.data.unplaced).toEqual([])
    const audit = await get('owner', '/api/audit-log?category=people')
    expect((audit.body.data as { summary: string }[]).map((r) => r.summary)).toContain(`Changed ${names.loose}’s reporting manager; now reports to ${names.mgr}`)
    await patch('owner', `/api/employees/${emp.loose}`, { reportingManagerId: null })
  })
})

describe('Settings → Approvals', () => {
  it('starts at the client’s choices, saves new ones with a version, and is the Super Admin’s alone', async () => {
    const start = await get('owner', '/api/company-tree/approvals')
    expect(start.status).toBe(200)
    expect(start.body.data).toMatchObject({ no_manager_approver_id: null, backup: 'super_admin', reversal: 'manager_or_super_admin' })

    const saved = await put('owner', '/api/company-tree/approvals', { noManagerApproverId: emp.hrHead, backup: 'next_up', reversal: 'super_admin_only', version: start.body.data.version })
    expect(saved.status).toBe(200)
    expect(saved.body.data).toMatchObject({ no_manager_approver_id: emp.hrHead, no_manager_approver_name: names.hrHead, backup: 'next_up', reversal: 'super_admin_only' })
    // Out of date now.
    expect((await put('owner', '/api/company-tree/approvals', { noManagerApproverId: null, backup: 'super_admin', reversal: 'manager_or_super_admin', version: start.body.data.version })).status).toBe(409)
    const log = await get('owner', '/api/audit-log?category=settings')
    expect((log.body.data as { summary: string }[])[0]!.summary).toBe(
      `Changed the approval settings: leave of people with nobody above now goes to ${names.hrHead}; when a manager is away, the manager’s own manager can decide instead; approved leave can be cancelled by only the Super Admin`,
    )

    // Nobody who has left can be named.
    const left = await put('owner', '/api/company-tree/approvals', { noManagerApproverId: goneId, backup: 'next_up', reversal: 'super_admin_only', version: saved.body.data.version })
    expect(left.status).toBe(400)
    expect((await get('hrHead', '/api/company-tree/approvals')).status).toBe(403)

    expect((await put('owner', '/api/company-tree/approvals', { noManagerApproverId: null, backup: 'super_admin', reversal: 'manager_or_super_admin', version: saved.body.data.version })).status).toBe(200)
  })
})

describe('your own work goes up the company tree', () => {
  const yesterday = () => zonedToday(new Date(Date.now() - 86_400_000), 'Asia/Kolkata')
  const mark = (who: Who, target: Who) => post(who, '/api/attendance/mark', { employeeId: emp[target], date: yesterday(), status: 'present' })
  const bank = (who: Who, target: Who) =>
    put(who, `/api/payroll/employees/${emp[target]}/bank-account`, { bankName: 'HDFC Bank', accountHolderName: names[target].toUpperCase(), accountNumber: '000123456789', ifsc: 'HDFC0001234', accountType: 'Savings', markVerified: true })

  it('sends a bank account’s check to the person above — not to the accountant themselves, nor another accountant', async () => {
    const own = await bank('accountant', 'accountant')
    expect(own.status).toBe(403)
    expect(own.body.error.message).toBe(`You cannot check your own bank account. It goes to the person above you: ${names.acHead}.`)
    // The accountant cannot check their head's either: a junior, not above.
    const junior = await bank('accountant', 'acHead')
    expect(junior.status).toBe(403)
    expect(junior.body.error.message).toBe(`${names.acHead} does this kind of work too, so their bank account is done by the people above them. Ask ${names.owner}.`)
    // The person above does it.
    expect((await bank('acHead', 'accountant')).status).toBe(200)
    // And the list says, row by row, what the screen may offer.
    const list = await get('accountant', '/api/payroll/bank-accounts')
    const row = (id: string) => (list.body.data as { employee_id: string; may_check: boolean; check_goes_to: string | null }[]).find((r) => r.employee_id === id)
    expect(row(emp.accountant)).toMatchObject({ may_check: false, check_goes_to: names.acHead })
    expect(row(emp.agent)).toMatchObject({ may_check: true, check_goes_to: null })
  })

  it('sends HR’s own attendance up the tree — the three checks that did not exist before Day 22', async () => {
    const own = await mark('hrExec', 'hrExec')
    expect(own.status).toBe(403)
    expect(own.body.error.message).toBe(`You cannot mark or correct your own attendance. It goes to the person above you: ${names.hrHead}.`)
    expect((await mark('hrExec', 'hrHead')).status).toBe(403)
    expect([200, 201]).toContain((await mark('hrHead', 'hrExec')).status)
    // An ordinary employee's day, as before: anybody holding the right.
    expect([200, 201]).toContain((await mark('hrExec', 'agent')).status)
  })

  it('refuses entering your own incentive or salary', async () => {
    const incentive = await put('hrExec', '/api/payroll/monthly-entries', { employeeId: emp.hrExec, componentCode: 'INCENTIVE', year: 2026, month: 8, amount: 1000 })
    expect(incentive.status).toBe(403)
    expect(incentive.body.error.message).toBe(`You cannot enter your own incentive. It goes to the person above you: ${names.hrHead}.`)
    const salary = await put('accountant', `/api/payroll/employees/${emp.accountant}/salary`, { effectiveFrom: '2026-09-01', ctc: 400000, components: [{ code: 'BASIC', amount: 30000 }] })
    expect(salary.status).toBe(403)
    expect(salary.body.error.message).toBe(`You cannot enter or change your own salary. It goes to the person above you: ${names.acHead}.`)
  })

  it('keeps a senior’s incentive out of HR’s sight and reach — an incentive is pay', async () => {
    const incentive = await prisma.salaryComponent.create({ data: { organizationId: orgId, code: 'INCENTIVE', label: 'Incentive', entry: 'monthly' } })
    await prisma.employeeMonthlyEntry.create({ data: { organizationId: orgId, employeeId: emp.owner, salaryComponentId: incentive.id, year: 2026, month: 8, amount: 50000 } })
    await prisma.employeeMonthlyEntry.create({ data: { organizationId: orgId, employeeId: emp.agent, salaryComponentId: incentive.id, year: 2026, month: 8, amount: 2000 } })
    const list = await get('hrExec', '/api/payroll/monthly-entries?year=2026&month=8')
    expect(list.status).toBe(200)
    expect((list.body.data as { employee_id: string }[]).map((e) => e.employee_id)).toEqual([emp.agent])
    const blocked = (list.body.meta.blocked as { employee_id: string }[]).map((b) => b.employee_id)
    expect(blocked).toEqual(expect.arrayContaining([emp.owner, emp.hrHead, emp.hrExec]))
    // …and only them: everybody else's incentive is HR's to enter.
    expect(blocked).not.toContain(emp.agent)
    expect(blocked).not.toContain(emp.trainee)
    // Setting it is refused as if the person were not there.
    const put2 = await put('hrExec', '/api/payroll/monthly-entries', { employeeId: emp.owner, componentCode: 'INCENTIVE', year: 2026, month: 8, amount: 1 })
    expect(put2.status).toBe(404)
    // Accounts, who opens Payroll and sees every salary there, sees it.
    const accounts = await get('acHead', '/api/payroll/monthly-entries?year=2026&month=8')
    expect((accounts.body.data as { employee_id: string }[]).map((e) => e.employee_id).sort()).toEqual([emp.agent, emp.owner].sort())
  })

  it('sends HR’s own leave balance up the tree', async () => {
    const adjust = (who: Who, target: Who) => post(who, '/api/leave-balances/adjustments', { employeeId: emp[target], leaveTypeId: clId, days: 1, note: 'Correction' })
    expect((await adjust('hrExec', 'hrExec')).body.error.message).toBe(`You cannot correct your own leave balance. It goes to the person above you: ${names.hrHead}.`)
    expect((await adjust('hrExec', 'hrHead')).status).toBe(403)
    expect((await adjust('hrHead', 'hrExec')).status).toBe(201)
    const balances = await get('hrExec', '/api/leave-balances')
    const row = (id: string) => (balances.body.data.people as { employee_id: string; may_correct: boolean; correction_goes_to: string | null }[]).find((p) => p.employee_id === id)
    expect(row(emp.hrExec)).toMatchObject({ may_correct: false, correction_goes_to: names.hrHead })
    expect(row(emp.agent)).toMatchObject({ may_correct: true })
  })
})

describe('with no owner marked', () => {
  it('says to mark the owner when nobody could do a top Super Admin’s own work', async () => {
    const rules = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select: { ownerEmployeeId: true } })
    await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: null } })
    try {
      const res = await post('owner', '/api/attendance/mark', { employeeId: emp.owner, date: zonedToday(new Date(Date.now() - 86_400_000), 'Asia/Kolkata'), status: 'present' })
      expect(res.status).toBe(403)
      expect(res.body.error.message).toMatch(/no owner is marked\. Mark the owner in Settings → Company tree/)
    } finally {
      await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: rules.ownerEmployeeId } })
    }
  })
})

describe('the two scopes that follow the tree', () => {
  it('“Whole company, except seniors” shows HR every salary but their seniors’', async () => {
    const own = (who: Who) => get('hrExec', `/api/employees/${emp[who]}`)
    expect((await own('agent')).body.data).toHaveProperty('ctc')
    // Above hrExec: their head and the owner.
    expect((await own('hrHead')).body.data).not.toHaveProperty('ctc')
    expect((await own('owner')).body.data).not.toHaveProperty('ctc')
  })

  it('counts the owner and the Super Admins as seniors of an HR person nobody has placed yet', async () => {
    await prisma.employee.update({ where: { id: emp.hrHead }, data: { reportingManagerId: null } })
    try {
      const view = (who: Who) => get('hrHead', `/api/employees/${emp[who]}`)
      // Nobody above hrHead in the tree — the owner's salary still stays hidden.
      expect((await view('owner')).body.data).not.toHaveProperty('ctc')
      expect((await view('agent')).body.data).toHaveProperty('ctc')
    } finally {
      await prisma.employee.update({ where: { id: emp.hrHead }, data: { reportingManagerId: emp.owner } })
    }
  })

  it('“Everybody under them” reaches every level below, and nobody beside', async () => {
    const res = await post('owner', '/api/roles', {
      name: 'Wing Lead',
      description: '',
      parentKey: 'super_admin',
      permissions: ['employee:read'],
      scopes: { employee: 'ALL_REPORTS' },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const m = await prisma.employee.findUniqueOrThrow({ where: { id: emp.mgr }, select: { membershipId: true } })
    expect((await put('owner', `/api/users/${m.membershipId}/role`, { role: 'wing_lead' })).status).toBe(200)
    const login = await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-mgr@example.com`, password: PASSWORD })
    const list = await request(app).get('/api/employees').set('Authorization', `Bearer ${login.body.data.accessToken}`)
    expect(list.status).toBe(200)
    expect((list.body.data as { id: string }[]).map((e) => e.id).sort()).toEqual([emp.mgr, emp.agent, emp.trainee].sort())
  })
})
