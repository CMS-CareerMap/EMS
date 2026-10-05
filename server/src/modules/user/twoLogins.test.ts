import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { fromDateColumn, toDateColumn, zonedToday } from '../../domain/shared/dates'

/**
 * Day 23 through the API: two logins, one person.
 *
 * Somebody who holds a role has an employee login and a role login, each with
 * its own email — and both are the same person in the company tree. So the
 * rules about "your own" hold from both, a notice about the person reaches
 * both, and leaving closes both.
 *
 *   boss (Super Admin) ─┬─ priya (employee login; an HR login added below) ── ravi
 *                       ├─ hr2 (HR)
 *                       ├─ kiran (employee login + Accounts login)
 *                       └─ temp (employee)
 *   gone (left the company)
 */

const PREFIX = 'twologins'
const PASSWORD = 'CorrectHorseBattery1'
const NEW_PASSWORD = 'AnotherHorseBattery2'
const app = createApp()

type Who = 'boss' | 'priya' | 'hr2' | 'kiran' | 'temp' | 'ravi'
const PEOPLE: [Who, string, Who | null][] = [
  ['boss', 'super_admin', null],
  ['priya', 'employee', 'boss'],
  ['hr2', 'hr', 'boss'],
  ['kiran', 'employee', 'boss'],
  ['temp', 'employee', 'boss'],
  ['ravi', 'employee', 'priya'],
]

let orgId = ''
let clId = ''
let goneId = ''
let aadhaarId = ''
let kiranAccountsLogin = ''
let priyaHrLogin = ''
let priyaHrToken = ''
const emp = {} as Record<Who, string>
const login = {} as Record<Who, string>
const users = {} as Record<Who, string>
const tokens = {} as Record<Who, string>
const email = (who: string) => `${PREFIX}-${who.toLowerCase()}@example.com`
const PRIYA_HR_EMAIL = `${PREFIX}-priya.hr@example.com`

const bearer = (token: string) => `Bearer ${token}`
const get = (token: string, url: string) => request(app).get(url).set('Authorization', bearer(token))
const post = (token: string, url: string, body: object) => request(app).post(url).set('Authorization', bearer(token)).send(body)
const put = (token: string, url: string, body: object) => request(app).put(url).set('Authorization', bearer(token)).send(body)
const patch = (token: string, url: string, body: object) => request(app).patch(url).set('Authorization', bearer(token)).send(body)
const signIn = (identifier: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ identifier, password })

/** A Monday at least two weeks out, so nothing here rots. */
function day(offset: number): string {
  const date = new Date()
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCDate(date.getUTCDate() + 14)
  while (date.getUTCDay() !== 1) date.setUTCDate(date.getUTCDate() + 1)
  date.setUTCDate(date.getUTCDate() + offset)
  return fromDateColumn(date)
}
const LEAVE_YEAR = Number(day(0).slice(0, 4)) - (Number(day(0).slice(5, 7)) >= 4 ? 0 : 1)

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  const people = { user: { email: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employeeDocument.deleteMany({ where: org })
  await prisma.documentType.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
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
  // HR manages logins in this company — to show that acting on one login of
  // a person needs the right over EVERY login of theirs.
  await prisma.role.update({
    where: { organizationId_key: { organizationId: orgId, key: 'hr' } },
    data: { permissions: { push: ['user:delete', 'user:status:update', 'user:invite', 'membership:role:assign'] } },
  })
  aadhaarId = (await prisma.documentType.create({ data: { organizationId: orgId, code: 'aadhaar', label: 'Aadhaar', required: true, displayOrder: 1 } })).id

  for (const [who, role] of PEOPLE) {
    const user = await prisma.user.create({ data: { email: email(who), passwordHash: await hashPassword(PASSWORD) } })
    users[who] = user.id
    emp[who] = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: `${PREFIX}-${who}`, fullName: `${who[0]!.toUpperCase()}${who.slice(1)} Person`, dateOfJoining: toDateColumn('2024-01-08') },
    })).id
    login[who] = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active', employeeId: emp[who] } })).id
  }
  for (const [who, , above] of PEOPLE) {
    if (above) await prisma.employee.update({ where: { id: emp[who] }, data: { reportingManagerId: emp[above] } })
  }
  // Kiran already has a second login: Accounts, which is not below HR.
  const kiranAccounts = await prisma.user.create({ data: { email: email('kiran.accounts'), passwordHash: await hashPassword(PASSWORD) } })
  kiranAccountsLogin = (await prisma.membership.create({ data: { userId: kiranAccounts.id, organizationId: orgId, role: 'accounts', status: 'active', employeeId: emp.kiran } })).id
  goneId = (await prisma.employee.create({ data: { organizationId: orgId, employeeCode: `${PREFIX}-gone`, fullName: 'Gone Person', archivedAt: new Date() } })).id
  for (const who of ['priya', 'ravi'] as const) {
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp[who], leaveTypeId: clId, leaveYear: LEAVE_YEAR, days: 12, reason: 'opening_grant' } })
  }

  for (const [who] of PEOPLE) {
    const res = await signIn(email(who))
    expect(res.status, who).toBe(200)
    tokens[who] = res.body.data.accessToken
  }
}, 60_000)

