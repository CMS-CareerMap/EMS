import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { fromDateColumn, toDateColumn, zonedToday } from '../../domain/shared/dates'

/**
 * The Days 21–23 wrap-up review, through the API: each hole the review found,
 * shut, and each screen hint agreeing with the server.
 *
 *   boss (Super Admin) ─┬─ mgrM (Manager) ─┬─ hrA (HR, may also send password links)
 *                       │                  ├─ emp1
 *                       │                  └─ leaver
 *                       ├─ adm (Admin)
 *                       ├─ marker (Employee; given a custom role below)
 *                       └─ own2 (Super Admin, marked owner in one test)
 *   X (named for "nobody above") ── P (Manager) ─┬─ Q1
 *                                                └─ Q2
 *   U1, U2, U3 (nobody above)
 */

const PREFIX = 'wrapup'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

type Who = 'boss' | 'mgrM' | 'hrA' | 'emp1' | 'leaver' | 'adm' | 'marker' | 'own2' | 'X' | 'P' | 'Q1' | 'Q2' | 'U1' | 'U2' | 'U3'
const PEOPLE: [Who, string, Who | null][] = [
  ['boss', 'super_admin', null],
  ['mgrM', 'manager', 'boss'],
  ['hrA', 'hr', 'mgrM'],
  ['emp1', 'employee', 'mgrM'],
  ['leaver', 'employee', 'mgrM'],
  ['adm', 'admin', 'boss'],
  ['marker', 'employee', 'boss'],
  ['own2', 'super_admin', null],
  ['X', 'employee', null],
  ['P', 'manager', 'X'],
  ['Q1', 'employee', 'P'],
  ['Q2', 'employee', 'P'],
  ['U1', 'employee', null],
  ['U2', 'employee', null],
  ['U3', 'employee', null],
]

let orgId = ''
let clId = ''
const emp = {} as Record<Who, string>
const login = {} as Record<Who, string>
const users = {} as Record<Who, string>
const tokens = {} as Record<Who, string>
const names = {} as Record<Who, string>
const email = (who: string) => `${PREFIX}-${who.toLowerCase()}@example.com`

const as = (who: Who) => `Bearer ${tokens[who]}`
const get = (who: Who, url: string) => request(app).get(url).set('Authorization', as(who))
const post = (who: Who, url: string, body: object = {}) => request(app).post(url).set('Authorization', as(who)).send(body)
const put = (who: Who, url: string, body: object) => request(app).put(url).set('Authorization', as(who)).send(body)
const patch = (who: Who, url: string, body: object) => request(app).patch(url).set('Authorization', as(who)).send(body)
async function signIn(who: Who) {
  const res = await request(app).post('/api/auth/login').send({ identifier: email(who), password: PASSWORD })
  expect(res.status, `sign in ${who}`).toBe(200)
  tokens[who] = res.body.data.accessToken
}
async function giveRole(who: Who, role: string) {
  const res = await put('boss', `/api/users/${login[who]}/role`, { role })
  expect(res.status, JSON.stringify(res.body)).toBe(200)
  await signIn(who)
}

/** A Monday some weeks out, so nothing here clashes. */
function day(weeks: number, offset = 0): string {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + weeks * 7)
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1)
  date.setUTCDate(date.getUTCDate() + offset)
  return fromDateColumn(date)
}
const leaveYearOf = (d: string) => Number(d.slice(0, 4)) - (Number(d.slice(5, 7)) >= 4 ? 0 : 1)
const apply = (who: Who, from: string) => post(who, '/api/leave-requests', { leaveTypeId: clId, fromDate: from, toDate: from, reason: 'Family' })
const approvals = async () => (await get('boss', '/api/company-tree/approvals')).body.data as { no_manager_approver_id: string | null; no_manager_approver_can_sign_in: boolean; backup: string; reversal: string; version: string }

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  const people = { user: { email: { startsWith: PREFIX } } }
  await prisma.organization.updateMany({ where: { name: { startsWith: PREFIX } }, data: { ownerEmployeeId: null, leaveNoManagerApproverId: null } })
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.passwordResetToken.deleteMany({ where: people })
  await prisma.refreshToken.deleteMany({ where: people })
  await prisma.membership.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  clId = (await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })).id
  // HR here may also send password links — to show it still may not take over the person above it.
  await prisma.role.update({ where: { organizationId_key: { organizationId: orgId, key: 'hr' } }, data: { permissions: { push: ['user:invite'] } } })

  for (const [who, role] of PEOPLE) {
    const user = await prisma.user.create({ data: { email: email(who), passwordHash: await hashPassword(PASSWORD) } })
    users[who] = user.id
    names[who] = `${who} Person`
    emp[who] = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: `${PREFIX}-${who}`, fullName: names[who], dateOfJoining: toDateColumn('2024-01-08') },
    })).id
    login[who] = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active', employeeId: emp[who] } })).id
  }
  for (const [who, , above] of PEOPLE) {
    if (above) await prisma.employee.update({ where: { id: emp[who] }, data: { reportingManagerId: emp[above] } })
  }
  for (const who of ['emp1', 'leaver', 'Q1'] as const) {
    for (const year of new Set([leaveYearOf(day(3)), leaveYearOf(day(12))])) {
      await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp[who], leaveTypeId: clId, leaveYear: year, days: 12, reason: 'opening_grant' } })
    }
  }
  for (const [who] of PEOPLE) await signIn(who)
}, 120_000)

