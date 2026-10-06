import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { toDateColumn } from '../../domain/shared/dates'

/**
 * Passwords set by the company (client, 6 Oct 2026), through the API.
 *
 * HR gives a new employee their Employee ID and password, and the login works
 * at once; it signs in with the Employee ID, in either case, or the email when
 * there is one. The employee cannot change it — HR sets a new one. A role
 * login's password is the Super Admin's alone. Settings → Passwords can hand
 * either kind back to its owner, with a link, as before.
 *
 *   boss (Super Admin) ─┬─ lead (employee) ── hr (HR) ── asha (employee)
 *                       ├─ hr2 (HR)
 *                       ├─ acc (Accounts)
 *                       └─ kiran (employee login + an Accounts login)
 */

const PREFIX = 'passwords'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

type Who = 'boss' | 'lead' | 'hr' | 'hr2' | 'acc' | 'asha' | 'kiran'
const PEOPLE: [Who, string, Who | null][] = [
  ['boss', 'super_admin', null],
  ['lead', 'employee', 'boss'],
  ['hr', 'hr', 'lead'],
  ['hr2', 'hr', 'boss'],
  ['acc', 'accounts', 'boss'],
  ['asha', 'employee', 'hr'],
  ['kiran', 'employee', 'boss'],
]

let orgId = ''
let kiranAccountsLogin = ''
const emp = {} as Record<Who, string>
const login = {} as Record<Who, string>
const users = {} as Record<Who, string>
const tokens = {} as Record<Who, string>
const email = (who: string) => `${PREFIX}-${who.toLowerCase()}@example.com`
const code = (who: string) => `${PREFIX.toUpperCase()}-${who.toUpperCase()}`

const bearer = (token: string) => `Bearer ${token}`
const get = (token: string, url: string) => request(app).get(url).set('Authorization', bearer(token))
const post = (token: string, url: string, body: object) => request(app).post(url).set('Authorization', bearer(token)).send(body)
const put = (token: string, url: string, body: object) => request(app).put(url).set('Authorization', bearer(token)).send(body)
const patch = (token: string, url: string, body: object) => request(app).patch(url).set('Authorization', bearer(token)).send(body)
const signIn = (identifier: string, password = PASSWORD) => request(app).post('/api/auth/login').send({ identifier, password })
const setPassword = (token: string, membershipId: string, password: string) => post(token, `/api/users/${membershipId}/password`, { password })

async function cleanup() {
  const orgIds = (await prisma.organization.findMany({ where: { name: { startsWith: PREFIX } }, select: { id: true } })).map((o) => o.id)
  // Logins with no email are found through their company, not their address.
  const userIds = (await prisma.membership.findMany({ where: { organizationId: { in: orgIds } }, select: { userId: true } })).map((m) => m.userId)
  const people = { OR: [{ userId: { in: userIds } }, { user: { email: { startsWith: PREFIX } } }] }
  const org = { organizationId: { in: orgIds } }
  await prisma.emailOutbox.deleteMany({ where: org })
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.passwordResetToken.deleteMany({ where: people })
  await prisma.refreshToken.deleteMany({ where: people })
  await prisma.membership.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { OR: [{ id: { in: userIds } }, { email: { startsWith: PREFIX } }] } })
  await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
}

beforeAll(async () => {
  await cleanup()
  // The company's defaults: HR sets employees' passwords, the Super Admin role logins', 10 characters.
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id

  for (const [who, role] of PEOPLE) {
    const user = await prisma.user.create({ data: { email: email(who), passwordHash: await hashPassword(PASSWORD) } })
    users[who] = user.id
    emp[who] = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: code(who), fullName: `${who[0]!.toUpperCase()}${who.slice(1)} Person`, dateOfJoining: toDateColumn('2024-01-08') },
    })).id
    login[who] = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active', employeeId: emp[who] } })).id
  }
  for (const [who, , above] of PEOPLE) {
    if (above) await prisma.employee.update({ where: { id: emp[who] }, data: { reportingManagerId: emp[above] } })
  }
  // Kiran has a second login: Accounts — not below HR.
  const kiranAccounts = await prisma.user.create({ data: { email: email('kiran.accounts'), passwordHash: await hashPassword(PASSWORD) } })
  kiranAccountsLogin = (await prisma.membership.create({ data: { userId: kiranAccounts.id, organizationId: orgId, role: 'accounts', status: 'active', employeeId: emp.kiran } })).id

  for (const [who] of PEOPLE) {
    const res = await signIn(email(who))
    expect(res.status, who).toBe(200)
    tokens[who] = res.body.data.accessToken
  }
}, 60_000)