afterAll(cleanup)

const correctBalance = (token: string, target: string) =>
  post(token, '/api/leave-balances/adjustments', { employeeId: target, leaveTypeId: clId, days: 1, note: 'Correction' })

describe('adding a role login', () => {
  it('is the Super Admin’s alone', async () => {
    const res = await post(tokens.hr2, `/api/employees/${emp.priya}/logins`, { email: PRIYA_HR_EMAIL, role: 'hr' })
    expect(res.status).toBe(403)
  })

  it('before it, Priya does no HR work, so a fellow HR person may correct her balance', async () => {
    expect((await correctBalance(tokens.hr2, emp.priya)).status).toBe(201)
  })

  it('gives somebody already here a second login, with its own email and its own link', async () => {
    const res = await post(tokens.boss, `/api/employees/${emp.priya}/logins`, { email: PRIYA_HR_EMAIL, role: 'hr' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.user).toMatchObject({ email: PRIYA_HR_EMAIL, role: 'hr', role_name: 'HR', status: 'invited', person_id: emp.priya })
    expect(res.body.data.invite.token).toBeTruthy()
    priyaHrLogin = res.body.data.user.id

    // The same person, not a new one: no second employee record.
    expect(await prisma.employee.count({ where: { organizationId: orgId, fullName: 'Priya Person' } })).toBe(1)
    const row = await prisma.membership.findUniqueOrThrow({ where: { id: priyaHrLogin } })
    expect(row.employeeId).toBe(emp.priya)

    // On record, about Priya.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'user.login_added' } })
    expect(log).toMatchObject({ entityType: 'membership', entityId: priyaHrLogin })
    expect(log.details).toMatchObject({ employeeId: emp.priya, email: PRIYA_HR_EMAIL, role: 'hr', roleName: 'HR' })

    // The link works like any invitation: she sets a password and signs in to it.
    const redeemed = await request(app).post('/api/auth/password-link/redeem').send({ token: res.body.data.invite.token, password: NEW_PASSWORD })
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200)
    const signed = await signIn(PRIYA_HR_EMAIL, NEW_PASSWORD)
    expect(signed.status).toBe(200)
    priyaHrToken = signed.body.data.accessToken
  })

  it('refuses a role the person already has, an email already in use, a role that does not exist, and somebody who left', async () => {
    const again = await post(tokens.boss, `/api/employees/${emp.priya}/logins`, { email: `${PREFIX}-priya.hr2@example.com`, role: 'hr' })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toBe('Priya Person already has a HR login. Choose a different role for this one.')
    const usedEmail = await post(tokens.boss, `/api/employees/${emp.priya}/logins`, { email: email('ravi'), role: 'manager' })
    expect(usedEmail.status).toBe(409)
    expect(usedEmail.body.error.message).toMatch(/Each login needs an email of its own/)
    expect((await post(tokens.boss, `/api/employees/${emp.priya}/logins`, { email: `${PREFIX}-x@example.com`, role: 'no_such_role' })).status).toBe(400)
    const left = await post(tokens.boss, `/api/employees/${goneId}/logins`, { email: `${PREFIX}-y@example.com`, role: 'hr' })
    expect(left.status).toBe(400)
    expect(left.body.error.message).toBe('Gone Person has left the company.')
    // None of them made a login.
    expect(await prisma.membership.count({ where: { organizationId: orgId, employeeId: emp.priya } })).toBe(2)
  })

  it('lists both logins on the person’s record, and in Users with the person they belong to', async () => {
    const res = await get(tokens.boss, `/api/employees/${emp.priya}`)
    expect(res.status).toBe(200)
    expect(res.body.data.logins).toEqual([
      { id: login.priya, email: email('priya'), role: 'employee', role_name: 'Employee', status: 'active' },
      { id: priyaHrLogin, email: PRIYA_HR_EMAIL, role: 'hr', role_name: 'HR', status: 'active' },
    ])
    // The single fields every screen read before describe the first login.
    expect(res.body.data).toMatchObject({ email: email('priya'), role: 'employee', account_status: 'active' })

    const list = await get(tokens.boss, '/api/users')
    const hers = (list.body.data as { id: string; person_id: string | null }[]).filter((u) => u.person_id === emp.priya).map((u) => u.id)
    expect(hers.sort()).toEqual([login.priya, priyaHrLogin].sort())
  })
})