afterAll(cleanup)

describe('the company tree is the Super Admin’s', () => {
  it('stops HR handing somebody to a new hire whose invitation link HR holds', async () => {
    const ghost = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-ghost`, fullName: 'Ghost Person', login: { email: email('ghost'), role: 'employee' } })
    expect(ghost.status, JSON.stringify(ghost.body)).toBe(201)
    expect(ghost.body.meta.invite.token).toBeTruthy()
    const moved = await patch('hrA', `/api/employees/${emp.emp1}`, { reportingManagerId: ghost.body.data.id })
    expect(moved.status).toBe(403)
    expect(moved.body.error.message).toBe('Who somebody reports to is set by the Super Admin, on Settings → Company Tree. Ask the Super Admin to move them.')
    // Nor by clearing the line, which hands them to the "nobody above" approver.
    expect((await patch('hrA', `/api/employees/${emp.emp1}`, { reportingManagerId: null })).status).toBe(403)
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.emp1 } })).reportingManagerId).toBe(emp.mgrM)
  })

  it('reads a new hire back by the company, so a tree-scoped role keeps the answer', async () => {
    // A role whose employee reach is "everybody under them" adds somebody under
    // a grand-report: the reach was loaded before that person existed.
    const created = await post('boss', '/api/roles', {
      name: 'Branch Lead', description: '', parentKey: 'hr',
      permissions: ['employee:read', 'employee:create'], scopes: { employee: 'ALL_REPORTS' },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await giveRole('P', 'branch_lead')
    const hire = await post('P', '/api/employees', { employeeCode: `${PREFIX}-hire`, fullName: 'Hire Person', reportingManagerId: emp.Q1 })
    expect(hire.status, JSON.stringify(hire.body)).toBe(201)
    expect(hire.body.data.full_name).toBe('Hire Person')
    await giveRole('P', 'manager')
  })

  it('tells whoever decides a waiting request now, when its person is moved', async () => {
    const req = await apply('emp1', day(3))
    expect(req.status, JSON.stringify(req.body)).toBe(201)
    expect((await patch('boss', `/api/employees/${emp.emp1}`, { reportingManagerId: emp.adm })).status).toBe(200)
    const told = await prisma.notification.findMany({ where: { organizationId: orgId, userId: users.adm, entityId: req.body.data.id } })
    expect(told).toHaveLength(1)
    expect(told[0]!.message).toMatch(/After a change in the company tree, emp1 Person's waiting request is yours to decide/)
    expect((await patch('boss', `/api/employees/${emp.emp1}`, { reportingManagerId: emp.mgrM })).status).toBe(200)
    await post('emp1', `/api/leave-requests/${req.body.data.id}/withdraw`, {})
  })

  it('does not bring an owner mark back on somebody who now has a manager', async () => {
    const version = (await get('boss', '/api/company-tree')).body.data.version as string
    expect((await put('boss', '/api/company-tree/owner', { employeeId: emp.own2, version })).status).toBe(204)
    expect((await patch('boss', `/api/users/${login.own2}/status`, { status: 'inactive' })).status).toBe(200)
    // The mark does not count now, and the Super Admin places them under somebody.
    expect((await patch('boss', `/api/employees/${emp.own2}`, { reportingManagerId: emp.boss })).status).toBe(200)
    expect((await patch('boss', `/api/users/${login.own2}/status`, { status: 'active' })).status).toBe(200)
    expect((await get('boss', '/api/company-tree')).body.data.owner_id).toBeNull()
    await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: null } })
    await prisma.employee.update({ where: { id: emp.own2 }, data: { reportingManagerId: null } })
    await signIn('own2')
  })
})

describe('user management follows the tree as well as the role order', () => {
  it('refuses HR a password link for the manager it reports to — whose role is below HR’s', async () => {
    const above = await post('hrA', `/api/users/${login.mgrM}/password-link`)
    expect(above.status).toBe(403)
    expect(above.body.error.message).toBe('This person is above you in the company tree, so their logins are not yours to manage. Ask the Super Admin.')
    expect((await post('hrA', `/api/users/${login.emp1}/password-link`)).status).toBe(201)
  })

  it('refuses giving a role whose reach is measured from where its new holder sits', async () => {
    const created = await post('boss', '/api/roles', {
      name: 'Pay Viewer', description: '', parentKey: 'hr',
      permissions: ['employee:read', 'employee:compensation:read'], scopes: { employee: 'ORGANIZATION', compensation: 'ORGANIZATION_EXCEPT_ABOVE' },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    const res = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-pv`, fullName: 'PV Person', login: { email: email('pv'), role: 'pay_viewer' } })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toBe('You can give only a role below your own, with nothing you cannot do yourself.')
  })

  it('withdraws an invitation nobody used, so the right login can be added', async () => {
    const typo = await post('boss', `/api/employees/${emp.emp1}/logins`, { email: email('emp1.mgr.typo'), role: 'manager' })
    expect(typo.status, JSON.stringify(typo.body)).toBe(201)
    const id = typo.body.data.user.id as string
    expect((await post('boss', `/api/users/${id}/withdraw`)).status).toBe(204)
    expect(await prisma.membership.count({ where: { id } })).toBe(0)
    expect(await prisma.user.count({ where: { email: email('emp1.mgr.typo') } })).toBe(0)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'user.invite_withdrawn', entityId: id } })
    expect(log.details).toMatchObject({ role: 'manager', employeeId: emp.emp1 })
    // The role is free again.
    const right = await post('boss', `/api/employees/${emp.emp1}/logins`, { email: email('emp1.mgr'), role: 'manager' })
    expect(right.status, JSON.stringify(right.body)).toBe(201)
    // A login somebody signs in with is switched off, never withdrawn.
    const used = await post('boss', `/api/users/${login.emp1}/withdraw`)
    expect(used.status).toBe(409)
    expect(used.body.error.message).toBe('This login has been used, so it cannot be withdrawn. Turn it off instead.')
  })

  it('shows a person’s logins only to whoever manages logins', async () => {
    expect((await get('boss', `/api/employees/${emp.emp1}`)).body.data.logins).toHaveLength(2)
    const asManager = await get('mgrM', `/api/employees/${emp.emp1}`)
    expect(asManager.status).toBe(200)
    expect(asManager.body.data).not.toHaveProperty('logins')
    expect(asManager.body.data.email).toBe(email('emp1'))
  })

  it('says in the session whose records the role reaches', async () => {
    expect((await get('hrA', '/api/auth/session')).body.data.user.employeeReach).toBe('ORGANIZATION')
    expect((await get('emp1', '/api/auth/session')).body.data.user.employeeReach).toBe('SELF')
  })
})

