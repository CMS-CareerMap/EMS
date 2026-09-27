import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { hashInviteToken } from '../../platform/auth/tokenHash'
import { issueRecoveryLink, RECOVERY_LINK_MINUTES } from './recovery.service'

/**
 * `npm run reset-link`: the way back in when nobody can sign in to issue a
 * link. What matters is that the link it prints really works — and does
 * nothing a deactivated account or a stale link could take advantage of.
 */

const PREFIX = 'recovertest'
const OLD_PASSWORD = 'ForgottenPassword1'
const NEW_PASSWORD = 'RememberedPassword2'
const WEB = 'http://localhost:5173'
const app = createApp()
let orgId = ''

const tokenOf = (link: string) => decodeURIComponent(link.split('#token=')[1]!)

async function account(key: string, role: 'super_admin' | 'employee', status: 'active' | 'invited' | 'inactive') {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: status === 'invited' ? null : await hashPassword(OLD_PASSWORD) },
  })
  await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status } })
  return { email, userId: user.id }
}

async function cleanup() {
  await prisma.membership.deleteMany({ where: { organization: { name: { startsWith: PREFIX } } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org` } })).id
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('a recovery link from the terminal', () => {
  it('lets a locked-out Super Admin choose a new password and sign in', async () => {
    const boss = await account('boss', 'super_admin', 'active')

    const result = await issueRecoveryLink(boss.email.toUpperCase(), { webOrigin: WEB })
    expect(result).toMatchObject({ email: boss.email, role: 'super_admin', purpose: 'reset' })
    expect(result.link.startsWith(`${WEB}/set-password#token=`)).toBe(true)

    const redeemed = await request(app)
      .post('/api/auth/password-link/redeem')
      .send({ token: tokenOf(result.link), password: NEW_PASSWORD })
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(200)

    const signIn = (password: string) => request(app).post('/api/auth/login').send({ identifier: boss.email, password })
    expect((await signIn(NEW_PASSWORD)).status).toBe(200)
    expect((await signIn(OLD_PASSWORD)).status).toBe(401)
  })

  it('stores only a hash, lasts an hour, and is on record as issued from the terminal', async () => {
    const who = await account('hashed', 'employee', 'active')
    const now = new Date('2026-09-27T10:00:00Z')

    const result = await issueRecoveryLink(who.email, { webOrigin: WEB, now })

    const stored = await prisma.passwordResetToken.findFirstOrThrow({ where: { userId: who.userId, usedAt: null } })
    expect(stored.tokenHash).toBe(hashInviteToken(tokenOf(result.link)))
    expect(stored.tokenHash).not.toContain(tokenOf(result.link))
    expect(stored.createdByUserId).toBeNull()
    expect(stored.expiresAt.getTime() - now.getTime()).toBe(RECOVERY_LINK_MINUTES * 60 * 1000)

    const audit = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'user.password_link_issued', details: { path: ['email'], equals: who.email } } })
    expect(audit).toMatchObject({ actorUserId: null, details: { purpose: 'reset', via: 'terminal', email: who.email } })
  })

  it('sends an invitation never accepted as an invitation again', async () => {
    const newcomer = await account('newcomer', 'employee', 'invited')
    expect((await issueRecoveryLink(newcomer.email, { webOrigin: WEB })).purpose).toBe('invite')
  })

  it('kills the link before it — only the newest works', async () => {
    const who = await account('twice', 'employee', 'active')
    const first = await issueRecoveryLink(who.email, { webOrigin: WEB })
    await issueRecoveryLink(who.email, { webOrigin: WEB })

    const res = await request(app)
      .post('/api/auth/password-link/redeem')
      .send({ token: tokenOf(first.link), password: NEW_PASSWORD })
    expect(res.status).toBe(400)
  })

  it('refuses an address nobody uses, and a deactivated account, writing nothing', async () => {
    const gone = await account('gone', 'employee', 'inactive')

    await expect(issueRecoveryLink(`${PREFIX}-nobody@example.com`, { webOrigin: WEB })).rejects.toThrow(/No account uses/)
    await expect(issueRecoveryLink(gone.email, { webOrigin: WEB })).rejects.toThrow(/deactivated/)
    expect(await prisma.passwordResetToken.count({ where: { userId: gone.userId } })).toBe(0)
  })
})