describe('one person, two logins', () => {
  it('is the same person from both: the session names the same employee, under a different role', async () => {
    const asEmployee = await get(tokens.priya, '/api/auth/session')
    const asHr = await get(priyaHrToken, '/api/auth/session')
    expect(asEmployee.status).toBe(200)
    expect(asHr.status).toBe(200)
    expect(asHr.body.data.user.employee.id).toBe(emp.priya)
    expect(asEmployee.body.data.user.employee.id).toBe(emp.priya)
    expect(asEmployee.body.data.user.roleName).toBe('Employee')
    expect(asHr.body.data.user.roleName).toBe('HR')
    expect(asHr.body.data.user.email).toBe(PRIYA_HR_EMAIL)
  })

  it('keeps the employee login to self-service, and gives the HR login the company', async () => {
    // The Employee role does not open the employee list at all.
    expect((await get(tokens.priya, '/api/employees')).status).toBe(403)
    const company = await get(priyaHrToken, '/api/employees')
    expect(company.status).toBe(200)
    expect((company.body.data as unknown[]).length).toBeGreaterThan(1)
  })

  it('keeps the employee login to her own rows even when the Employee role is widened for everybody', async () => {
    const where = { organizationId_key: { organizationId: orgId, key: 'employee' } }
    const before = await prisma.role.findUniqueOrThrow({ where, select: { permissions: true, scopes: true } })
    const scopes = { ...(before.scopes as Record<string, string>), employee: 'ORGANIZATION', attendance: 'ORGANIZATION' }
    await prisma.role.update({ where, data: { permissions: { push: ['employee:read', 'attendance:read'] }, scopes } })
    try {
      // Somebody who is only an employee gets what the role now gives.
      const plain = await get(tokens.temp, '/api/employees')
      expect(plain.status).toBe(200)
      expect((plain.body.data as unknown[]).length).toBeGreaterThan(1)
      expect((await get(tokens.temp, '/api/auth/session')).body.data.user.employeeReach).toBe('ORGANIZATION')

      // Priya's employee login is for her own things: her HR work is done from her HR login.
      const own = await get(tokens.priya, '/api/employees')
      expect(own.status).toBe(200)
      expect((own.body.data as { id: string }[]).map((e) => e.id)).toEqual([emp.priya])
      const session = (await get(tokens.priya, '/api/auth/session')).body.data.user
      expect(session.employeeReach).toBe('SELF')
      expect(session.attendanceReach).toBe('SELF')
      expect(session.leaveReach).toBe('SELF')
      expect((await get(tokens.priya, `/api/employees/${emp.temp}`)).status).toBe(404)
    } finally {
      await prisma.role.update({ where, data: { permissions: before.permissions, scopes: before.scopes ?? {} } })
    }
  })

  it('refuses her own work from both logins — and now from a fellow HR person too', async () => {
    // From the HR login: her own balance goes up the tree.
    const fromHr = await correctBalance(priyaHrToken, emp.priya)
    expect(fromHr.status).toBe(403)
    expect(fromHr.body.error.message).toBe('You cannot correct your own leave balance. It goes to the person above you: Boss Person.')
    // From the employee login: the role there does not hold the work at all.
    expect((await correctBalance(tokens.priya, emp.priya)).status).toBe(403)
    // She does HR work now (by her HR login), so a peer may not do hers either.
    const peer = await correctBalance(tokens.hr2, emp.priya)
    expect(peer.status).toBe(403)
    expect(peer.body.error.message).toBe('Priya Person does this kind of work too, so their leave balance is done by the people above them. Ask Boss Person.')
    // The person above does it.
    expect((await correctBalance(tokens.boss, emp.priya)).status).toBe(201)
    // Her own attendance as well.
    const yesterday = zonedToday(new Date(Date.now() - 86_400_000), 'Asia/Kolkata')
    const mark = await post(priyaHrToken, '/api/attendance/mark', { employeeId: emp.priya, date: yesterday, status: 'present' })
    expect(mark.status).toBe(403)
    expect(mark.body.error.message).toBe('You cannot mark or correct your own attendance. It goes to the person above you: Boss Person.')
  })

  it('sends her own leave to the person above, and lets neither login decide it', async () => {
    const applied = await post(tokens.priya, '/api/leave-requests', { leaveTypeId: clId, fromDate: day(0), toDate: day(0), reason: 'Family' })
    expect(applied.status, JSON.stringify(applied.body)).toBe(201)
    const id = applied.body.data.id as string
    const told = await prisma.notification.findMany({ where: { organizationId: orgId, entityId: id }, select: { userId: true } })
    expect(told.map((n) => n.userId)).toEqual([users.boss])

    const own = await post(priyaHrToken, `/api/leave-requests/${id}/approve`, {})
    expect(own.status).toBe(403)
    expect(own.body.error.message).toBe('You cannot decide on your own leave. It goes to the person above you: Boss Person.')
    expect((await post(tokens.priya, `/api/leave-requests/${id}/approve`, {})).status).toBe(403)
    expect((await post(tokens.boss, `/api/leave-requests/${id}/approve`, {})).status).toBe(200)
  })

  it('tells only who may check her upload — not her HR login, nor a fellow HR person', async () => {
    // Her own Aadhaar, from the employee login. She checks documents herself
    // (by her HR login), so hers go up the tree: the Super Admin above her is
    // told. Her HR login is not — it was her — and nor is hr2, a peer, who
    // would only be refused.
    const res = await request(app).post('/api/employee-documents').set('Authorization', bearer(tokens.priya))
      .field('documentTypeId', aadhaarId)
      .attach('file', Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'), { filename: 'aadhaar.pdf', contentType: 'application/pdf' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const priyaHrUser = (await prisma.membership.findUniqueOrThrow({ where: { id: priyaHrLogin } })).userId
    const told = (await prisma.notification.findMany({ where: { organizationId: orgId, event: { startsWith: 'document' } }, select: { userId: true } })).map((n) => n.userId)
    expect(told).toEqual([users.boss])
    expect(told).not.toContain(priyaHrUser)
    expect(told).not.toContain(users.hr2)
  })

  it('decides her team’s leave from the HR login only: the employee login is for her own things', async () => {
    // The sessions say so: the Team requests tab shows on the HR login only.
    expect((await get(priyaHrToken, '/api/auth/session')).body.data.user.decidesLeave).toBe(true)
    expect((await get(tokens.priya, '/api/auth/session')).body.data.user.decidesLeave).toBe(false)

    const applied = await post(tokens.ravi, '/api/leave-requests', { leaveTypeId: clId, fromDate: day(7), toDate: day(7), reason: 'Exam' })
    expect(applied.status, JSON.stringify(applied.body)).toBe(201)
    const id = applied.body.data.id as string
    const priyaHrUser = (await prisma.membership.findUniqueOrThrow({ where: { id: priyaHrLogin } })).userId
    const told = (await prisma.notification.findMany({ where: { organizationId: orgId, entityId: id }, select: { userId: true } })).map((n) => n.userId)
    expect(told).toEqual([priyaHrUser])
    // Not from the employee login — which cannot even see Ravi's request…
    const fromEmployee = await post(tokens.priya, `/api/leave-requests/${id}/approve`, {})
    expect(fromEmployee.status).toBe(404)
    expect((await get(tokens.priya, '/api/leave-requests/team')).body.data.requests).toEqual([])
    // …from the HR login.
    expect((await post(priyaHrToken, `/api/leave-requests/${id}/approve`, {})).status).toBe(200)

    // HR with a team of her own still sees everybody's balance, not only the team's.
    const balances = await get(priyaHrToken, '/api/leave-balances')
    const listed = (balances.body.data.people as { employee_id: string }[]).map((p) => p.employee_id)
    expect(listed).toEqual(expect.arrayContaining([emp.ravi, emp.priya, emp.hr2, emp.boss, emp.kiran]))

    // The leave list: her own requests only on the employee login, the company's on the HR one.
    const own = await get(tokens.priya, '/api/leave-requests')
    expect(own.status).toBe(200)
    expect(new Set((own.body.data as { employee_id: string }[]).map((r) => r.employee_id))).toEqual(new Set([emp.priya]))
    const all = await get(priyaHrToken, '/api/leave-requests')
    expect((all.body.data as { employee_id: string }[]).map((r) => r.employee_id)).toEqual(expect.arrayContaining([emp.priya, emp.ravi]))
  })

  it('never lets her change the role of her other login, or switch it off', async () => {
    // HR may give roles below HR in this company — but not to her own employee login.
    const role = await put(priyaHrToken, `/api/users/${login.priya}/role`, { role: 'manager' })
    expect(role.status).toBe(403)
    expect(role.body.error.message).toBe('You cannot change your own role, on this login or your other one. Ask another administrator.')
    const off = await patch(priyaHrToken, `/api/users/${login.priya}/status`, { status: 'inactive' })
    expect(off.status).toBe(403)
    expect(off.body.error.message).toBe('You cannot deactivate or remove your own account, on this login or your other one.')
    // One login per role: the Super Admin cannot give her employee login the role her other one holds.
    const twice = await put(tokens.boss, `/api/users/${login.priya}/role`, { role: 'hr' })
    expect(twice.status).toBe(409)
    expect(twice.body.error.message).toBe('This person already has a HR login. Each of their logins holds a different role.')
  })

  it('signs in by employee code only when the code points at one login', async () => {
    expect((await signIn(`${PREFIX}-ravi`)).status).toBe(200)
    // Priya has two: the code cannot say which, so she uses an email.
    expect((await signIn(`${PREFIX}-priya`)).status).toBe(401)
    expect((await signIn(`${PREFIX}-priya`, NEW_PASSWORD)).status).toBe(401)
  })

  it('switches off one login only: the other still signs in — by email, and by code again', async () => {
    expect((await patch(tokens.boss, `/api/users/${priyaHrLogin}/status`, { status: 'inactive' })).status).toBe(200)
    expect((await get(priyaHrToken, '/api/auth/session')).status).toBe(401)
    expect((await get(tokens.priya, '/api/auth/session')).status).toBe(200)
    expect((await signIn(email('priya'))).status).toBe(200)
    // One login that can sign in: the code points at it.
    expect((await signIn(`${PREFIX}-priya`)).status).toBe(200)
    // With the HR login off, the employee login decides her team again — nothing waits.
    expect((await get(tokens.priya, '/api/auth/session')).body.data.user.decidesLeave).toBe(true)
    // The log says which login.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'user.status_changed', entityId: priyaHrLogin } })
    expect(log.details).toMatchObject({ from: 'active', to: 'inactive', email: PRIYA_HR_EMAIL, role: 'hr', employeeId: emp.priya })
    // Back on, for leaving below.
    expect((await patch(tokens.boss, `/api/users/${priyaHrLogin}/status`, { status: 'active' })).status).toBe(200)
    priyaHrToken = (await signIn(PRIYA_HR_EMAIL, NEW_PASSWORD)).body.data.accessToken
  })

  it('tells her other login when one login’s password is reset', async () => {
    const link = await post(tokens.boss, `/api/users/${login.priya}/password-link`, {})
    expect(link.status).toBe(201)
    const redeemed = await request(app).post('/api/auth/password-link/redeem').send({ token: link.body.data.invite.token, password: PASSWORD })
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200)
    const priyaHrUser = (await prisma.membership.findUniqueOrThrow({ where: { id: priyaHrLogin } })).userId
    const notice = await prisma.notification.findFirst({ where: { organizationId: orgId, userId: priyaHrUser, event: 'account.password_changed' } })
    expect(notice).toMatchObject({ title: 'The password of your other login was changed' })
    expect(notice?.message).toContain(email('priya'))
    tokens.priya = (await signIn(email('priya'))).body.data.accessToken
  })
})