afterAll(cleanup)

describe('the company sets passwords, out of the box', () => {
  it('says so in the session, with the rule for their length', async () => {
    const res = await signIn(email('asha'))
    expect(res.body.data.user).toMatchObject({
      passwordSetBy: 'company',
      passwordMinLength: 10,
      passwordRules: { employeePasswords: 'company', rolePasswords: 'company', passwordMinLength: 10 },
    })
    // The Super Admin's own is always theirs.
    expect((await signIn(email('boss'))).body.data.user.passwordSetBy).toBe('self')
  })

  it('gives HR, and the Super Admin, the permission — nobody else', async () => {
    const roles = await prisma.role.findMany({ where: { organizationId: orgId }, select: { key: true, permissions: true } })
    const holders = roles.filter((r) => r.permissions.includes('user:password:set')).map((r) => r.key).sort()
    expect(holders).toEqual(['hr', 'super_admin'])
  })
})

describe('HR gives a new employee an Employee ID and a password', () => {
  it('makes a login that works at once, with no email, by the Employee ID in any case', async () => {
    const res = await post(tokens.hr, '/api/employees', {
      employeeCode: code('noemail'),
      fullName: 'No Email Person',
      reportingManagerId: emp.hr,
      login: { role: 'employee', password: 'Welcome@2026' },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.meta.login_start).toBe('password')
    expect(res.body.meta.invite).toBeUndefined()
    expect(res.body.data.logins).toEqual([expect.objectContaining({ email: null, role: 'employee', status: 'active', has_password: true, login_kind: 'employee' })])

    expect((await signIn(code('noemail'), 'Welcome@2026')).status).toBe(200)
    expect((await signIn(code('noemail').toLowerCase(), 'Welcome@2026')).status).toBe(200)
    expect((await signIn(code('noemail'), 'Wrong@20261')).status).toBe(401)
  })

  it('…or with an email, which signs in too', async () => {
    const res = await post(tokens.hr, '/api/employees', {
      employeeCode: code('withemail'),
      fullName: 'With Email Person',
      reportingManagerId: emp.hr,
      login: { email: email('withemail'), role: 'employee', password: 'Welcome@2026' },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect((await signIn(email('withemail'), 'Welcome@2026')).status).toBe(200)
    expect((await signIn(code('withemail'), 'Welcome@2026')).status).toBe(200)
  })

  it('refuses a password shorter than the company’s rule, and makes nothing', async () => {
    const res = await post(tokens.hr, '/api/employees', {
      employeeCode: code('short'),
      fullName: 'Short Person',
      reportingManagerId: emp.hr,
      login: { role: 'employee', password: 'Short@1' },
    })
    expect(res.status).toBe(422)
    expect(res.body.error.message).toBe('Password must be at least 10 characters')
    expect(await prisma.employee.count({ where: { organizationId: orgId, employeeCode: code('short') } })).toBe(0)
  })

  it('with the password left out, the login waits for HR — and cannot sign in until then', async () => {
    const res = await post(tokens.hr, '/api/employees', {
      employeeCode: code('waits'),
      fullName: 'Waits Person',
      reportingManagerId: emp.hr,
      login: { role: 'employee' },
    })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.meta.login_start).toBe('none')
    expect(res.body.meta.invite).toBeUndefined()
    const waiting = res.body.data.logins[0]
    expect(waiting).toMatchObject({ status: 'invited', has_password: false })
    expect((await signIn(code('waits'), 'Anything@2026')).status).toBe(401)

    expect((await setPassword(tokens.hr, waiting.id, 'FirstOne@2026')).status).toBe(200)
    const signed = await signIn(code('waits'), 'FirstOne@2026')
    expect(signed.status).toBe(200)
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'user.password_set', entityId: waiting.id } })).toBe(1)
  })

  it('never lets HR set a role login’s password, and a role login needs an email', async () => {
    const base = { fullName: 'Role Person', reportingManagerId: emp.hr }
    const noEmail = await post(tokens.hr, '/api/employees', { ...base, employeeCode: code('role1'), login: { role: 'manager' } })
    expect(noEmail.status).toBe(422)
    const withPassword = await post(tokens.hr, '/api/employees', { ...base, employeeCode: code('role2'), login: { email: email('role2'), role: 'manager', password: 'Welcome@2026' } })
    expect(withPassword.status).toBe(403)
    expect(withPassword.body.error.message).toContain('Only the Super Admin sets the password of a role login')
    // Left out, it waits for the Super Admin.
    const waits = await post(tokens.hr, '/api/employees', { ...base, employeeCode: code('role3'), login: { email: email('role3'), role: 'manager' } })
    expect(waits.status, JSON.stringify(waits.body)).toBe(201)
    expect(waits.body.meta.login_start).toBe('none')
    const managerLogin = waits.body.data.logins[0].id
    expect((await setPassword(tokens.hr, managerLogin, 'Manager@2026')).status).toBe(403)
    expect((await setPassword(tokens.boss, managerLogin, 'Manager@2026')).status).toBe(200)
    expect((await signIn(email('role3'), 'Manager@2026')).status).toBe(200)
  })

  it('keeps Employee IDs that differ only in capitals apart', async () => {
    const clash = await post(tokens.hr, '/api/employees', { employeeCode: code('asha').toLowerCase(), fullName: 'Clash Person', reportingManagerId: emp.hr })
    expect(clash.status).toBe(409)
    expect(clash.body.error.message).toContain('in other letters')
    const rename = await patch(tokens.hr, `/api/employees/${emp.asha}`, { employeeCode: code('hr2').toLowerCase() })
    expect(rename.status).toBe(409)
    // Its own ID in other letters is fine.
    expect((await patch(tokens.hr, `/api/employees/${emp.asha}`, { employeeCode: code('asha') })).status).toBe(200)
  })
})

