import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { DEFAULT_ROLES } from '../../platform/authz/defaultRoles'
import { toDateColumn, zonedToday } from '../../domain/shared/dates'

/**
 * Settings → Roles & Permissions (Day 21), end to end through the API.
 *
 * Roles are the company's own rows now: the Super Admin makes them, changes
 * what they may do, and the change reaches the people holding them at their
 * very next request. And the rules the client asked for hold: the Super Admin
 * role is untouchable, nobody edits their own, a role in use cannot go.
 */

const PREFIX = 'rolestest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

let orgId = ''
const tokens: Record<string, string> = {}
const cookies: Record<string, string> = {}
const memberships: Record<string, string> = {}
const emp: Record<string, string> = {}
let salesId = ''
let opsId = ''

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.department.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function signIn(key: string) {
  const res = await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-${key}@example.com`, password: PASSWORD })
  expect(res.status, `sign in ${key}`).toBe(200)
  tokens[key] = res.body.data.accessToken
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined
  const all = Array.isArray(raw) ? raw : raw ? [raw] : []
  cookies[key] = all.find((c) => c.startsWith('ems_refresh='))?.split(';')[0] ?? ''
  return res.body.data.user as { role: string; roleName: string; permissions: string[] }
}

async function person(key: string, role: string, options: { reportsTo?: string; departmentId?: string } = {}) {
  const user = await prisma.user.create({ data: { email: `${PREFIX}-${key}@example.com`, passwordHash: await hashPassword(PASSWORD) } })
  memberships[key] = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })).id
  emp[key] = (
    await prisma.employee.create({
      data: {
        organizationId: orgId,
        membershipId: memberships[key],
        employeeCode: `${PREFIX}-${key}`,
        fullName: `${key[0]!.toUpperCase()}${key.slice(1)} Test`,
        dateOfJoining: toDateColumn('2024-01-08'),
        reportingManagerId: options.reportsTo ?? null,
        departmentId: options.departmentId ?? null,
      },
    })
  ).id
  await signIn(key)
}

const as = (key: string) => `Bearer ${tokens[key]}`
const roles = (key = 'boss') => request(app).get('/api/roles').set('Authorization', as(key))
const create = (body: object, key = 'boss') => request(app).post('/api/roles').set('Authorization', as(key)).send(body)
const update = (roleKey: string, body: object, key = 'boss') => request(app).put(`/api/roles/${roleKey}`).set('Authorization', as(key)).send(body)
const reset = (roleKey: string, version: string, key = 'boss') => request(app).post(`/api/roles/${roleKey}/reset`).set('Authorization', as(key)).send({ version })
const remove = (roleKey: string, key = 'boss') => request(app).delete(`/api/roles/${roleKey}`).set('Authorization', as(key))

type RoleOut = { key: string; name: string; parent_key: string | null; permissions: string[]; scopes: Record<string, string>; version: string; holders: number; built_in: boolean; locked: boolean; changed_from_default: boolean }
async function role(roleKey: string): Promise<RoleOut> {
  const res = await roles()
  const found = (res.body.data.roles as RoleOut[]).find((r) => r.key === roleKey)
  if (!found) throw new Error(`no role ${roleKey}`)
  return found
}

const TEAM_LEAD = {
  name: 'Team Lead',
  description: 'Leads a small team on the floor.',
  parentKey: 'manager',
  permissions: ['dashboard:read', 'notification:read', 'leave:read', 'leave:apply', 'attendance:read'],
  scopes: { leave: 'DIRECT_REPORTS', attendance: 'DIRECT_REPORTS' },
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })
  salesId = (await prisma.department.create({ data: { organizationId: orgId, name: 'Sales' } })).id
  opsId = (await prisma.department.create({ data: { organizationId: orgId, name: 'Operations' } })).id

  await person('boss', 'super_admin')
  await person('hema', 'hr')
  await person('manoj', 'manager')
  await person('tara', 'employee', { reportsTo: undefined, departmentId: salesId })
  await person('ravi', 'employee', { departmentId: salesId })
  await person('omar', 'employee', { departmentId: opsId })
}, 60_000)

afterAll(cleanup)

describe('a new company', () => {
  it('starts with exactly the seven roles in defaultRoles.ts — the database trigger and the code agree', async () => {
    const seeded = await prisma.role.findMany({ where: { organizationId: orgId }, include: { parent: { select: { key: true } } } })
    expect(seeded.map((r) => r.key).sort()).toEqual(DEFAULT_ROLES.map((r) => r.key).sort())
    for (const def of DEFAULT_ROLES) {
      const row = seeded.find((r) => r.key === def.key)!
      expect(row.name, def.key).toBe(def.name)
      expect(row.description, def.key).toBe(def.description)
      expect(row.parent?.key ?? null, def.key).toBe(def.parentKey)
      expect(row.locked, def.key).toBe(def.locked)
      expect(row.builtIn, def.key).toBe(true)
      expect([...row.permissions].sort(), def.key).toEqual([...def.permissions].sort())
      expect(row.scopes, def.key).toEqual(def.scopes)
    }
  })

  it('signs a person in with their role’s name and permissions read from its row', async () => {
    const user = await signIn('hema')
    expect(user.role).toBe('hr')
    expect(user.roleName).toBe('HR')
    expect(user.permissions).toContain('leave:balance:manage')
    expect(user.permissions).not.toContain('role:manage')
  })
})

describe('who may see and change roles', () => {
  it('shows the Super Admin every role and the words to explain them', async () => {
    const res = await roles()
    expect(res.status).toBe(200)
    expect(res.body.data.roles).toHaveLength(7)
    const modules = res.body.data.catalogue.modules as { permissions: { key: string }[] }[]
    const offered = modules.flatMap((m) => m.permissions.map((p) => p.key))
    expect(offered).not.toContain('role:manage')
    expect(res.body.data.catalogue.scopes.map((s: { label: string }) => s.label)).toEqual([
      'Only their own',
      'Their team',
      'Everybody under them',
      'Their department',
      'Whole company, except seniors',
      'Whole company',
    ])
    // Approving leave is the company tree's, not a tick.
    expect(offered).not.toContain('leave:approve')
  })

  it('refuses everybody else', async () => {
    for (const key of ['hema', 'manoj', 'tara']) {
      expect((await roles(key)).status, key).toBe(403)
      expect((await create(TEAM_LEAD, key)).status, key).toBe(403)
    }
  })
})

describe('making a role and giving it to somebody', () => {
  let leadVersion = ''

  it('creates a role with a key made from its name', async () => {
    const res = await create(TEAM_LEAD)
    expect(res.status).toBe(201)
    expect(res.body.data.key).toBe('team_lead')
    const lead = await role('team_lead')
    expect(lead.parent_key).toBe('manager')
    expect(lead.built_in).toBe(false)
    expect(lead.scopes.leave).toBe('DIRECT_REPORTS')
    // A module not mentioned reaches the holder's own rows only.
    expect(lead.scopes.payslip).toBe('SELF')
    leadVersion = lead.version
  })

  it('lets the Super Admin give it, and the holder signs in with exactly what it allows', async () => {
    const res = await request(app).put(`/api/users/${memberships.manoj}/role`).set('Authorization', as('boss')).send({ role: 'team_lead' })
    expect(res.status).toBe(200)
    expect(res.body.data.role_name).toBe('Team Lead')
    const user = await signIn('manoj')
    expect(user.roleName).toBe('Team Lead')
    expect([...user.permissions].sort()).toEqual([...TEAM_LEAD.permissions].sort())
    expect((await request(app).get('/api/leave-requests').set('Authorization', as('manoj'))).status).toBe(200)
    expect((await request(app).get('/api/payroll-runs').set('Authorization', as('manoj'))).status).toBe(403)
  })

  it('applies a change at the holder’s very next request, and the refresh hands their screen the new list', async () => {
    const lead = await role('team_lead')
    const res = await update('team_lead', { ...TEAM_LEAD, permissions: [...TEAM_LEAD.permissions, 'report:read'], version: lead.version })
    expect(res.status).toBe(200)
    expect(res.body.data.holders).toBe(1)

    // Their old access token is ended — not their session.
    expect((await request(app).get('/api/leave-requests').set('Authorization', as('manoj'))).status).toBe(401)
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookies.manoj!).set('X-Requested-With', 'ems').send({})
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.data.user.permissions).toContain('report:read')
    tokens.manoj = refreshed.body.data.accessToken
    expect((await request(app).get('/api/reports/headcount').set('Authorization', as('manoj'))).status).not.toBe(403)
    leadVersion = (await role('team_lead')).version
  })

  it('refuses an edit made on an out-of-date copy', async () => {
    const stale = await update('team_lead', { ...TEAM_LEAD, version: '1' })
    expect(stale.status).toBe(409)
    expect(stale.body.error.message).toMatch(/changed this role while you were editing/)
    expect((await role('team_lead')).version).toBe(leadVersion)
  })
})

describe('what a role cannot be made into', () => {
  it('refuses a permission that is not one, or that is the Super Admin’s alone', async () => {
    const unknown = await create({ ...TEAM_LEAD, name: 'Odd', permissions: ['payroll:everything'] })
    expect(unknown.status).toBe(400)
    const own = await create({ ...TEAM_LEAD, name: 'Shadow Admin', permissions: ['role:manage'] })
    expect(own.status).toBe(400)
    expect(own.body.error.message).toMatch(/stays with the Super Admin/)
  })

  it('refuses a permission without what it needs to work', async () => {
    const res = await create({ ...TEAM_LEAD, name: 'Approver', permissions: ['leave:balance:manage'] })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe('“Give the yearly leave and correct balances” needs “See leave requests and balances” ticked too.')
  })

  it('refuses a name already taken, whatever its case, and a scope EMS does not know', async () => {
    expect((await create({ ...TEAM_LEAD, name: 'team lead' })).status).toBe(400)
    expect((await create({ ...TEAM_LEAD, name: 'Hr' })).body.error.message).toMatch(/already a role called “HR”/)
    expect((await create({ ...TEAM_LEAD, name: 'Widest', scopes: { leave: 'EVERYONE' } })).status).toBe(400)
  })

  it('refuses an order that loops', async () => {
    const res = await create({ ...TEAM_LEAD, name: 'Under Lead', parentKey: 'team_lead' })
    expect(res.status).toBe(201)
    const lead = await role('team_lead')
    const loop = await update('team_lead', { ...TEAM_LEAD, parentKey: 'under_lead', version: lead.version })
    expect(loop.status).toBe(400)
    expect(loop.body.error.message).toMatch(/cannot come under itself/)
  })

  it('warns — and still saves — when one role could both prepare and approve the payroll', async () => {
    const res = await create({
      name: 'Payroll Desk',
      description: '',
      parentKey: 'super_admin',
      permissions: ['payroll:structure:read', 'payroll:run:create', 'payroll:run:approve'],
      scopes: {},
    })
    expect(res.status).toBe(201)
    expect(res.body.data.warnings).toHaveLength(1)
    expect(res.body.data.warnings[0]).toMatch(/both prepare and approve the payroll/)
  })

  it('warns — and still saves — when a role can read the audit log, which shows the whole company', async () => {
    const res = await create({ name: 'Log Reader', description: '', parentKey: 'super_admin', permissions: ['audit:read'], scopes: {} })
    expect(res.status).toBe(201)
    expect(res.body.data.warnings).toHaveLength(1)
    expect(res.body.data.warnings[0]).toMatch(/audit log shows everything/)
    expect((await remove('log_reader')).status).toBe(204)
  })
})

describe('the locks that are always on', () => {
  it('never lets the Super Admin role be changed, reset or deleted', async () => {
    const sa = await role('super_admin')
    expect((await update('super_admin', { ...TEAM_LEAD, name: 'Super Admin', parentKey: 'super_admin', version: sa.version })).status).toBe(403)
    expect((await reset('super_admin', sa.version)).status).toBe(403)
    const removed = await remove('super_admin')
    expect(removed.status).toBe(403)
    expect(removed.body.error.message).toBe('The Super Admin role cannot be changed or deleted.')
  })

  it('never deletes a built-in role, a role somebody holds, or one other roles come under', async () => {
    expect((await remove('rm')).body.error.message).toMatch(/can be changed or reset, but not deleted/)
    expect((await remove('team_lead')).body.error.message).toMatch(/Somebody still holds this role/)
    await request(app).put(`/api/users/${memberships.manoj}/role`).set('Authorization', as('boss')).send({ role: 'manager' })
    expect((await remove('team_lead')).body.error.message).toMatch(/Other roles come under this one/)
    expect((await remove('under_lead')).status).toBe(204)
    expect((await remove('team_lead')).status).toBe(204)
  })
})

describe('reset to default', () => {
  it('puts a changed built-in role back exactly as EMS started it, and says so in the log', async () => {
    const hr = await role('hr')
    const changed = await update('hr', {
      name: 'People Team',
      description: 'Renamed for the test.',
      parentKey: 'super_admin',
      permissions: ['dashboard:read', 'employee:read'],
      scopes: { employee: 'DEPARTMENT' },
      version: hr.version,
    })
    expect(changed.status).toBe(200)
    expect((await role('hr')).changed_from_default).toBe(true)

    const res = await reset('hr', (await role('hr')).version)
    expect(res.status).toBe(200)
    const back = await role('hr')
    const def = DEFAULT_ROLES.find((r) => r.key === 'hr')!
    expect(back.name).toBe('HR')
    expect([...back.permissions].sort()).toEqual([...def.permissions].sort())
    expect(back.scopes).toEqual(def.scopes)
    expect(back.changed_from_default).toBe(false)

    const log = await prisma.auditLog.findMany({ where: { organizationId: orgId, action: { in: ['role.updated', 'role.reset'] }, entityId: 'hr' }, orderBy: { createdAt: 'asc' } })
    expect(log.map((r) => r.action)).toEqual(['role.updated', 'role.reset'])
    const resetDetails = log[1]!.details as { previousName: string; added: string[] }
    expect(resetDetails.previousName).toBe('People Team')
    expect(resetDetails.added).toContain('Give the yearly leave and correct balances')
  })

  it('reads every role change in the audit log as a sentence, with the actor’s role by name', async () => {
    const res = await request(app).get('/api/audit-log?category=users').set('Authorization', as('boss'))
    expect(res.status).toBe(200)
    const summaries = (res.body.data as { summary: string; actor: { role: string } | null }[]).map((r) => r.summary)
    expect(summaries).toContain('Created the role “Team Lead” under Manager, which can: Open the dashboard, See their own notifications, See leave requests and balances, Apply for their own leave and 1 more; reaches Attendance: Their team and Leave: Their team')
    expect(summaries).toContain('Deleted the role “Team Lead”, which reached Attendance: Their team and Leave: Their team')
    expect(summaries.some((s) => s.startsWith('Reset the role “HR” to how it started: renamed from “People Team”'))).toBe(true)
    expect((res.body.data as { actor: { role: string } | null }[]).every((r) => !r.actor || r.actor.role === 'Super Admin')).toBe(true)
  })
})

describe('whose information a custom role reaches', () => {
  it('honours "their department" in the employee list — their own department and themselves, nobody else', async () => {
    const created = await create({
      name: 'Department Lead',
      description: '',
      parentKey: 'manager',
      permissions: ['employee:read'],
      scopes: { employee: 'DEPARTMENT' },
    })
    expect(created.status).toBe(201)
    await request(app).put(`/api/users/${memberships.tara}/role`).set('Authorization', as('boss')).send({ role: 'department_lead' })
    await signIn('tara')
    const res = await request(app).get('/api/employees').set('Authorization', as('tara'))
    expect(res.status).toBe(200)
    const ids = (res.body.data as { id: string }[]).map((e) => e.id).sort()
    expect(ids).toEqual([emp.tara!, emp.ravi!].sort())
    // Somebody in Operations is not found — 404, never 403.
    expect((await request(app).get(`/api/employees/${emp.omar}`).set('Authorization', as('tara'))).status).toBe(404)
  })

  it('sends a request to the person it goes to in the company tree, whatever their role, who decides it (Day 22)', async () => {
    // Omar reports to Tara, whose role holds no leave right at all.
    await prisma.employee.update({ where: { id: emp.omar! }, data: { reportingManagerId: emp.tara } })
    const casual = await prisma.leaveType.findFirstOrThrow({ where: { organizationId: orgId } })
    const today = zonedToday(new Date(), 'Asia/Kolkata')
    const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp.omar!, leaveTypeId: casual.id, leaveYear: year, days: 5, reason: 'opening_grant' } })
    // Two days in February of this leave year: at least one is a working day.
    const applied = await request(app)
      .post('/api/leave-requests')
      .set('Authorization', as('omar'))
      .send({ leaveTypeId: casual.id, fromDate: `${year + 1}-02-09`, toDate: `${year + 1}-02-10`, reason: 'Family function' })
    expect(applied.status, JSON.stringify(applied.body)).toBe(201)
    const userOf = async (who: string) => (await prisma.membership.findUniqueOrThrow({ where: { id: memberships[who]! }, select: { userId: true } })).userId
    const told = (who: string) => userOf(who).then((userId) => prisma.notification.findFirst({ where: { userId, event: 'leave.submitted', entityId: applied.body.data.id } }))
    expect(await told('tara')).not.toBeNull()
    // The Super Admin, HR: not told — it is not theirs to decide.
    expect(await told('boss')).toBeNull()
    expect(await told('hema')).toBeNull()

    // Tara sees it under Team requests and decides it, though her leave scope is her own rows.
    const team = await request(app).get('/api/leave-requests/team').set('Authorization', as('tara'))
    expect(team.status).toBe(200)
    expect((team.body.data.requests as { id: string; can_decide: boolean }[]).find((r) => r.id === applied.body.data.id)?.can_decide).toBe(true)
    expect((await request(app).post(`/api/leave-requests/${applied.body.data.id}/approve`).set('Authorization', as('tara')).send({})).status).toBe(200)
    await prisma.employee.update({ where: { id: emp.omar! }, data: { reportingManagerId: null } })
  })
})

describe('a custom scope reaches only what the role can open (review fixes)', () => {
  const yesterday = () => zonedToday(new Date(Date.now() - 86_400_000), 'Asia/Kolkata')
  const give = async (who: string, role: string) => {
    const res = await request(app).put(`/api/users/${memberships[who]}/role`).set('Authorization', as('boss')).send({ role })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    await signIn(who)
  }

  beforeAll(async () => {
    await person('lead', 'employee', { departmentId: salesId })
    await person('member', 'employee', { reportsTo: emp.lead, departmentId: salesId })
    await person('deptlead', 'employee', { departmentId: salesId })
  })

  it('marks attendance only for the team a team-scoped role reaches', async () => {
    expect((await create({
      name: 'Floor Marker',
      description: '',
      parentKey: 'manager',
      permissions: ['attendance:read', 'attendance:mark'],
      scopes: { attendance: 'DIRECT_REPORTS' },
    })).status).toBe(201)
    await give('lead', 'floor_marker')
    const mark = (employeeId: string) =>
      request(app).post('/api/attendance/mark').set('Authorization', as('lead')).send({ employeeId, date: yesterday(), status: 'absent' })
    // Somebody in another department, outside the team: not found, and nothing written.
    expect((await mark(emp.omar!)).status).toBe(404)
    expect(await prisma.attendance.count({ where: { employeeId: emp.omar!, date: toDateColumn(yesterday()) } })).toBe(0)
    // Their own report: marked.
    expect([200, 201]).toContain((await mark(emp.member!)).status)
  })

  it('refuses, before saving anything, to add a person the role would not be able to see', async () => {
    expect((await create({
      name: 'Hiring Lead',
      description: '',
      parentKey: 'manager',
      permissions: ['employee:read', 'employee:create'],
      scopes: { employee: 'DIRECT_REPORTS' },
    })).status).toBe(201)
    await give('lead', 'hiring_lead')
    const outside = await request(app).post('/api/employees').set('Authorization', as('lead')).send({ employeeCode: `${PREFIX}-out`, fullName: 'Out Side' })
    expect(outside.status).toBe(400)
    expect(outside.body.error.message).toMatch(/only people you will be able to see\. Set yourself as their reporting manager/)
    expect(await prisma.employee.count({ where: { employeeCode: `${PREFIX}-out` } })).toBe(0)
    const inside = await request(app).post('/api/employees').set('Authorization', as('lead'))
      .send({ employeeCode: `${PREFIX}-in`, fullName: 'In Side', reportingManagerId: emp.lead })
    expect(inside.status, JSON.stringify(inside.body)).toBe(201)
  })

  it('offers payslips only their own or the company’s, and refuses a team', async () => {
    const res = await create({ name: 'Payslip Team', description: '', parentKey: 'manager', permissions: ['payslip:read'], scopes: { payslip: 'DIRECT_REPORTS' } })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toBe('For payslips, choose “Only their own” or “Whole company”.')
    const payslips = (await roles()).body.data.catalogue.modules.find((m: { key: string }) => m.key === 'payslips')
    expect(payslips.scopes).toEqual(['SELF', 'ORGANIZATION'])
  })

  it('sends the request of somebody with nobody above to the Super Admin — not to a role that sees leave', async () => {
    expect((await create({
      name: 'Dept Leave Lead',
      description: '',
      parentKey: 'manager',
      permissions: ['leave:read'],
      scopes: { leave: 'DEPARTMENT' },
    })).status).toBe(201)
    await give('deptlead', 'dept_leave_lead')
    const casual = await prisma.leaveType.findFirstOrThrow({ where: { organizationId: orgId } })
    const today = zonedToday(new Date(), 'Asia/Kolkata')
    const year = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp.ravi!, leaveTypeId: casual.id, leaveYear: year, days: 5, reason: 'opening_grant' } })
    const sales = await request(app).post('/api/leave-requests').set('Authorization', as('ravi'))
      .send({ leaveTypeId: casual.id, fromDate: `${year + 1}-02-16`, toDate: `${year + 1}-02-17`, reason: 'Family function' })
    expect(sales.status, JSON.stringify(sales.body)).toBe(201)
    const toldOf = async (who: string) => {
      const userId = (await prisma.membership.findUniqueOrThrow({ where: { id: memberships[who]! }, select: { userId: true } })).userId
      return (await prisma.notification.findMany({ where: { userId, event: 'leave.submitted' }, select: { entityId: true } })).map((n) => n.entityId)
    }
    // Ravi has nobody above: the Super Admin decides, and is told.
    expect(await toldOf('boss')).toContain(sales.body.data.id)
    // The department's leave lead sees it — and decides none of it.
    expect(await toldOf('deptlead')).not.toContain(sales.body.data.id)
    await signIn('deptlead')
    const seen = await request(app).get('/api/leave-requests?status=pending').set('Authorization', as('deptlead'))
    const row = (seen.body.data as { id: string; can_decide: boolean; decided_by: string }[]).find((r) => r.id === sales.body.data.id)
    expect(row?.can_decide).toBe(false)
    expect(row?.decided_by).toBe('the Super Admin')
    const refused = await request(app).post(`/api/leave-requests/${sales.body.data.id}/approve`).set('Authorization', as('deptlead')).send({})
    expect(refused.status).toBe(403)
    expect(refused.body.error.message).toMatch(/decided by the Super Admin/)
  })

  it('opens the Users list to a role that can only switch logins on and off', async () => {
    expect((await create({ name: 'Login Keeper', description: '', parentKey: 'super_admin', permissions: ['user:status:update'], scopes: {} })).status).toBe(201)
    await give('member', 'login_keeper')
    expect((await request(app).get('/api/users').set('Authorization', as('member'))).status).toBe(200)
    expect((await request(app).post('/api/users/invite').set('Authorization', as('member')).send({ email: `${PREFIX}-z@example.com`, role: 'employee' })).status).toBe(403)
  })
})

describe('reach cannot be widened from the inside (core review fixes)', () => {
  const patch = (who: string, id: string, body: object) =>
    request(app).patch(`/api/employees/${id}`).set('Authorization', as(who)).send(body)
  const give = async (who: string, role: string) => {
    const res = await request(app).put(`/api/users/${memberships[who]}/role`).set('Authorization', as('boss')).send({ role })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
  }
  const reuseAlarms = async (who: string) => {
    const { userId } = await prisma.membership.findUniqueOrThrow({ where: { id: memberships[who]! }, select: { userId: true } })
    return prisma.auditLog.count({ where: { action: 'auth.refresh_token_reused', entityId: userId } })
  }

  beforeAll(async () => {
    await person('clerk', 'employee', { departmentId: salesId })
    await person('gate', 'employee', { departmentId: salesId })
    await person('sam', 'employee', { departmentId: salesId })
    await person('adm', 'admin')
    await person('aud', 'employee', { departmentId: opsId })
  })

  it('refuses a person moving themselves, and moving the MD into a team whose salaries they see', async () => {
    expect((await create({
      name: 'Records Clerk',
      description: '',
      parentKey: 'super_admin',
      permissions: ['employee:read', 'employee:update', 'employee:compensation:read'],
      scopes: { employee: 'ORGANIZATION', compensation: 'DIRECT_REPORTS' },
    })).status).toBe(201)
    await give('clerk', 'records_clerk')
    await signIn('clerk')

    const self = await patch('clerk', emp.clerk!, { departmentId: opsId })
    expect(self.status).toBe(403)
    expect(self.body.error.message).toMatch(/cannot change your own reporting manager or department/)

    const md = await patch('clerk', emp.boss!, { reportingManagerId: emp.clerk })
    expect(md.status).toBe(403)
    expect(md.body.error.message).toBe('That change would put this person in your team, which would show you more of their information (salaries). Ask somebody above you to make it.')
    const boss = await prisma.employee.findUniqueOrThrow({ where: { id: emp.boss! }, select: { reportingManagerId: true } })
    expect(boss.reportingManagerId).toBeNull()

    // A move that does not bring anybody into their reach is still theirs to make.
    expect((await patch('clerk', emp.omar!, { departmentId: salesId })).status).toBe(200)
    expect((await patch('clerk', emp.omar!, { departmentId: opsId })).status).toBe(200)
  })

  it('lets a department-scoped login keeper see and switch off only their department’s logins', async () => {
    expect((await create({
      name: 'Dept Login Keeper',
      description: '',
      parentKey: 'super_admin',
      permissions: ['dashboard:read', 'user:invite', 'user:status:update'],
      scopes: { employee: 'DEPARTMENT' },
    })).status).toBe(201)
    expect((await create({ name: 'Floor Staff', description: '', parentKey: 'dept_login_keeper', permissions: ['dashboard:read'], scopes: {} })).status).toBe(201)
    await give('gate', 'dept_login_keeper')
    await give('sam', 'floor_staff')
    await signIn('gate')

    const list = await request(app).get('/api/users').set('Authorization', as('gate'))
    expect(list.status).toBe(200)
    expect(list.body.meta.reach).toBe('DEPARTMENT')
    const listed = (list.body.data as { id: string }[]).map((u) => u.id)
    expect(listed).toContain(memberships.sam)
    expect(listed).not.toContain(memberships.omar)
    expect(listed).not.toContain(memberships.boss)

    const status = (who: string, value: string) =>
      request(app).patch(`/api/users/${memberships[who]}/status`).set('Authorization', as('gate')).send({ status: value })
    // Another department's login: not found, and left as it was.
    expect((await status('omar', 'inactive')).status).toBe(404)
    expect((await prisma.membership.findUniqueOrThrow({ where: { id: memberships.omar! } })).status).toBe('active')
    // Their own department's, with a role below theirs: switched off and on.
    expect((await status('sam', 'inactive')).status).toBe(200)
    expect((await status('sam', 'active')).status).toBe(200)
  })

  it('refuses an invitation from a narrower reach, which could never see the login it made', async () => {
    const invite = (body: object) => request(app).post('/api/users/invite').set('Authorization', as('gate')).send(body)
    const withCode = await invite({ email: `${PREFIX}-coded@example.com`, role: 'floor_staff', fullName: 'Coded Person', employeeCode: `${PREFIX}-coded` })
    expect(withCode.status).toBe(403)
    expect(withCode.body.error.message).toMatch(/Inviting adds somebody outside any team or department, so it needs a company-wide reach/)
    expect(await prisma.employee.count({ where: { employeeCode: `${PREFIX}-coded` } })).toBe(0)
    const plain = await invite({ email: `${PREFIX}-plain@example.com`, role: 'floor_staff' })
    expect(plain.status).toBe(403)
    expect(await prisma.user.count({ where: { email: { in: [`${PREFIX}-coded@example.com`, `${PREFIX}-plain@example.com`] } } })).toBe(0)
  })

  it('answers a narrower reach "not found" for a login outside it, before saying anything about that login', async () => {
    // Omar's login, switched off: from outside the reach, neither "switched off" nor "bad role" — not found.
    await prisma.membership.update({ where: { id: memberships.omar! }, data: { status: 'inactive' } })
    const link = await request(app).post(`/api/users/${memberships.omar}/password-link`).set('Authorization', as('gate')).send({})
    expect(link.status).toBe(404)
    await prisma.membership.update({ where: { id: memberships.omar! }, data: { status: 'active' } })
  })

  it('refuses a roster import to anybody whose reach is narrower than the company', async () => {
    const csv = 'employee_code,full_name,email\nrolestest-imp1,Imp One,rolestest-imp1@example.com\n'
    const res = await request(app).post('/api/employees/import').set('Authorization', as('lead')).send({ csv, dryRun: true })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/needs a company-wide reach/)
  })

  it('refuses in the preview, not only on import, the logins the importer cannot give', async () => {
    // Admin reaches the whole company but cannot give the Employee role (it is not below Admin).
    const withEmail = 'employee_code,full_name,email\nrolestest-imp2,Imp Two,rolestest-imp2@example.com\n'
    const preview = await request(app).post('/api/employees/import').set('Authorization', as('adm')).send({ csv: withEmail, dryRun: true })
    expect(preview.status).toBe(403)
    expect(preview.body.error.message).toMatch(/cannot give Employee logins, so this file cannot be imported with its email column/)
    const records = await request(app).post('/api/employees/import').set('Authorization', as('adm'))
      .send({ csv: 'employee_code,full_name\nrolestest-imp2,Imp Two\n', dryRun: true })
    expect(records.status, JSON.stringify(records.body)).toBe(200)
    expect(records.body.data.summary.valid, JSON.stringify(records.body.data.rows)).toBe(1)
  })

  it('fills the audit log’s filters for a role that holds only the audit log', async () => {
    expect((await create({ name: 'Audit Reader', description: '', parentKey: 'super_admin', permissions: ['audit:read'], scopes: {} })).status).toBe(201)
    await give('aud', 'audit_reader')
    await signIn('aud')
    expect((await request(app).get('/api/users').set('Authorization', as('aud'))).status).toBe(403)
    const people = await request(app).get('/api/audit-log/people').set('Authorization', as('aud'))
    expect(people.status).toBe(200)
    const actors = (people.body.data.actors as { user_id: string; name: string }[]).map((a) => a.name)
    const employees = (people.body.data.employees as { id: string; name: string; code: string }[]).map((e) => e.id)
    expect(actors).toContain('Boss Test')
    expect(actors).toContain('Omar Test')
    expect(employees).toEqual(expect.arrayContaining([emp.boss, emp.omar, emp.ravi]))
    expect((await request(app).get('/api/audit-log/people').set('Authorization', as('ravi'))).status).toBe(403)
  })

  it('keeps the holder signed in through a role change, with no stolen-session alarm', async () => {
    await signIn('ravi')
    const before = await reuseAlarms('ravi')
    await give('ravi', 'floor_staff')
    // The old access token is ended; the session is not.
    expect((await request(app).get('/api/notifications').set('Authorization', as('ravi'))).status).toBe(401)
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookies.ravi!).set('X-Requested-With', 'ems').send({})
    expect(refreshed.status).toBe(200)
    expect(refreshed.body.data.user.roleName).toBe('Floor Staff')
    expect(await reuseAlarms('ravi')).toBe(before)
  })

  it('ends the session of a login switched off, and its browser’s next refresh raises no alarm', async () => {
    await signIn('sam')
    const before = await reuseAlarms('sam')
    expect((await request(app).patch(`/api/users/${memberships.sam}/status`).set('Authorization', as('gate')).send({ status: 'inactive' })).status).toBe(200)
    const refreshed = await request(app).post('/api/auth/refresh').set('Cookie', cookies.sam!).set('X-Requested-With', 'ems').send({})
    expect(refreshed.status).toBe(401)
    expect(refreshed.body.error.message).toBe('Your session has ended. Please sign in again.')
    expect(await reuseAlarms('sam')).toBe(before)
  })
})

describe('the roles one may hand out', () => {
  it('are every role for the Super Admin, and refused to somebody who makes no logins', async () => {
    const all = await request(app).get('/api/roles/assignable').set('Authorization', as('boss'))
    expect(all.status).toBe(200)
    expect((all.body.data as { key: string }[]).map((r) => r.key)).toContain('super_admin')
    expect((await request(app).get('/api/roles/assignable').set('Authorization', as('omar'))).status).toBe(403)
  })

  it('are only those below HR, with nothing HR cannot do, for HR adding an employee', async () => {
    // HR's role was reset above, which ended HR's access token on purpose.
    expect((await request(app).get('/api/roles/assignable').set('Authorization', as('hema'))).status).toBe(401)
    await signIn('hema')
    const res = await request(app).get('/api/roles/assignable').set('Authorization', as('hema'))
    expect(res.status).toBe(200)
    const keys = (res.body.data as { key: string }[]).map((r) => r.key)
    expect(keys).toEqual(expect.arrayContaining(['manager', 'rm', 'employee']))
    expect(keys).not.toContain('accounts')
    expect(keys).not.toContain('super_admin')
    expect(keys).not.toContain('hr')
  })

  it('refuses a role above HR even when the request asks for it directly', async () => {
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hema'))
      .send({ employeeCode: `${PREFIX}-x1`, fullName: 'X One', login: { email: `${PREFIX}-x1@example.com`, role: 'accounts' } })
    expect(res.status).toBe(403)
    expect(await prisma.employee.count({ where: { employeeCode: `${PREFIX}-x1` } })).toBe(0)
  })
})