describe('a senior’s employee login is the senior', () => {
  // Kiran has an employee login and an Accounts login; Accounts is not below HR.
  const kiranEmployeeLogin = () => login.kiran

  it('refuses HR resetting its password, switching it or giving it a role', async () => {
    const MESSAGE = 'This person has another login whose role is not below yours, so their logins are managed by somebody above that role.'
    const link = await post(tokens.hr2, `/api/users/${kiranEmployeeLogin()}/password-link`, {})
    expect(link.status).toBe(403)
    expect(link.body.error.message).toBe(MESSAGE)
    const off = await patch(tokens.hr2, `/api/users/${kiranEmployeeLogin()}/status`, { status: 'inactive' })
    expect(off.status).toBe(403)
    expect(off.body.error.message).toBe(MESSAGE)
    const role = await put(tokens.hr2, `/api/users/${kiranEmployeeLogin()}/role`, { role: 'manager' })
    expect(role.status).toBe(403)
    expect(role.body.error.message).toBe(MESSAGE)
    // Nothing moved, and no link was made.
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: kiranEmployeeLogin() } })).status).toBe('active')
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: kiranEmployeeLogin() } })).role).toBe('employee')
    expect(await prisma.passwordResetToken.count({ where: { user: { email: email('kiran') } } })).toBe(0)
  })

  it('lets HR manage somebody whose only login is below HR', async () => {
    expect((await post(tokens.hr2, `/api/users/${login.ravi}/password-link`, {})).status).toBe(201)
  })
})

