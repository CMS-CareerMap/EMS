import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { generateToken, hashInviteToken } from '../../platform/auth/tokenHash'

/**
 * Invitation and reset links, end to end.
 *
 * Before this file existed, every invitation the system created was a dead end:
 * the link was issued and nothing accepted it, so nobody but the bootstrap
 * administrator could ever sign in. These tests walk the whole path — invite,
 * accept, sign in — and every way a link must refuse to work.
 */

const PREFIX = 'invtest'
const PASSWORD = 'CorrectHorseBattery1'
const NEW_PASSWORD = 'AnotherLongPassword9'
const DEAD = /invalid or has expired/

const app = createApp()

let orgId = ''
let otherOrgId = ''
let bossMembershipId = ''
let bossToken = ''
let seq = 0

async function cleanup(): Promise<void> {
  const users = { user: { email: { startsWith: PREFIX } } }
  await prisma.employee.deleteMany({ where: { organization: { name: { startsWith: PREFIX } } } })
  await prisma.passwordResetToken.deleteMany({ where: users })
  await prisma.refreshToken.deleteMany({ where: users })
  await prisma.membership.deleteMany({ where: users })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

const boss = () => `Bearer ${bossToken}`

const login = (email: string, password: string) =>
  request(app).post('/api/auth/login').send({ identifier: email, password })

const inspect = (token: string) =>
  request(app).post('/api/auth/password-link/inspect').send({ token })

const redeem = (token: string, password = NEW_PASSWORD) =>
  request(app).post('/api/auth/password-link/redeem').send({ token, password })

/** Invites somebody through the real endpoint and returns what HR would see. */
async function invite(role: 'employee' | 'hr' = 'employee') {
  seq += 1
  const email = `${PREFIX}-p${seq}@example.com`
  const res = await request(app)
    .post('/api/users/invite')
    .set('Authorization', boss())
    .send({ email, role })

  expect(res.status, JSON.stringify(res.body)).toBe(201)
  return { email, membershipId: res.body.data.user.id as string, token: res.body.data.invite.token as string }
}

beforeAll(async () => {
  await cleanup()

  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org` } })).id
  otherOrgId = (await prisma.organization.create({ data: { name: `${PREFIX}-other` } })).id

  const email = `${PREFIX}-boss@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  bossMembershipId = (
    await prisma.membership.create({
      data: { userId: user.id, organizationId: orgId, role: 'super_admin', status: 'active' },
    })
  ).id
  bossToken = (await login(email, PASSWORD)).body.data.accessToken
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('accepting an invitation', () => {
  it('turns an invitation into an account that can sign in', async () => {
    const person = await invite()

    // The state every invited person was stuck in. No password exists yet, so
    // nothing matches — and the answer is the ordinary one, which tells a
    // stranger nothing about whether this address was ever invited.
    const before = await login(person.email, NEW_PASSWORD)
    expect(before.status).toBe(401)
    expect(before.body.error.message).toMatch(/Incorrect email or password/)

    // The page asks what the link is for before anybody types a password.
    const seen = await inspect(person.token)
    expect(seen.status).toBe(200)
    expect(seen.body.data).toMatchObject({ email: person.email, purpose: 'invite' })

    const accepted = await redeem(person.token)
    expect(accepted.status).toBe(200)
    expect(accepted.body.data.email).toBe(person.email)

    const after = await login(person.email, NEW_PASSWORD)
    expect(after.status).toBe(200)
    expect(after.body.data.accessToken).toBeTruthy()

    const membership = await prisma.membership.findUnique({ where: { id: person.membershipId } })
    expect(membership?.status).toBe('active')
  })

  it('refuses a weak password WITHOUT spending the link', async () => {
    const person = await invite()

    const weak = await redeem(person.token, 'short')
    expect(weak.status).toBe(422)

    // One typo must not cost somebody their invitation.
    expect((await inspect(person.token)).status).toBe(200)
    expect((await redeem(person.token)).status).toBe(200)
  })

  it('works once, and only once', async () => {
    const person = await invite()
    expect((await redeem(person.token)).status).toBe(200)

    // A forwarded invitation must not work a second time.
    const again = await redeem(person.token, 'SomebodyElsesPassword1')
    expect(again.status).toBe(400)
    expect(again.body.error.message).toMatch(DEAD)

    // And the password is still the one the rightful person chose.
    expect((await login(person.email, NEW_PASSWORD)).status).toBe(200)
  })
})

describe('links that must not work', () => {
  it('answers an unknown, an expired and a spent link identically', async () => {
    // Telling them apart would confirm to whoever holds a link that it was real.
    const unknown = await inspect(generateToken())

    const person = await invite()
    await prisma.passwordResetToken.updateMany({
      where: { tokenHash: hashInviteToken(person.token) },
      data: { expiresAt: new Date(Date.now() - 1000) },
    })
    const expired = await inspect(person.token)

    const spentPerson = await invite()
    await redeem(spentPerson.token)
    const spent = await inspect(spentPerson.token)

    for (const res of [unknown, expired, spent]) {
      expect(res.status).toBe(400)
      expect(res.body.error.message).toMatch(DEAD)
    }
    expect(expired.body.error.message).toBe(unknown.body.error.message)
    expect(spent.body.error.message).toBe(unknown.body.error.message)
  })

  it('does not reactivate an account that was deactivated after being invited', async () => {
    const person = await invite()

    const off = await request(app)
      .patch(`/api/users/${person.membershipId}/status`)
      .set('Authorization', boss())
      .send({ status: 'inactive' })
    expect(off.status).toBe(200)

    // Accepting the old invitation must not quietly undo that decision.
    expect((await redeem(person.token)).status).toBe(400)
    const membership = await prisma.membership.findUnique({ where: { id: person.membershipId } })
    expect(membership?.status).toBe('inactive')
  })

  it('rejects a body with anything extra in it', async () => {
    const person = await invite()
    const res = await request(app)
      .post('/api/auth/password-link/redeem')
      .send({ token: person.token, password: NEW_PASSWORD, role: 'super_admin' })
    expect(res.status).toBe(422)
  })
})

describe('issuing a new link', () => {
  const issue = (membershipId: string, auth = boss()) =>
    request(app).post(`/api/users/${membershipId}/password-link`).set('Authorization', auth)

  it('replaces a lost invitation, and the old link stops working', async () => {
    const person = await invite()

    const res = await issue(person.membershipId)
    expect(res.status).toBe(201)
    expect(res.body.data.invite.purpose).toBe('invite')
    const fresh = res.body.data.invite.token as string

    // One live link per person: the one that was "lost" is dead.
    expect((await inspect(person.token)).status).toBe(400)
    expect((await redeem(fresh)).status).toBe(200)
    expect((await login(person.email, NEW_PASSWORD)).status).toBe(200)
  })

  it('resets a forgotten password, and signs out the old sessions when used', async () => {
    const person = await invite()
    await redeem(person.token, PASSWORD)

    // They are signed in somewhere, then forget the password.
    const session = await login(person.email, PASSWORD)
    const cookie = String(session.headers['set-cookie'])

    const res = await issue(person.membershipId)
    expect(res.status).toBe(201)
    expect(res.body.data.invite.purpose).toBe('reset')

    // Issuing alone signs nobody out — only using the link does.
    const stillIn = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', cookie)
      .set('X-Requested-With', 'ems')
      .set('Content-Type', 'application/json')
      .send({})
    expect(stillIn.status).toBe(200)

    const reset = await redeem(res.body.data.invite.token, NEW_PASSWORD)
    expect(reset.status).toBe(200)
    expect(reset.body.data.purpose).toBe('reset')
    // The security notice goes out for a reset as for a change — never for a first password.
    const notices = await prisma.notification.findMany({ where: { user: { email: person.email }, event: 'account.password_changed' } })
    expect(notices).toHaveLength(1)
    expect(notices[0]?.message).toMatch(/reset with a link from your administrator/)

    expect((await login(person.email, PASSWORD)).status).toBe(401)
    expect((await login(person.email, NEW_PASSWORD)).status).toBe(200)

    // The session from before the reset is over.
    const refreshed = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', String(stillIn.headers['set-cookie'] ?? cookie))
      .set('X-Requested-With', 'ems')
      .set('Content-Type', 'application/json')
      .send({})
    expect(refreshed.status).toBe(401)
  })

  it('refuses your own account — that is what Change password is for', async () => {
    const res = await issue(bossMembershipId)
    expect(res.status).toBe(400)
  })

  it('refuses a deactivated account', async () => {
    const person = await invite()
    await request(app)
      .patch(`/api/users/${person.membershipId}/status`)
      .set('Authorization', boss())
      .send({ status: 'inactive' })

    expect((await issue(person.membershipId)).status).toBe(409)
  })

  it('cannot reach an account in another company', async () => {
    const user = await prisma.user.create({ data: { email: `${PREFIX}-foreign@example.com` } })
    const foreign = await prisma.membership.create({
      data: { userId: user.id, organizationId: otherOrgId, role: 'employee', status: 'invited' },
    })

    expect((await issue(foreign.id)).status).toBe(404)
    expect(await prisma.passwordResetToken.count({ where: { userId: user.id } })).toBe(0)
  })

  it('is refused to anybody without user management', async () => {
    const person = await invite()
    await redeem(person.token)
    const employeeToken = (await login(person.email, NEW_PASSWORD)).body.data.accessToken

    const other = await invite()
    expect((await issue(other.membershipId, `Bearer ${employeeToken}`)).status).toBe(403)
  })
})
