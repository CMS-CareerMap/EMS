import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { fromDateColumn } from '../../domain/shared/dates'

/**
 * Employee writes and user management, over real HTTP.
 *
 * Two things are being proved here, and the guide names both:
 *
 *   1. A create that fails leaves ZERO rows — not an employee with a missing
 *      statutory record, which would look fine in a list and be wrong forever.
 *   2. Nobody can change their own role BY ANY ROUTE. Not through the role
 *      endpoint, not through the employee body, not through an invitation.
 *      One blocked path is not a fix; three are the fix.
 */

const PREFIX = 'usrtest'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
let otherOrgId = ''
let otherCompanyEmpId = ''

const tokens: Record<string, string> = {}
const memberships: Record<string, string> = {}

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.passwordResetToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(key: string, role: 'super_admin' | 'hr' | 'manager' | 'employee') {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  await prisma.employee.create({
    data: {
      organizationId: orgId,
      memberships: { connect: { id: membership.id } },
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key} person`,
    },
  })

  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
  memberships[key] = membership.id
}

/** Tokens go stale whenever a test revokes sessions; this re-reads one. */
async function loginAs(key: string): Promise<string> {
  const res = await request(app)
    .post('/api/auth/login')
    .send({ identifier: `${PREFIX}-${key}@example.com`, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
  return tokens[key]!
}

const as = (key: string) => `Bearer ${tokens[key]}`

beforeAll(async () => {
  await cleanup()

  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org` } })
  orgId = org.id
  const other = await prisma.organization.create({ data: { name: `${PREFIX}-other` } })
  otherOrgId = other.id

  const foreign = await prisma.employee.create({
    data: { organizationId: otherOrgId, employeeCode: `${PREFIX}-foreign`, fullName: 'Elsewhere' },
  })
  otherCompanyEmpId = foreign.id

  await makeUser('boss', 'super_admin')
  await makeUser('boss2', 'super_admin')
  await makeUser('hr', 'hr')
  await makeUser('mgr', 'manager')
  await makeUser('emp', 'employee')
})