describe('leaving', () => {
  it('needs the right to close every login: HR cannot remove somebody whose other login is Accounts', async () => {
    const res = await request(app).delete(`/api/users/${login.kiran}`).set('Authorization', bearer(tokens.hr2))
    expect(res.status).toBe(403)
    expect(res.body.error.message).toBe('This person has another login whose role is not below yours, so their logins are managed by somebody above that role.')
    // Nor through the Accounts login itself: it is the same person leaving.
    const direct = await request(app).delete(`/api/users/${kiranAccountsLogin}`).set('Authorization', bearer(tokens.hr2))
    expect(direct.status).toBe(403)
    const logins = await prisma.membership.findMany({ where: { employeeId: emp.kiran }, select: { status: true } })
    expect(logins.map((l) => l.status)).toEqual(['active', 'active'])
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.kiran } })).archivedAt).toBeNull()
    // Somebody with an employee login only, HR may.
    expect((await request(app).delete(`/api/users/${login.temp}`).set('Authorization', bearer(tokens.hr2))).status).toBe(204)
  })

  it('closes both logins together, by either one, and ends every session of both', async () => {
    const res = await request(app).delete(`/api/users/${login.priya}`).set('Authorization', bearer(tokens.boss))
    expect(res.status).toBe(204)
    const logins = await prisma.membership.findMany({ where: { employeeId: emp.priya }, select: { status: true } })
    expect(logins.map((l) => l.status)).toEqual(['inactive', 'inactive'])
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.priya } })).archivedAt).not.toBeNull()
    // Both access tokens are dead at once, not in fifteen minutes.
    expect((await get(tokens.priya, '/api/auth/session')).status).toBe(401)
    expect((await get(priyaHrToken, '/api/auth/session')).status).toBe(401)
    expect((await signIn(PRIYA_HR_EMAIL, NEW_PASSWORD)).status).toBe(401)
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'user.terminated', entityId: login.priya } })
    expect(log.details).toMatchObject({ employeeArchived: true, employeeId: emp.priya, loginsClosed: 2 })
  })

  it('keeps the logins of somebody who has left closed, and the day they left', async () => {
    const reopen = await patch(tokens.boss, `/api/users/${priyaHrLogin}/status`, { status: 'active' })
    expect(reopen.status).toBe(400)
    expect(reopen.body.error.message).toBe('Priya Person has left the company, so their logins stay closed.')
    const left = (await prisma.employee.findUniqueOrThrow({ where: { id: emp.priya } })).archivedAt
    expect((await request(app).delete(`/api/users/${priyaHrLogin}`).set('Authorization', bearer(tokens.boss))).status).toBe(204)
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.priya } })).archivedAt).toEqual(left)
    const users = await get(tokens.boss, '/api/users')
    expect((users.body.data as { person_id: string | null; person_left: boolean }[]).filter((u) => u.person_id === emp.priya).every((u) => u.person_left)).toBe(true)
  })

  it('touches nobody else’s logins', async () => {
    expect(await prisma.membership.count({ where: { employeeId: emp.kiran, status: 'active' } })).toBe(2)
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: kiranAccountsLogin } })).status).toBe('active')
  })
})

