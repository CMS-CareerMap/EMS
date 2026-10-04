import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../db/prisma'
import { hashPassword } from '../auth/password'
import { toDateColumn, zonedToday, addCalendarDays } from '../../domain/shared/dates'
import { sendWaitingEmails } from './outbox'

/**
 * Email (client §45), with a mail account "set up": notices queue an email in
 * their own transaction, each event can be kept to the app, and the sender
 * delivers, retries and gives up. The mail server is a stand-in that refuses
 * any address with "bounce" in it.
 */

const { delivered } = vi.hoisted(() => ({ delivered: [] as { to: string; subject: string; text: string }[] }))

vi.mock('./mailer', async (original) => ({
  ...(await original<typeof import('./mailer')>()),
  emailReady: () => true,
  emailFrom: () => 'CareerMap HR <hr@example.com>',
  sendMail: async (message: { to: string; subject: string; text: string }) => {
    if (message.to.includes('bounce')) throw new Error('550 mailbox unavailable')
    delivered.push(message)
  },
}))

const PREFIX = 'mailtest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()
type Who = 'boss' | 'mgr' | 'emp' | 'bounce'
let orgId = ''
const tokens = {} as Record<Who, string>
const email = (who: string) => `${PREFIX}-${who}@example.com`
const today = zonedToday(new Date(), 'Asia/Kolkata')

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.emailOutbox.deleteMany({ where: org })
  await prisma.notificationSetting.deleteMany({ where: org })
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employeeRequest.deleteMany({ where: org })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } })
  await prisma.membership.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  const ids = {} as Record<Who, string>
  for (const [who, role] of [['boss', 'super_admin'], ['mgr', 'manager'], ['emp', 'employee'], ['bounce', 'employee']] as const) {
    const user = await prisma.user.create({ data: { email: email(who), passwordHash: await hashPassword(PASSWORD) } })
    ids[who] = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: `${PREFIX}-${who}`, fullName: `${who} Person`, dateOfJoining: toDateColumn('2024-01-08') },
    })).id
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active', employeeId: ids[who] } })
  }
  await prisma.employee.update({ where: { id: ids.mgr }, data: { reportingManagerId: ids.boss } })
  await prisma.employee.update({ where: { id: ids.emp }, data: { reportingManagerId: ids.mgr } })
  await prisma.employee.update({ where: { id: ids.bounce }, data: { reportingManagerId: ids.emp } })
  for (const who of ['boss', 'mgr', 'emp', 'bounce'] as const) {
    tokens[who] = (await request(app).post('/api/auth/login').send({ identifier: email(who), password: PASSWORD })).body.data.accessToken
  }
}, 120_000)

afterAll(cleanup)

const ask = (who: Who, days: number) =>
  request(app).post('/api/requests').set('Authorization', `Bearer ${tokens[who]}`)
    .send({ type: 'work_from_home', fromDate: addCalendarDays(today, days), toDate: addCalendarDays(today, days), reason: 'Plumber at home' })
const outbox = () => prisma.emailOutbox.findMany({ where: { organizationId: orgId }, orderBy: { createdAt: 'asc' } })

describe('email (client §45)', () => {
  it('says it is set up, and as whom', async () => {
    const res = await request(app).get('/api/notifications/email-status').set('Authorization', `Bearer ${tokens.boss}`)
    expect(res.body.data).toEqual({ ready: true, from: 'CareerMap HR <hr@example.com>' })
  })

  it('is queued with the notice, to the sign-in email of whoever is told', async () => {
    expect((await ask('emp', 3)).status).toBe(201)
    const queued = await outbox()
    expect(queued).toHaveLength(1)
    expect(queued[0]).toMatchObject({ toEmail: email('mgr'), subject: 'Work from home to decide', status: 'pending' })
    expect(queued[0]!.body).toMatch(/emp Person asks: to work from home/)
    expect(queued[0]!.body).toMatch(/Open it: http.*\/requests\?tab=decide/)
  })

  it('is not sent for an event the company keeps to the app', async () => {
    const off = await request(app).put('/api/notifications/settings').set('Authorization', `Bearer ${tokens.boss}`)
      .send({ changes: [{ event: 'request.submitted', enabled: true, email: false }] })
    expect(off.status).toBe(200)
    expect(off.body.data.find((s: { event: string }) => s.event === 'request.submitted')).toMatchObject({ enabled: true, email: false })
    expect((await ask('emp', 4)).status).toBe(201)
    expect(await outbox()).toHaveLength(1)
    // The notice in the app still went.
    expect(await prisma.notification.count({ where: { organizationId: orgId, title: 'Work from home to decide' } })).toBe(2)
    await request(app).put('/api/notifications/settings').set('Authorization', `Bearer ${tokens.boss}`)
      .send({ changes: [{ event: 'request.submitted', enabled: true, email: true }] })
  })

  it('goes out after the change commits; a refused address is tried again, then given up', async () => {
    // bounce reports to emp: emp is told of bounce's request; then bounce is told of the decision.
    const sent = await ask('bounce', 5)
    expect(sent.status).toBe(201)
    const decided = await request(app).post(`/api/requests/${sent.body.data.id}/reject`).set('Authorization', `Bearer ${tokens.emp}`).send({ note: 'Not this week' })
    expect(decided.status).toBe(200)

    const first = await sendWaitingEmails()
    expect(first).toEqual({ sent: 2, failed: 1 })
    expect(delivered.map((m) => m.to).sort()).toEqual([email('emp'), email('mgr')])
    for (let i = 0; i < 4; i++) await sendWaitingEmails()
    const bounced = (await outbox()).find((m) => m.toEmail === email('bounce'))
    expect(bounced).toMatchObject({ status: 'failed', attempts: 5, lastError: '550 mailbox unavailable' })
    expect((await outbox()).filter((m) => m.status === 'sent')).toHaveLength(2)
  })
})