describe('giving somebody already here a login', () => {
  it('HR gives an employee login to somebody without one', async () => {
    const person = (await prisma.employee.create({ data: { organizationId: orgId, employeeCode: code('later'), fullName: 'Later Person', reportingManagerId: emp.hr } })).id
    const res = await post(tokens.hr, `/api/employees/${person}/logins`, { role: 'employee', password: 'Later@2026x' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({ login_start: 'password', invite: null })
    expect((await signIn(code('later'), 'Later@2026x')).status).toBe(200)
  })

  it('HR gives none to themselves, to somebody above them, or of a role', async () => {
    await prisma.membership.delete({ where: { id: login.lead } })
    const above = await post(tokens.hr, `/api/employees/${emp.lead}/logins`, { role: 'employee', password: 'Lead@2026xx' })
    expect(above.status).toBe(403)
    const roleLogin = await post(tokens.hr, `/api/employees/${emp.asha}/logins`, { email: email('asha.hr'), role: 'hr' })
    expect(roleLogin.status).toBe(403)
    // The Super Admin gives anybody theirs.
    const boss = await post(tokens.boss, `/api/employees/${emp.lead}/logins`, { role: 'employee', password: 'Lead@2026xx' })
    expect(boss.status, JSON.stringify(boss.body)).toBe(201)
    login.lead = boss.body.data.user.id
  })
})

describe('the Employee ID of somebody with two logins', () => {
  it('opens their employee login — one with no email has no other way in', async () => {
    const added = await post(tokens.boss, `/api/employees/${emp.hr2}/logins`, { role: 'employee', password: 'HrTwoOwn@2026' })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    expect(added.body.data.user).toMatchObject({ email: null, login_kind: 'employee' })

    const byCode = await signIn(code('hr2').toLowerCase(), 'HrTwoOwn@2026')
    expect(byCode.status, JSON.stringify(byCode.body)).toBe(200)
    expect(byCode.body.data.user).toMatchObject({ role: 'employee', email: null })
    // The HR login, by its email, with its own password.
    expect((await signIn(email('hr2'))).body.data.user.role).toBe('hr')
    // Two logins with emails: the ID still opens the employee one.
    expect((await signIn(code('kiran'))).body.data.user).toMatchObject({ role: 'employee', email: email('kiran') })
  })
})

describe('HR sets a new password', () => {
  it('signs out everything signed in with the old one, and tells the person', async () => {
    const before = await signIn(email('asha'))
    const oldToken = before.body.data.accessToken
    const res = await setPassword(tokens.hr, login.asha, 'NewAsha@2026')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ has_password: true, status: 'active' })
    expect(JSON.stringify(res.body)).not.toContain('NewAsha@2026')

    expect((await get(oldToken, '/api/auth/session')).status).toBe(401)
    expect(await prisma.refreshToken.count({ where: { userId: users.asha, revokedAt: null } })).toBe(0)
    expect((await signIn(email('asha'))).status).toBe(401)
    const fresh = await signIn(email('asha'), 'NewAsha@2026')
    expect(fresh.status).toBe(200)
    tokens.asha = fresh.body.data.accessToken

    const notice = await prisma.notification.findFirst({ where: { userId: users.asha, event: 'account.password_changed' }, orderBy: { createdAt: 'desc' } })
    expect(notice?.title).toBe('A new password was set for you')
    expect(notice?.message).toContain('HR set a new password for you')
    const row = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'user.password_set', entityId: login.asha } })
    expect(row?.details).toMatchObject({ role: 'employee', firstPassword: false })
    expect(JSON.stringify(row?.details)).not.toContain('NewAsha@2026')
  })

  it('refuses the caller’s own login, a fellow HR person’s, a role login, a senior’s and a person with a role login above HR', async () => {
    expect((await setPassword(tokens.hr, login.hr, 'Mine@2026xx')).status).toBe(400)
    expect((await setPassword(tokens.hr, login.hr2, 'Fellow@2026')).status).toBe(403)
    expect((await setPassword(tokens.hr, login.acc, 'Accounts@2026')).status).toBe(403)
    expect((await setPassword(tokens.hr, login.lead, 'Senior@2026')).status).toBe(403)
    const kiran = await setPassword(tokens.hr, login.kiran, 'Kiran@2026x')
    expect(kiran.status).toBe(403)
    expect(kiran.body.error.message).toContain('another login')
    expect((await setPassword(tokens.hr, kiranAccountsLogin, 'Kiran@2026x')).status).toBe(403)
  })

  it('refuses a turned-off login, a short password, and anybody without the permission', async () => {
    await prisma.membership.update({ where: { id: login.kiran }, data: { status: 'inactive' } })
    expect((await setPassword(tokens.boss, login.kiran, 'Kiran@2026x')).status).toBe(409)
    await prisma.membership.update({ where: { id: login.kiran }, data: { status: 'active' } })
    expect((await setPassword(tokens.hr, login.asha, 'Short@1')).status).toBe(422)
    expect((await setPassword(tokens.asha, login.kiran, 'Kiran@2026x')).status).toBe(403)
    expect((await setPassword(tokens.acc, login.asha, 'Asha@2026xx')).status).toBe(403)
  })

  it('lets the Super Admin set anybody’s but their own', async () => {
    expect((await setPassword(tokens.boss, login.hr2, 'HrTwo@2026x')).status).toBe(200)
    expect((await signIn(email('hr2'), 'HrTwo@2026x')).status).toBe(200)
    expect((await setPassword(tokens.boss, login.boss, 'Boss@2026xx')).status).toBe(400)
  })
})