describe('a Super Admin login still only invited', () => {
  it('is not “the last Super Admin”: the only one can withdraw it, or change its role', async () => {
    const added = await post(tokens.boss, `/api/employees/${emp.ravi}/logins`, { email: email('ravi.admin'), role: 'super_admin' })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    const invited = added.body.data.user.id as string
    // An invited role login does not take the Employee ID away: one login can sign in.
    expect((await signIn(`${PREFIX}-ravi`)).status).toBe(200)
    expect((await patch(tokens.boss, `/api/users/${invited}/status`, { status: 'inactive' })).status).toBe(200)
    expect((await put(tokens.boss, `/api/users/${invited}/role`, { role: 'manager' })).status).toBe(200)
    // Boss is still the one active Super Admin, and still cannot be switched off.
    expect(await prisma.membership.count({ where: { organizationId: orgId, role: 'super_admin', status: 'active' } })).toBe(1)
    // The log says it was a new login, not a second one.
    const log = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'user.login_added', entityId: invited } })
    expect(log.details).toMatchObject({ employeeId: emp.ravi, logins: 2 })
  })
})

describe('the company tree reads every login', () => {
  it('lets the owner be somebody whose Super Admin panel is on their second login, and shows all their roles', async () => {
    const tree = await get(tokens.boss, '/api/company-tree')
    const kiranBefore = (tree.body.data.people as { id: string; role: string | null; can_be_owner: boolean }[]).find((p) => p.id === emp.kiran)
    expect(kiranBefore).toMatchObject({ role: 'Employee, Accounts', can_be_owner: false })
    const version = tree.body.data.version as string
    expect((await put(tokens.boss, '/api/company-tree/owner', { employeeId: emp.kiran, version })).status).toBe(400)

    const added = await post(tokens.boss, `/api/employees/${emp.kiran}/logins`, { email: email('kiran.admin'), role: 'super_admin' })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    // Live once its password is set — an invitation alone signs nobody in.
    await request(app).post('/api/auth/password-link/redeem').send({ token: added.body.data.invite.token, password: NEW_PASSWORD })
    const after = await get(tokens.boss, '/api/company-tree')
    const kiran = (after.body.data.people as { id: string; role: string | null; can_be_owner: boolean }[]).find((p) => p.id === emp.kiran)
    expect(kiran).toMatchObject({ role: 'Employee, Accounts, Super Admin', can_be_owner: true })
    expect((await put(tokens.boss, '/api/company-tree/owner', { employeeId: emp.kiran, version: after.body.data.version })).status).toBe(204)
  })
})