describe('leave that nobody could see', () => {
  it('keeps a leaver’s waiting request in their manager’s Team Requests', async () => {
    const req = await apply('leaver', day(4))
    expect(req.status, JSON.stringify(req.body)).toBe(201)
    expect((await request(app).delete(`/api/users/${login.leaver}`).set('Authorization', as('boss'))).status).toBe(204)
    const team = await get('mgrM', '/api/leave-requests/team')
    expect((team.body.data.requests as { id: string }[]).map((r) => r.id)).toContain(req.body.data.id)
    expect((await post('mgrM', `/api/leave-requests/${req.body.data.id}/approve`)).status).toBe(200)
  })

  it('offers the named approver, as “next up”, the requests of the people under their own report', async () => {
    const start = await approvals()
    const saved = await put('boss', '/api/company-tree/approvals', { noManagerApproverId: emp.X, backup: 'next_up', reversal: start.reversal, version: start.version })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const req = await apply('Q1', day(5))
    expect(req.status, JSON.stringify(req.body)).toBe(201)
    const team = await get('X', '/api/leave-requests/team')
    expect((team.body.data.backup as { id: string }[]).map((r) => r.id)).toContain(req.body.data.id)
    expect((await post('X', `/api/leave-requests/${req.body.data.id}/approve`)).status).toBe(200)
  })

  it('lists people whose leave a role decides without a Correct button its leave scope would refuse', async () => {
    const created = await post('boss', '/api/roles', {
      name: 'Team Clerk', description: '', parentKey: 'hr',
      permissions: ['leave:read', 'leave:balance:manage'], scopes: { leave: 'DIRECT_REPORTS' },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await giveRole('X', 'team_clerk')
    const res = await get('X', '/api/leave-balances')
    expect(res.status).toBe(200)
    const row = (id: string) => (res.body.data.people as { employee_id: string; may_correct: boolean }[]).find((p) => p.employee_id === id)
    // U1 is listed because X decides U1's leave ("nobody above"), but is outside X's team.
    expect(row(emp.U1)).toMatchObject({ may_correct: false })
    expect(row(emp.P)).toMatchObject({ may_correct: true })
    await giveRole('X', 'employee')
  })
})

describe('Settings → Approvals', () => {
  it('shows a named person who cannot sign in as such, and still saves the other settings', async () => {
    expect((await patch('boss', `/api/users/${login.X}/status`, { status: 'inactive' })).status).toBe(200)
    const now = await approvals()
    expect(now).toMatchObject({ no_manager_approver_id: emp.X, no_manager_approver_can_sign_in: false })
    const saved = await put('boss', '/api/company-tree/approvals', { noManagerApproverId: emp.X, backup: 'super_admin', reversal: now.reversal, version: now.version })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect((await patch('boss', `/api/users/${login.X}/status`, { status: 'active' })).status).toBe(200)
    await signIn('X')
  })

  it('keeps its version when the company record changes for another reason', async () => {
    const before = (await approvals()).version
    await prisma.organization.update({ where: { id: orgId }, data: { name: `${PREFIX}-org renamed` } })
    expect((await approvals()).version).toBe(before)
  })
})

describe('own work and the ticks on the Roles screen', () => {
  it('says to mark the owner where nobody could do a top Super Admin’s own work', async () => {
    const res = await get('boss', '/api/leave-balances')
    const own = (res.body.data.people as { employee_id: string; may_correct: boolean; correction_goes_to: string | null }[]).find((p) => p.employee_id === emp.boss)
    expect(own).toMatchObject({ may_correct: false, correction_goes_to: 'the owner, once marked (Settings → Company tree)' })
  })

  it('makes “Mark attendance” mark a new day, and leaves correcting a recorded one to “Correct attendance”', async () => {
    const created = await post('boss', '/api/roles', {
      name: 'Day Marker', description: '', parentKey: 'hr',
      permissions: ['attendance:read', 'attendance:mark'], scopes: { attendance: 'ORGANIZATION' },
    })
    expect(created.status, JSON.stringify(created.body)).toBe(201)
    await giveRole('marker', 'day_marker')
    const yesterday = zonedToday(new Date(Date.now() - 86_400_000), 'Asia/Kolkata')
    const first = await post('marker', '/api/attendance/mark', { employeeId: emp.Q2, date: yesterday, status: 'present' })
    expect([200, 201], JSON.stringify(first.body)).toContain(first.status)
    const again = await post('marker', '/api/attendance/mark', { employeeId: emp.Q2, date: yesterday, status: 'absent' })
    expect(again.status).toBe(403)
    expect(again.body.error.message).toBe('This day is already recorded. Changing it needs “Correct attendance”, which your role does not have.')
    // Whoever holds it corrects.
    expect([200, 201]).toContain((await post('boss', '/api/attendance/mark', { employeeId: emp.Q2, date: yesterday, status: 'absent' })).status)
  })

  it('refuses “Enter monthly incentives” without “See salaries”, which it needs to do anything', async () => {
    const res = await post('boss', '/api/roles', {
      name: 'Incentive Clerk', description: '', parentKey: 'hr', permissions: ['employee:read', 'payroll:entry:manage'], scopes: { employee: 'ORGANIZATION' },
    })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe('“Enter monthly incentives” needs “See salaries” ticked too.')
  })

  it('lets only somebody who can read PAN, UAN, PF and ESIC write them', async () => {
    const blind = await patch('adm', `/api/employees/${emp.emp1}`, { statutory: { pan: 'ABCDE1234F' } })
    expect(blind.status).toBe(403)
    expect(blind.body.error.message).toBe('PAN, UAN, PF and ESIC details are entered by somebody who can see them. Ask HR.')
    expect((await patch('adm', `/api/employees/${emp.emp1}`, { phone: '9876543210' })).status).toBe(200)
    expect((await patch('hrA', `/api/employees/${emp.emp1}`, { statutory: { pan: 'ABCDE1234F' } })).status).toBe(200)
  })
})