beforeEach(async () => {
  // Remove anything a previous test created, so employee codes and emails are
  // free again and counts start from a known place.
  await prisma.employeeStatutoryIdentity.deleteMany({
    where: { employee: { employeeCode: { startsWith: `${PREFIX}-new` } } },
  })
  await prisma.employee.deleteMany({ where: { employeeCode: { startsWith: `${PREFIX}-new` } } })
  await prisma.passwordResetToken.deleteMany({
    where: { user: { email: { startsWith: `${PREFIX}-new` } } },
  })
  await prisma.membership.deleteMany({ where: { user: { email: { startsWith: `${PREFIX}-new` } } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: `${PREFIX}-new` } } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('POST /api/employees', () => {
  const valid = () => ({
    employeeCode: `${PREFIX}-new1`,
    fullName: 'Newly Hired',
    phone: '9876543210',
    employmentType: 'full_time' as const,
  })

  it('creates an employee', async () => {
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send(valid())

    expect(res.status).toBe(201)
    expect(res.body.data.full_name).toBe('Newly Hired')
    expect(res.body.data.employee_id).toBe(`${PREFIX}-new1`)
  })

  it('creates the employee and their statutory record together', async () => {
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send({ ...valid(), statutory: { pan: 'ZZZZZ9999Z', ptState: 'Karnataka' } })

    expect(res.status).toBe(201)
    // HR holds employee:identity:read, so it comes back on the same response.
    expect(res.body.data.pan).toBe('ZZZZZ9999Z')

    const stored = await prisma.employeeStatutoryIdentity.findFirst({
      where: { employee: { employeeCode: `${PREFIX}-new1` } },
    })
    expect(stored?.ptState).toBe('Karnataka')
  })

  it('leaves ZERO rows when part of the request is bad', async () => {
    // A department id that does not exist fails the foreign key AFTER the
    // employee insert has been issued. Without a transaction this leaves an
    // employee behind; with one it leaves nothing.
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send({ ...valid(), departmentId: '00000000-0000-0000-0000-000000000000' })

    expect(res.status).toBeGreaterThanOrEqual(400)

    const employees = await prisma.employee.count({
      where: { employeeCode: `${PREFIX}-new1` },
    })
    expect(employees, 'a failed create must leave nothing behind').toBe(0)
  })

  it('leaves zero rows when the login half fails', async () => {
    // Same test from the other side: the employee insert succeeds, then the
    // invitation fails because that email already has access.
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', as('boss'))
      .send({
        ...valid(),
        login: { email: `${PREFIX}-hr@example.com`, role: 'employee' },
      })

    expect(res.status).toBeGreaterThanOrEqual(400)
    expect(await prisma.employee.count({ where: { employeeCode: `${PREFIX}-new1` } })).toBe(0)
  })

  it('rejects a duplicate employee code with 409, not 500', async () => {
    await request(app).post('/api/employees').set('Authorization', as('hr')).send(valid())
    const again = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send(valid())

    expect(again.status).toBe(409)
    expect(again.body.error.code).toBe('CONFLICT')
  })

  it('creates a login with no password and a single-use invitation', async () => {
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', as('boss'))
      .send({
        ...valid(),
        login: { email: `${PREFIX}-newhire@example.com`, role: 'employee' },
      })

    expect(res.status).toBe(201)
    expect(res.body.meta.invite.token).toEqual(expect.any(String))

    const user = await prisma.user.findUnique({
      where: { email: `${PREFIX}-newhire@example.com` },
    })
    // No password means no password can match. There is no default credential.
    expect(user?.passwordHash).toBeNull()

    const stored = await prisma.passwordResetToken.findFirst({ where: { userId: user!.id } })
    expect(stored).toBeTruthy()
    // Only the hash is kept — a database dump is not a list of live invitations.
    expect(stored?.tokenHash).not.toBe(res.body.meta.invite.token)
  })

  it('an invited user cannot sign in until they set a password', async () => {
    await request(app)
      .post('/api/employees')
      .set('Authorization', as('boss'))
      .send({ ...valid(), login: { email: `${PREFIX}-newhire@example.com`, role: 'employee' } })

    const res = await request(app)
      .post('/api/auth/login')
      .send({ identifier: `${PREFIX}-newhire@example.com`, password: PASSWORD })

    expect(res.status).toBe(401)
  })

  it('refuses a manager, who may read the directory but not add to it', async () => {
    const res = await request(app)
      .post('/api/employees')
      .set('Authorization', as('mgr'))
      .send(valid())

    expect(res.status).toBe(403)
  })
})

describe('the three fields that may never be in an employee body', () => {
  const attempt = (extra: Record<string, unknown>) =>
    request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send({ employeeCode: `${PREFIX}-new2`, fullName: 'Sneaky', ...extra })

  it('rejects a role', async () => {
    // The escalation this closes: HR creating a record with role super_admin.
    const res = await attempt({ role: 'super_admin' })
    expect(res.status).toBe(422)
    expect(JSON.stringify(res.body.error.details)).toContain('role')
  })

  it('rejects an account status', async () => {
    const res = await attempt({ status: 'active' })
    expect(res.status).toBe(422)
  })

  it('rejects a salary', async () => {
    // §3.2 gives salary structures to super_admin and accounts. HR creates
    // employees; accepting ctc here would hand HR a power the client withheld.
    const res = await attempt({ ctc: 5000000 })
    expect(res.status).toBe(422)
  })

  it('rejects them on PATCH as well as POST', async () => {
    const created = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send({ employeeCode: `${PREFIX}-new3`, fullName: 'Patchable' })

    for (const body of [{ role: 'super_admin' }, { status: 'inactive' }, { ctc: 1 }]) {
      const res = await request(app)
        .patch(`/api/employees/${created.body.data.id}`)
        .set('Authorization', as('hr'))
        .send(body)
      expect(res.status, JSON.stringify(body)).toBe(422)
    }
  })
})

describe('PATCH /api/employees/:id', () => {
  it('updates a field', async () => {
    const created = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send({ employeeCode: `${PREFIX}-new4`, fullName: 'Before' })

    const res = await request(app)
      .patch(`/api/employees/${created.body.data.id}`)
      .set('Authorization', as('hr'))
      .send({ fullName: 'After' })

    expect(res.status).toBe(200)
    expect(res.body.data.full_name).toBe('After')
  })

  it('cannot reach an employee in another company', async () => {
    const res = await request(app)
      .patch(`/api/employees/${otherCompanyEmpId}`)
      .set('Authorization', as('boss'))
      .send({ fullName: 'Hijacked' })

    expect(res.status).toBe(404)

    const untouched = await prisma.employee.findUnique({ where: { id: otherCompanyEmpId } })
    expect(untouched?.fullName).toBe('Elsewhere')
  })

  it('refuses an empty body rather than pretending to succeed', async () => {
    const created = await request(app)
      .post('/api/employees')
      .set('Authorization', as('hr'))
      .send({ employeeCode: `${PREFIX}-new5`, fullName: 'Untouched' })

    const res = await request(app)
      .patch(`/api/employees/${created.body.data.id}`)
      .set('Authorization', as('hr'))
      .send({})

    expect(res.status).toBe(422)
  })
})

describe('the facts payroll needs about a person', () => {
  const create = (body: Record<string, unknown>) =>
    request(app).post('/api/employees').set('Authorization', as('hr')).send(body)

  const edit = (id: string, body: Record<string, unknown>) =>
    request(app).patch(`/api/employees/${id}`).set('Authorization', as('hr')).send(body)

  it('records gender, the last working day and the PF facts, and returns them', async () => {
    const res = await create({
      employeeCode: `${PREFIX}-newpay1`,
      fullName: 'Payroll Facts',
      dateOfJoining: '2026-04-01',
      lastWorkingDate: '2026-09-10',
      gender: 'female',
      statutory: { ptState: 'Maharashtra', pfApplicable: false, hasPriorPfMembership: true },
    })

    expect(res.status).toBe(201)
    expect(res.body.data.gender).toBe('female')
    expect(res.body.data.last_working_date).toBe('2026-09-10')
    expect(res.body.data.pf_applicable).toBe(false)
    expect(res.body.data.has_prior_pf_membership).toBe(true)

    // And it is what is stored, not merely what was echoed back.
    const stored = await prisma.employee.findUnique({
      where: { id: res.body.data.id },
      include: { statutoryIdentity: true },
    })
    expect(stored?.gender).toBe('female')
    expect(fromDateColumn(stored?.lastWorkingDate)).toBe('2026-09-10')
    expect(stored?.statutoryIdentity?.pfApplicable).toBe(false)
    expect(stored?.statutoryIdentity?.hasPriorPfMembership).toBe(true)
  })

  it('leaves them unrecorded when not given, rather than inventing answers', async () => {
    const res = await create({ employeeCode: `${PREFIX}-newpay2`, fullName: 'Nothing Said' })

    expect(res.status).toBe(201)
    expect(res.body.data.gender).toBeNull()
    expect(res.body.data.last_working_date).toBeNull()
    // No statutory record at all, so nothing to report — null, not a default.
    expect(res.body.data.pf_applicable).toBeNull()
    expect(res.body.data.has_prior_pf_membership).toBeNull()
  })

  it('refuses a last working day before the joining date, and writes nothing', async () => {
    const res = await create({
      employeeCode: `${PREFIX}-newpay3`,
      fullName: 'Backwards',
      dateOfJoining: '2026-09-15',
      lastWorkingDate: '2026-09-01',
    })

    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/cannot be before the joining date/)
    expect(await prisma.employee.count({ where: { employeeCode: `${PREFIX}-newpay3` } })).toBe(0)
  })

  it('refuses a gender it does not know', async () => {
    const res = await create({ employeeCode: `${PREFIX}-newpay4`, fullName: 'Typo', gender: 'femail' })
    expect(res.status).toBe(422)
  })

  it('checks an edited last working day against the STORED joining date', async () => {
    const created = await create({
      employeeCode: `${PREFIX}-newpay5`,
      fullName: 'Leaving Soon',
      dateOfJoining: '2026-06-01',
    })
    const id = created.body.data.id

    // Only one of the two dates is in the body. The other is the stored one.
    const backwards = await edit(id, { lastWorkingDate: '2026-05-31' })
    expect(backwards.status).toBe(400)

    const ok = await edit(id, { lastWorkingDate: '2026-09-30' })
    expect(ok.status).toBe(200)
    expect(ok.body.data.last_working_date).toBe('2026-09-30')

    // Moving the joining date past it is refused the same way.
    const joinLater = await edit(id, { dateOfJoining: '2026-10-01' })
    expect(joinLater.status).toBe(400)

    // A resignation withdrawn: the date comes off again.
    const withdrawn = await edit(id, { lastWorkingDate: null })
    expect(withdrawn.status).toBe(200)
    expect(withdrawn.body.data.last_working_date).toBeNull()
  })

  it('changes one PF fact without disturbing the rest of the statutory record', async () => {
    const created = await create({
      employeeCode: `${PREFIX}-newpay6`,
      fullName: 'Asked Later',
      statutory: { ptState: 'Maharashtra', uan: '100200300400' },
    })
    const id = created.body.data.id
    expect(created.body.data.has_prior_pf_membership).toBeNull()

    // HR finds out, weeks later, that they were a member at their last job.
    const res = await edit(id, { statutory: { hasPriorPfMembership: true } })

    expect(res.status).toBe(200)
    expect(res.body.data.has_prior_pf_membership).toBe(true)
    // Untouched: a partial edit is not a replacement.
    expect(res.body.data.pt_state).toBe('Maharashtra')
    expect(res.body.data.uan).toBe('100200300400')
    expect(res.body.data.pf_applicable).toBe(true)
  })
})

describe('PUT /api/users/:id/role', () => {
  const setRole = (actor: string, membershipId: string, role: string) =>
    request(app)
      .put(`/api/users/${membershipId}/role`)
      .set('Authorization', as(actor))
      .send({ role })

  it('changes a role', async () => {
    const res = await setRole('boss', memberships.mgr!, 'hr')
    expect(res.status).toBe(200)
    expect(res.body.data.role).toBe('hr')

    await setRole('boss', memberships.mgr!, 'manager')
  })

  it('refuses when you are changing your own role', async () => {
    const res = await setRole('boss', memberships.boss!, 'employee')
    expect(res.status).toBe(403)
    expect(res.body.error.message).toMatch(/your own role/i)
  })

  it('refuses to demote the last active super_admin', async () => {
    // Take boss2 out of the count first, leaving exactly one.
    await prisma.membership.update({
      where: { id: memberships.boss2! },
      data: { status: 'inactive' },
    })

    const token = await loginAs('boss')
    const res = await request(app)
      .put(`/api/users/${memberships.boss!}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'hr' })

    expect(res.status).toBe(403)

    await prisma.membership.update({
      where: { id: memberships.boss2! },
      data: { status: 'active' },
    })
  })

  it('ends the affected session, so the change takes effect at once', async () => {
    const token = await loginAs('mgr')

    // Confirm the session works before the change.
    const before = await request(app).get('/api/auth/session').set('Authorization', `Bearer ${token}`)
    expect(before.status).toBe(200)

    await setRole('boss', memberships.mgr!, 'hr')

    // The old access token carries a tokenVersion that has moved on. Without
    // this, a demoted user keeps their old permissions for fifteen minutes.
    const after = await request(app).get('/api/auth/session').set('Authorization', `Bearer ${token}`)
    expect(after.status).toBe(401)

    await setRole('boss', memberships.mgr!, 'manager')
  })

  it('refuses a role change from someone without the permission', async () => {
    await loginAs('hr')
    const res = await setRole('hr', memberships.emp!, 'manager')
    expect(res.status).toBe(403)
  })
})

describe('an employee cannot change their own role by any route', () => {
  it('not through the role endpoint', async () => {
    const token = await loginAs('emp')
    const res = await request(app)
      .put(`/api/users/${memberships.emp!}/role`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'super_admin' })

    // They do not hold membership:role:assign at all.
    expect(res.status).toBe(403)
  })

  it('not through an employee update', async () => {
    const token = await loginAs('emp')
    const res = await request(app)
      .patch(`/api/employees/${memberships.emp!}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ role: 'super_admin' })

    // Refused twice over: no employee:update permission, and the field does
    // not exist in the schema even if they had it.
    expect(res.status).toBe(403)
  })

  it('not by inviting themselves a bigger account', async () => {
    const token = await loginAs('emp')
    const res = await request(app)
      .post('/api/users/invite')
      .set('Authorization', `Bearer ${token}`)
      .send({ email: `${PREFIX}-newself@example.com`, role: 'super_admin' })

    expect(res.status).toBe(403)
  })

  it('and the database still says employee', async () => {
    const membership = await prisma.membership.findUnique({ where: { id: memberships.emp! } })
    expect(membership?.role).toBe('employee')
  })
})

describe('PATCH /api/users/:id/status and DELETE /api/users/:id', () => {
  it('deactivating ends the session immediately', async () => {
    const token = await loginAs('emp')
    expect((await request(app).get('/api/auth/session').set('Authorization', `Bearer ${token}`)).status).toBe(200)

    const res = await request(app)
      .patch(`/api/users/${memberships.emp!}/status`)
      .set('Authorization', as('boss'))
      .send({ status: 'inactive' })

    expect(res.status).toBe(200)
    expect(
      (await request(app).get('/api/auth/session').set('Authorization', `Bearer ${token}`)).status,
    ).toBe(401)

    await request(app)
      .patch(`/api/users/${memberships.emp!}/status`)
      .set('Authorization', as('boss'))
      .send({ status: 'active' })
  })

  it('refuses to deactivate your own account', async () => {
    const res = await request(app)
      .patch(`/api/users/${memberships.boss!}/status`)
      .set('Authorization', as('boss'))
      .send({ status: 'inactive' })

    expect(res.status).toBe(403)
  })

  it('termination revokes access and KEEPS the records', async () => {
    const created = await request(app)
      .post('/api/employees')
      .set('Authorization', as('boss'))
      .send({
        employeeCode: `${PREFIX}-new6`,
        fullName: 'Leaving Soon',
        login: { email: `${PREFIX}-newleaver@example.com`, role: 'employee' },
      })

    const employeeId = created.body.data.id
    const membership = await prisma.membership.findFirst({
      where: { user: { email: `${PREFIX}-newleaver@example.com` } },
    })

    const res = await request(app)
      .delete(`/api/users/${membership!.id}`)
      .set('Authorization', as('boss'))

    expect(res.status).toBe(204)

    // Access is gone.
    const after = await prisma.membership.findUnique({ where: { id: membership!.id } })
    expect(after?.status).toBe('inactive')

    // The record is NOT. Payslips and statutory filings point at this row, and
    // a payslip whose employee has vanished is unusable exactly when somebody
    // needs it — a loan application, a PF claim, an inspection.
    const employee = await prisma.employee.findUnique({ where: { id: employeeId } })
    expect(employee, 'termination must not delete the employee').not.toBeNull()
    expect(employee?.archivedAt).not.toBeNull()

    // And the user row survives too, because payslips reference it.
    const user = await prisma.user.findUnique({ where: { email: `${PREFIX}-newleaver@example.com` } })
    expect(user).not.toBeNull()
  })

  it('refuses to terminate your own account', async () => {
    const res = await request(app)
      .delete(`/api/users/${memberships.boss!}`)
      .set('Authorization', as('boss'))

    expect(res.status).toBe(403)
  })
})