describe('nobody but the Super Admin changes their own password', () => {
  const change = (token: string, current: string, next: string) =>
    post(token, '/api/auth/change-password', { currentPassword: current, newPassword: next }).set('X-Requested-With', 'ems')

  it('refuses an employee, pointing them to HR', async () => {
    const res = await change(tokens.asha, 'NewAsha@2026', 'Mine@2026xxx')
    expect(res.status).toBe(403)
    expect(res.body.error.message).toBe('Your password is set by HR. Ask HR to change it.')
  })

  it('refuses a role login, pointing them to the Super Admin', async () => {
    const res = await change(tokens.acc, PASSWORD, 'Mine@2026xxx')
    expect(res.status).toBe(403)
    expect(res.body.error.message).toBe('Your password is set by the Super Admin. Ask the Super Admin to change it.')
  })

  it('lets the Super Admin change theirs', async () => {
    const res = await change(tokens.boss, PASSWORD, 'BossOwn@2026')
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    tokens.boss = res.body.data.accessToken
  })

  it('takes no password link for a login the company sets', async () => {
    const res = await post(tokens.boss, `/api/users/${login.asha}/password-link`, {})
    expect(res.status).toBe(409)
    expect(res.body.error.message).toContain('use Set password')
  })
})

describe('the roster import', () => {
  it('makes logins that wait for HR, and hands out no links', async () => {
    const csv = `employee_code,full_name,email\n${code('csv1')},Csv One,${email('csv1')}\n${code('csv2')},Csv Two,`
    const res = await post(tokens.hr, '/api/employees/import', { csv, dryRun: false })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.invites).toEqual([])
    expect(res.body.data.waiting_for_password).toBe(1)
    const csv1 = await prisma.membership.findFirst({ where: { organizationId: orgId, employee: { employeeCode: code('csv1') } }, include: { user: true } })
    expect(csv1).toMatchObject({ status: 'invited', user: { passwordHash: null } })
  })
})

