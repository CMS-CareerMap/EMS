import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { verifyAccessToken } from '../../platform/auth/jwt'

/**
 * Login, driven over real HTTP against the real database.
 *
 * Tested at this level on purpose. The two things most likely to go wrong here
 * are not logic errors inside the service — they are the refresh token leaking
 * into the response body, and a cookie flag being wrong. Neither is visible
 * from a unit test of login(); both are visible here.
 */

const PREFIX = 'authtest'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''

async function cleanup(): Promise<void> {
  await prisma.employee.deleteMany({ where: { employeeCode: { startsWith: PREFIX } } })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()

  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org` } })
  orgId = org.id

  const hash = await hashPassword(PASSWORD)

  // An ordinary working employee with a login.
  const active = await prisma.user.create({
    data: { email: `${PREFIX}-active@example.com`, passwordHash: hash },
  })
  const activeMembership = await prisma.membership.create({
    data: { userId: active.id, organizationId: orgId, role: 'hr', status: 'active' },
  })
  await prisma.employee.create({
    data: {
      organizationId: orgId,
      memberships: { connect: { id: activeMembership.id } },
      employeeCode: `${PREFIX}-EMP1`,
      fullName: 'Active Employee',
    },
  })

  // Someone who has left, or been suspended. Password still correct.
  const inactive = await prisma.user.create({
    data: { email: `${PREFIX}-inactive@example.com`, passwordHash: hash },
  })
  await prisma.membership.create({
    data: { userId: inactive.id, organizationId: orgId, role: 'employee', status: 'inactive' },
  })

  // Invited but never activated: no password hash at all. Day 10's CSV import
  // creates exactly this shape, so it has to be unable to log in.
  const invited = await prisma.user.create({
    data: { email: `${PREFIX}-invited@example.com`, passwordHash: null },
  })
  await prisma.membership.create({
    data: { userId: invited.id, organizationId: orgId, role: 'employee', status: 'invited' },
  })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

function login(identifier: string, password: string) {
  return request(app).post('/api/auth/login').send({ identifier, password })
}

describe('POST /api/auth/login', () => {
  it('logs in with an email address', async () => {
    const res = await login(`${PREFIX}-active@example.com`, PASSWORD)

    expect(res.status).toBe(200)
    expect(res.body.data.accessToken).toEqual(expect.any(String))
    expect(res.body.data.user).toMatchObject({
      email: `${PREFIX}-active@example.com`,
      role: 'hr',
      organizationId: orgId,
    })
    expect(res.body.data.user.employee).toMatchObject({ employeeCode: `${PREFIX}-EMP1` })
  })

  it('logs in with an employee code, without being told which it is', async () => {
    const res = await login(`${PREFIX}-EMP1`, PASSWORD)

    expect(res.status).toBe(200)
    expect(res.body.data.user.email).toBe(`${PREFIX}-active@example.com`)
  })

  it('is case-insensitive about the email', async () => {
    const res = await login(`${PREFIX}-ACTIVE@EXAMPLE.COM`, PASSWORD)
    expect(res.status).toBe(200)
  })

  it('never puts the refresh token in the response body', async () => {
    const res = await login(`${PREFIX}-active@example.com`, PASSWORD)

    // The whole point of httpOnly is defeated if the value is also printed
    // somewhere JavaScript can read it. Check the entire serialised body, not
    // just the field name, so a rename cannot smuggle it back in.
    const body = JSON.stringify(res.body)
    expect(body).not.toContain('refreshToken')

    const cookie = String(res.headers['set-cookie'])
    const tokenValue = /ems_refresh=([^;]+)/.exec(cookie)?.[1]
    expect(tokenValue).toBeTruthy()
    expect(body).not.toContain(tokenValue)
  })

  it('sets the refresh cookie with every protective flag', async () => {
    const res = await login(`${PREFIX}-active@example.com`, PASSWORD)
    const cookie = String(res.headers['set-cookie'])

    expect(cookie).toMatch(/ems_refresh=/)
    expect(cookie).toMatch(/HttpOnly/i)
    expect(cookie).toMatch(/SameSite=Lax/i)
    expect(cookie).toMatch(/Path=\/api\/auth/i)
    // Max-Age comes from the token's own exp, so it must be present and sane.
    const maxAge = Number(/Max-Age=(\d+)/i.exec(cookie)?.[1])
    expect(maxAge).toBeGreaterThan(60 * 60 * 24 * 6)
  })

  it('mints an access token carrying the organization, role and token version', async () => {
    const res = await login(`${PREFIX}-active@example.com`, PASSWORD)
    const claims = verifyAccessToken(res.body.data.accessToken)

    expect(claims.org).toBe(orgId)
    expect(claims.role).toBe('hr')
    expect(claims.ver).toBe(0)
    expect(claims.mem).toEqual(expect.any(String))
  })

  it('rejects a wrong password', async () => {
    const res = await login(`${PREFIX}-active@example.com`, 'WrongPassword123')
    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('gives an unknown user the SAME message as a wrong password', async () => {
    const wrongPassword = await login(`${PREFIX}-active@example.com`, 'WrongPassword123')
    const noSuchUser = await login(`${PREFIX}-nobody@example.com`, 'WrongPassword123')

    // If these differ, anyone can check whether an address has an account here
    // by reading the error. That is a list of your staff, for free.
    expect(noSuchUser.status).toBe(wrongPassword.status)
    expect(noSuchUser.body.error.message).toBe(wrongPassword.body.error.message)
    expect(noSuchUser.body.error.code).toBe(wrongPassword.body.error.code)
  })

  it('blocks an inactive account even with the correct password', async () => {
    const res = await login(`${PREFIX}-inactive@example.com`, PASSWORD)

    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
    // Specific here is safe: they proved they own the account by getting the
    // password right, so this tells an attacker nothing they did not have.
    expect(res.body.error.message).toMatch(/not active/i)
  })

  it('blocks an invited user who has no password yet', async () => {
    const res = await login(`${PREFIX}-invited@example.com`, PASSWORD)

    expect(res.status).toBe(401)
    expect(res.headers['set-cookie']).toBeUndefined()
  })

  it('rejects an empty identifier with 422, not 401', async () => {
    const res = await login('', PASSWORD)

    expect(res.status).toBe(422)
    expect(res.body.error.code).toBe('VALIDATION_FAILED')
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'identifier' })]),
    )
  })

  it('rejects a body that is missing the password', async () => {
    const res = await request(app).post('/api/auth/login').send({ identifier: 'someone' })
    expect(res.status).toBe(422)
  })
})
