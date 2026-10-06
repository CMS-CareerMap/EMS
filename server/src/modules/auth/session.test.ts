import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import type { Response } from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { verifyAccessToken } from '../../platform/auth/jwt'

/**
 * Sessions: rotation, reuse detection, logout, and change-password.
 *
 * The centrepiece is the reuse test. Everything else here is plumbing that
 * would be noticed quickly if it broke; a refresh token that can be spent twice
 * would not be noticed at all, because the system keeps working perfectly for
 * both the user and whoever copied their token.
 */

const PREFIX = 'sesstest'
const PASSWORD = 'CorrectHorseBattery1'
const EMAIL = `${PREFIX}-user@example.com`

const app = createApp()

let userId = ''

async function cleanup(): Promise<void> {
  await prisma.employee.deleteMany({ where: { employeeCode: { startsWith: PREFIX } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()
  // Written for people who set their own passwords, from links (Settings →
  // Passwords, "self"); the company-set default is tested in user/passwords.test.ts.
  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org`, employeePasswords: 'self', rolePasswords: 'self' } })
  const user = await prisma.user.create({
    data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD) },
  })
  userId = user.id
  await prisma.membership.create({
    data: { userId: user.id, organizationId: org.id, role: 'hr', status: 'active' },
  })
})

beforeEach(async () => {
  // Each test starts from a clean session history and a known token version,
  // so a reuse incident in one case cannot cascade into the next.
  await prisma.refreshToken.deleteMany({ where: { userId } })
  await prisma.user.update({ where: { id: userId }, data: { tokenVersion: 0 } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

/** The `name=value` pair, which is what a browser would send back. */
function refreshCookie(res: Response): string {
  const raw = res.headers['set-cookie'] as unknown as string[] | string | undefined
  const all = Array.isArray(raw) ? raw : raw ? [raw] : []
  const found = all.find((c) => c.startsWith('ems_refresh='))
  return found?.split(';')[0] ?? ''
}

function login() {
  return request(app).post('/api/auth/login').send({ identifier: EMAIL, password: PASSWORD })
}

/** A refresh as our own frontend would send it: cookie, custom header, JSON. */
function refresh(cookie: string) {
  return request(app)
    .post('/api/auth/refresh')
    .set('Cookie', cookie)
    .set('X-Requested-With', 'ems')
    .send({})
}

describe('POST /api/auth/refresh', () => {
  it('returns a new access token and a different refresh token', async () => {
    const first = await login()
    const cookieA = refreshCookie(first)

    const second = await refresh(cookieA)
    const cookieB = refreshCookie(second)

    expect(second.status).toBe(200)
    expect(second.body.data.accessToken).toEqual(expect.any(String))
    // Rotation means a NEW token every time. Handing the same one back would
    // leave nothing to detect reuse with.
    expect(cookieB).not.toBe(cookieA)
    expect(cookieB).toMatch(/^ems_refresh=/)
  })

  it('never puts the refresh token in the response body', async () => {
    const first = await login()
    const res = await refresh(refreshCookie(first))

    const body = JSON.stringify(res.body)
    const token = refreshCookie(res).replace('ems_refresh=', '')
    expect(body).not.toContain(token)
  })

  it('rebuilds the access token from current data, not from the old one', async () => {
    const first = await login()
    expect(verifyAccessToken(first.body.data.accessToken).role).toBe('hr')

    // Demote the user between the two calls.
    await prisma.membership.updateMany({ where: { userId }, data: { role: 'employee' } })

    const second = await refresh(refreshCookie(first))
    expect(verifyAccessToken(second.body.data.accessToken).role).toBe('employee')

    await prisma.membership.updateMany({ where: { userId }, data: { role: 'hr' } })
  })

  it('refuses a request with no cookie', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('X-Requested-With', 'ems')
      .send({})

    expect(res.status).toBe(401)
  })

  it('refuses a request without the custom header', async () => {
    const first = await login()

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie(first))
      .send({})

    // 403, not 401 — the cookie was fine; the request shape was not.
    expect(res.status).toBe(403)
  })

  it('refuses a form-encoded request, which is how a cross-site POST arrives', async () => {
    const first = await login()

    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', refreshCookie(first))
      .set('X-Requested-With', 'ems')
      .type('form')
      .send('x=1')

    expect(res.status).toBe(403)
  })
})

describe('refresh token reuse', () => {
  it('kills the whole family and every access token when a spent token comes back', async () => {
    // The scenario: someone copies the cookie, the real user refreshes as
    // normal, and then the copy is used.
    const first = await login()
    const stolen = refreshCookie(first)

    const rotated = await refresh(stolen)
    expect(rotated.status).toBe(200)
    const legitimate = refreshCookie(rotated)

    // The thief presents the token that has already been spent.
    const reused = await refresh(stolen)
    expect(reused.status).toBe(401)

    // Every token from that login is now dead — including the one the real
    // user is holding, which is the price of not knowing which party is which.
    const live = await prisma.refreshToken.count({ where: { userId, revokedAt: null } })
    expect(live).toBe(0)

    const stillGood = await refresh(legitimate)
    expect(stillGood.status).toBe(401)

    // And tokenVersion has moved, so access tokens already in browsers die at
    // their next request rather than lasting out their fifteen minutes.
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } })
    expect(user.tokenVersion).toBeGreaterThan(0)
  })

  it('records the rotation chain so the incident can be read afterwards', async () => {
    const first = await login()
    await refresh(refreshCookie(first))

    const tokens = await prisma.refreshToken.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    })

    expect(tokens).toHaveLength(2)
    expect(tokens[0]!.familyId).toBe(tokens[1]!.familyId)
    expect(tokens[0]!.replacedById).toBe(tokens[1]!.id)
    expect(tokens[0]!.revokedAt).not.toBeNull()
    expect(tokens[1]!.revokedAt).toBeNull()
  })

  it('starts a fresh family on each login, so one does not poison another', async () => {
    const a = await login()
    const b = await login()

    const tokens = await prisma.refreshToken.findMany({ where: { userId } })
    const families = new Set(tokens.map((t) => t.familyId))
    expect(families.size).toBe(2)

    // Burn family A completely.
    const stolen = refreshCookie(a)
    await refresh(stolen)
    await refresh(stolen)

    // B is a separate login on a separate device and must be untouched.
    const other = await refresh(refreshCookie(b))
    expect(other.status).toBe(200)
  })
})

describe('POST /api/auth/logout', () => {
  function logout(cookie?: string) {
    const req = request(app).post('/api/auth/logout').set('X-Requested-With', 'ems')
    if (cookie) req.set('Cookie', cookie)
    return req.send({})
  }

  it('revokes the token and clears the cookie', async () => {
    const first = await login()
    const cookie = refreshCookie(first)

    const res = await logout(cookie)
    expect(res.status).toBe(204)

    const live = await prisma.refreshToken.count({ where: { userId, revokedAt: null } })
    expect(live).toBe(0)

    const after = await refresh(cookie)
    expect(after.status).toBe(401)
  })

  it('succeeds even with no cookie at all', async () => {
    const res = await logout()
    expect(res.status).toBe(204)
  })
})

describe('GET /api/auth/session', () => {
  function session(accessToken?: string) {
    const req = request(app).get('/api/auth/session')
    if (accessToken) req.set('Authorization', `Bearer ${accessToken}`)
    return req
  }

  it('returns the current user', async () => {
    const first = await login()
    const res = await session(first.body.data.accessToken)

    expect(res.status).toBe(200)
    expect(res.body.data.user).toMatchObject({ email: EMAIL, role: 'hr' })
  })

  it('never leaks the password hash', async () => {
    const first = await login()
    const res = await session(first.body.data.accessToken)

    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/)
  })

  it('refuses a request with no token', async () => {
    const res = await session()
    expect(res.status).toBe(401)
  })

  it('refuses a garbage token', async () => {
    const res = await session('not.a.token')
    expect(res.status).toBe(401)
  })

  it('refuses a valid token once tokenVersion has moved on', async () => {
    const first = await login()
    const token = first.body.data.accessToken

    expect((await session(token)).status).toBe(200)

    // What happens on termination, password change, or reuse detection.
    await prisma.user.update({ where: { id: userId }, data: { tokenVersion: { increment: 1 } } })

    // Still cryptographically valid, still inside its fifteen minutes, dead.
    expect((await session(token)).status).toBe(401)
  })
})

describe('POST /api/auth/change-password', () => {
  const NEW_PASSWORD = 'AnotherLongEnoughOne2'

  function change(accessToken: string, currentPassword: string, newPassword: string) {
    return request(app)
      .post('/api/auth/change-password')
      .set('Authorization', `Bearer ${accessToken}`)
      .send({ currentPassword, newPassword })
  }

  it('refuses when the current password is wrong', async () => {
    const first = await login()
    const res = await change(first.body.data.accessToken, 'NotMyPassword9', NEW_PASSWORD)

    expect(res.status).toBe(401)
  })

  it('refuses a new password that is too short', async () => {
    const first = await login()
    const res = await change(first.body.data.accessToken, PASSWORD, 'short')

    expect(res.status).toBe(422)
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'newPassword' })]),
    )
  })

  it('refuses reusing the current password', async () => {
    const first = await login()
    const res = await change(first.body.data.accessToken, PASSWORD, PASSWORD)

    expect(res.status).toBe(422)
  })

  it('changes it, ends every other session, and keeps this one signed in', async () => {
    // Two devices signed in.
    const deviceA = await login()
    const deviceB = await login()

    const res = await change(deviceA.body.data.accessToken, PASSWORD, NEW_PASSWORD)
    expect(res.status).toBe(200)

    // The caller is handed a working session immediately.
    expect(res.body.data.accessToken).toEqual(expect.any(String))
    const stillHere = await request(app)
      .get('/api/auth/session')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`)
    expect(stillHere.status).toBe(200)

    // The other device is out — both its refresh token and its access token.
    expect((await refresh(refreshCookie(deviceB))).status).toBe(401)
    const oldAccess = await request(app)
      .get('/api/auth/session')
      .set('Authorization', `Bearer ${deviceB.body.data.accessToken}`)
    expect(oldAccess.status).toBe(401)

    // The new password works and the old one does not.
    const withNew = await request(app)
      .post('/api/auth/login')
      .send({ identifier: EMAIL, password: NEW_PASSWORD })
    expect(withNew.status).toBe(200)

    const withOld = await request(app)
      .post('/api/auth/login')
      .send({ identifier: EMAIL, password: PASSWORD })
    expect(withOld.status).toBe(401)

    // Put it back for whatever runs next.
    await prisma.user.update({
      where: { id: userId },
      data: { passwordHash: await hashPassword(PASSWORD) },
    })
  })

  it('refuses without an access token', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .send({ currentPassword: PASSWORD, newPassword: NEW_PASSWORD })

    expect(res.status).toBe(401)
  })
})