describe('Settings → Users & Roles → Passwords', () => {
  it('is read and changed by the Super Admin only', async () => {
    expect((await get(tokens.hr, '/api/users/password-rules')).status).toBe(403)
    const res = await get(tokens.boss, '/api/users/password-rules')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ employee_passwords: 'company', role_passwords: 'company', password_min_length: 10 })
    expect((await put(tokens.hr, '/api/users/password-rules', { employeePasswords: 'self', rolePasswords: 'company', passwordMinLength: 10 })).status).toBe(403)
  })

  it('refuses a length outside 8–64', async () => {
    for (const passwordMinLength of [7, 65]) {
      expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'company', rolePasswords: 'company', passwordMinLength })).status).toBe(422)
    }
  })

  it('a longer minimum applies to the next password set', async () => {
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'company', rolePasswords: 'company', passwordMinLength: 12 })).status).toBe(200)
    const short = await setPassword(tokens.hr, login.asha, 'Eleven@2026')
    expect(short.status).toBe(422)
    expect(short.body.error.message).toBe('Password must be at least 12 characters')
    expect((await setPassword(tokens.hr, login.asha, 'Twelve@20266')).status).toBe(200)
  })

  it('handed back to employees: they change their own, and a new login gets its link', async () => {
    const res = await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'self', rolePasswords: 'company', passwordMinLength: 10 })
    expect(res.status).toBe(200)
    expect(res.body.data.employee_passwords).toBe('self')
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'user.password_rules_updated' } })).toBeGreaterThanOrEqual(2)

    const signed = await signIn(email('asha'), 'Twelve@20266')
    expect(signed.body.data.user.passwordSetBy).toBe('self')
    const own = await post(signed.body.data.accessToken, '/api/auth/change-password', { currentPassword: 'Twelve@20266', newPassword: 'AshaOwn@2026' }).set('X-Requested-With', 'ems')
    expect(own.status, JSON.stringify(own.body)).toBe(200)

    const withPassword = await post(tokens.hr, '/api/employees', { employeeCode: code('self1'), fullName: 'Self One', reportingManagerId: emp.hr, login: { email: email('self1'), role: 'employee', password: 'Welcome@2026' } })
    expect(withPassword.status).toBe(400)
    const withLink = await post(tokens.hr, '/api/employees', { employeeCode: code('self2'), fullName: 'Self Two', reportingManagerId: emp.hr, login: { email: email('self2'), role: 'employee' } })
    expect(withLink.status, JSON.stringify(withLink.body)).toBe(201)
    expect(withLink.body.meta.login_start).toBe('link')
    expect(withLink.body.meta.invite.token).toEqual(expect.any(String))
    // Role logins are still the Super Admin's.
    expect((await post(tokens.acc, '/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'Mine@2026xxx' }).set('X-Requested-With', 'ems')).status).toBe(403)
  })

  it('taken back by the company: a link issued meanwhile can no longer be used', async () => {
    const issued = await post(tokens.boss, `/api/users/${login.asha}/password-link`, {})
    expect(issued.status, JSON.stringify(issued.body)).toBe(201)
    const token = issued.body.data.invite.token
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'company', rolePasswords: 'company', passwordMinLength: 10 })).status).toBe(200)
    const inspect = await request(app).post('/api/auth/password-link/inspect').send({ token })
    expect(inspect.status).toBe(400)
    expect(inspect.body.error.message).toContain('Your password is set by HR')

    // …for good: handed back to employees again, the link stays spent.
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'self', rolePasswords: 'company', passwordMinLength: 10 })).status).toBe(200)
    expect((await request(app).post('/api/auth/password-link/inspect').send({ token })).status).toBe(400)
    const [handedBack, takenBack] = await prisma.auditLog.findMany({ where: { organizationId: orgId, action: 'user.password_rules_updated' }, orderBy: { createdAt: 'desc' }, take: 2 })
    expect(handedBack?.details).toMatchObject({ employeePasswords: 'self', linksSpent: 0 })
    expect(Number((takenBack?.details as { linksSpent?: number } | undefined)?.linksSpent)).toBeGreaterThanOrEqual(1)
  })
})

describe('a Super Admin’s passwords are all their own', () => {
  it('sets the one of their own employee login, and may change it there too', async () => {
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'company', rolePasswords: 'company', passwordMinLength: 10 })).status).toBe(200)
    const added = await post(tokens.boss, `/api/employees/${emp.boss}/logins`, { role: 'employee', password: 'BossEmp@2026' })
    expect(added.status, JSON.stringify(added.body)).toBe(201)
    const ownEmployeeLogin = added.body.data.user.id
    const signed = await signIn(code('boss'), 'BossEmp@2026')
    expect(signed.body.data.user).toMatchObject({ role: 'employee', passwordSetBy: 'self' })

    // From their Super Admin login — but never the login they are signed in with.
    expect((await setPassword(tokens.boss, ownEmployeeLogin, 'BossEmp2@2026')).status).toBe(200)
    const signedIn = await setPassword(tokens.boss, login.boss, 'BossSa@20266')
    expect(signedIn.status).toBe(400)
    expect(signedIn.body.error.message).toContain('change its password on My Profile')
    // Not HR: the person's other login is above HR.
    expect((await setPassword(tokens.hr, ownEmployeeLogin, 'BossEmp3@2026')).status).toBe(403)
    // Nor another Super Admin: every password of a Super Admin is their own.
    const other = await prisma.user.create({ data: { email: email('boss2'), passwordHash: await hashPassword(PASSWORD) } })
    await prisma.membership.create({ data: { userId: other.id, organizationId: orgId, role: 'super_admin', status: 'active' } })
    const otherToken = (await signIn(email('boss2'))).body.data.accessToken
    const bySecond = await setPassword(otherToken, ownEmployeeLogin, 'BossEmp5@2026')
    expect(bySecond.status).toBe(409)
    expect(bySecond.body.error.message).toContain('A Super Admin sets their own passwords')
    const linkBySecond = await post(otherToken, `/api/users/${ownEmployeeLogin}/password-link`, {})
    expect(linkBySecond.status).toBe(409)
    expect(linkBySecond.body.error.message).toContain('from their own page')
    // HR on their own other login: forbidden, like every other change to one's own logins.
    const hr2Employee = await prisma.membership.findFirstOrThrow({ where: { employeeId: emp.hr2, role: 'employee' } })
    const hr2Token = (await signIn(email('hr2'), 'HrTwo@2026x')).body.data.accessToken
    const ownOther = await setPassword(hr2Token, hr2Employee.id, 'HrTwoEmp@2026')
    expect(ownOther.status).toBe(403)
    expect(ownOther.body.error.message).toBe('This is your own login. Ask the Super Admin to set its password.')
    // From the employee login itself, on My Profile.
    const fresh = await signIn(code('boss'), 'BossEmp2@2026')
    const changed = await post(fresh.body.data.accessToken, '/api/auth/change-password', { currentPassword: 'BossEmp2@2026', newPassword: 'BossEmp4@2026' }).set('X-Requested-With', 'ems')
    expect(changed.status, JSON.stringify(changed.body)).toBe(200)
  })
})

describe('where people set their own', () => {
  it('nobody sets an employee’s password for them', async () => {
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'self', rolePasswords: 'company', passwordMinLength: 10 })).status).toBe(200)
    for (const token of [tokens.hr, tokens.boss]) {
      const res = await setPassword(token, login.asha, 'AshaSet@2026')
      expect(res.status).toBe(409)
      expect(res.body.error.message).toContain('they set their own password')
    }
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'company', rolePasswords: 'company', passwordMinLength: 10 })).status).toBe(200)
  })

  it('taking role logins back spends their links — not a Super Admin’s', async () => {
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'company', rolePasswords: 'self', passwordMinLength: 10 })).status).toBe(200)
    const accLink = await post(tokens.boss, `/api/users/${login.acc}/password-link`, {})
    expect(accLink.status, JSON.stringify(accLink.body)).toBe(201)
    const bossLink = await prisma.passwordResetToken.create({
      data: { userId: users.boss, tokenHash: `passwords-test-${Date.now()}`, expiresAt: new Date(Date.now() + 3_600_000), purpose: 'reset' },
    })
    expect((await put(tokens.boss, '/api/users/password-rules', { employeePasswords: 'company', rolePasswords: 'company', passwordMinLength: 10 })).status).toBe(200)

    const inspect = await request(app).post('/api/auth/password-link/inspect').send({ token: accLink.body.data.invite.token })
    expect(inspect.status).toBe(400)
    expect(inspect.body.error.message).toContain('Your password is set by the Super Admin')
    expect((await prisma.passwordResetToken.findUniqueOrThrow({ where: { id: bossLink.id } })).usedAt).toBeNull()
  })
})

describe('Employee IDs and logins, from the reviews', () => {
  it('refuses an ID with an @, which signing in would read as an email', async () => {
    const res = await post(tokens.hr, '/api/employees', { employeeCode: 'PW@01', fullName: 'At Person', reportingManagerId: emp.hr })
    expect(res.status).toBe(422)
  })

  it('refuses an ID in use without naming whose it is', async () => {
    const res = await post(tokens.hr, '/api/employees', { employeeCode: code('asha'), fullName: 'Twin Person', reportingManagerId: emp.hr })
    expect(res.status).toBe(409)
    expect(res.body.error.message).toBe(`Employee ID ${code('asha')} is already in use.`)
  })

  it('keeps a login with no email an employee login', async () => {
    const noEmail = await prisma.membership.findFirstOrThrow({ where: { organizationId: orgId, employee: { employeeCode: code('noemail') } } })
    const res = await put(tokens.boss, `/api/users/${noEmail.id}/role`, { role: 'manager' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toContain('can only be an employee login')
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: noEmail.id } })).role).toBe('employee')
  })

  it('HR gives no login to themselves', async () => {
    const res = await post(tokens.hr, `/api/employees/${emp.hr}/logins`, { role: 'employee', password: 'HrOwn@20266' })
    expect(res.status).toBe(403)
  })

  it('a short password for somebody out of reach is “not found”, like anything else about them', async () => {
    const otherOrg = await prisma.organization.create({ data: { name: `${PREFIX}-other`, timezone: 'Asia/Kolkata' } })
    const stranger = await prisma.user.create({ data: { email: email('stranger'), passwordHash: await hashPassword(PASSWORD) } })
    const strangerLogin = await prisma.membership.create({ data: { userId: stranger.id, organizationId: otherOrg.id, role: 'employee', status: 'active' } })
    expect((await setPassword(tokens.hr, strangerLogin.id, 'short')).status).toBe(404)
  })
})

describe('adding a user (Settings → Users & Roles), where the company sets passwords', () => {
  it('with a password: works at once, by Employee ID when there is no email', async () => {
    const res = await post(tokens.boss, '/api/users/invite', { role: 'employee', employeeCode: code('inv1'), fullName: 'Inv One', password: 'InvOne@2026' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({ login_start: 'password', invite: null, user: { email: null, status: 'active', has_password: true } })
    expect((await signIn(code('inv1').toLowerCase(), 'InvOne@2026')).status).toBe(200)
  })

  it('without one: it waits, with no link', async () => {
    const res = await post(tokens.boss, '/api/users/invite', { email: email('inv2'), role: 'accounts' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({ login_start: 'none', invite: null, user: { status: 'invited', has_password: false } })
  })
})

describe('an Employee ID is matched as the text it is', () => {
  it('takes _ and % for themselves, not as wildcards', async () => {
    // An ID first that a _ in the next one would match as a wildcard.
    const lookalike = await post(tokens.hr, '/api/employees', { employeeCode: `${code('w')}X7`, fullName: 'Look Alike', reportingManagerId: emp.hr, login: { role: 'employee', password: 'Look@202666' } })
    expect(lookalike.status, JSON.stringify(lookalike.body)).toBe(201)
    // As a pattern, "…W_7" would be taken for "…WX7" and refused.
    const withUnderscore = await post(tokens.hr, '/api/employees', { employeeCode: `${code('w')}_7`, fullName: 'Under Score', reportingManagerId: emp.hr, login: { role: 'employee', password: 'Under@20266' } })
    expect(withUnderscore.status, JSON.stringify(withUnderscore.body)).toBe(201)

    // As a pattern, "…w_7" would find both people, and sign in to neither.
    expect((await signIn(`${code('w')}_7`.toLowerCase(), 'Under@20266')).status).toBe(200)
    // As a pattern, "…WX%" would find "…WX7" and sign in to it.
    expect((await signIn(`${code('w')}X%`, 'Look@202666')).status).toBe(401)
    expect((await signIn(`${code('w')}X7`, 'Look@202666')).status).toBe(200)
  })
})
