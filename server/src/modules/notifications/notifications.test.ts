import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { forOrg } from '../../platform/db/scoped'
import { sweepOldNotices } from './notification.service'

/**
 * Day 19: the bell. Notices are written by the server inside the change they
 * report, sent to whoever holds the right to act (never a hard-coded id), and
 * each person reads, marks and clears only their own.
 */

const PREFIX = 'notetest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()
const day = (d: string) => new Date(`${d}T00:00:00Z`)

type Who = 'super_admin' | 'hr' | 'manager' | 'other_manager' | 'accounts' | 'asha' | 'ravi'
const ROLE = {
  super_admin: 'super_admin', hr: 'hr', manager: 'manager', other_manager: 'manager', accounts: 'accounts', asha: 'employee', ravi: 'employee',
} as const

let orgId = ''
let leaveTypeId = ''
const token = {} as Record<Who, string>
const userId = {} as Record<Who, string>
const employeeId = {} as Record<Who, string>

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.notificationSetting.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.refreshToken.deleteMany({ where: { user: { email: { startsWith: PREFIX } } } }).catch(() => undefined)
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

const as = (who: Who) => `Bearer ${token[who]}`
const get = (who: Who, url: string) => request(app).get(url).set('Authorization', as(who))
const post = (who: Who, url: string, body: object = {}) => request(app).post(url).set('Authorization', as(who)).send(body)
const put = (who: Who, url: string, body: object) => request(app).put(url).set('Authorization', as(who)).send(body)

const noticesOf = (who: Who, event?: string) =>
  prisma.notification.findMany({ where: { organizationId: orgId, userId: userId[who], ...(event ? { event } : {}) }, orderBy: { createdAt: 'desc' } })

async function apply(who: Who, from: string, to: string) {
  const res = await post(who, '/api/leave-requests', { leaveTypeId, fromDate: from, toDate: to, reason: 'Family function' })
  expect(res.status).toBe(201)
  return res.body.data.id as string
}

beforeAll(async () => {
  await cleanup()
  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })
  orgId = org.id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: day('2020-04-01') } })
  leaveTypeId = (await prisma.leaveType.create({ data: { organizationId: orgId, code: 'CL', name: 'Casual Leave', annualQuota: 12 } })).id

  for (const who of Object.keys(ROLE) as Who[]) {
    const email = `${PREFIX}-${who}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    const m = await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: ROLE[who], status: 'active' } })
    userId[who] = user.id
    const e = await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: `NT-${who}`, fullName: who === 'asha' ? 'Asha Kulkarni' : `Person ${who}`, dateOfJoining: day('2024-01-01'), membershipId: m.id },
    })
    employeeId[who] = e.id
  }
  // Asha reports to the manager; the other manager has nothing to do with her.
  await prisma.employee.update({ where: { id: employeeId.asha }, data: { reportingManagerId: employeeId.manager } })
  await prisma.employee.update({ where: { id: employeeId.ravi }, data: { reportingManagerId: employeeId.other_manager } })
  for (const who of ['asha', 'ravi'] as const) {
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: employeeId[who], leaveTypeId, leaveYear: 2026, days: 12, reason: 'opening_grant' } })
  }

  for (const who of Object.keys(ROLE) as Who[]) {
    const res = await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-${who}@example.com`, password: PASSWORD })
    token[who] = res.body.data.accessToken
  }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('leave notices', () => {
  let requestId = ''

  it('go to the person who decides — the reporting manager in the company tree — and not to anybody else (Day 22)', async () => {
    requestId = await apply('asha', '2026-10-12', '2026-10-13')

    const [notice] = await noticesOf('manager', 'leave.submitted')
    expect(notice).toMatchObject({ kind: 'leave', title: 'Leave request to approve', link: '/leave?tab=decide', entityId: requestId })
    expect(notice?.message).toBe('Asha Kulkarni asked for 2 days of Casual Leave: 12 Oct 2026 to 13 Oct 2026.')
    // HR sees every request but decides none; the Super Admin only stands in.
    for (const who of ['hr', 'super_admin', 'other_manager', 'accounts', 'ravi', 'asha'] as const) {
      expect(await noticesOf(who, 'leave.submitted')).toHaveLength(0)
    }
  })

  it('tell the employee what was decided, and not the person who decided it', async () => {
    expect((await post('manager', `/api/leave-requests/${requestId}/approve`, { note: 'Enjoy' })).status).toBe(200)
    const [notice] = await noticesOf('asha', 'leave.decided')
    expect(notice).toMatchObject({ title: 'Leave approved', message: 'Your Casual Leave for 12 Oct 2026 to 13 Oct 2026 was approved: Enjoy.' })
    expect(await noticesOf('manager', 'leave.decided')).toHaveLength(0)

    expect((await post('super_admin', `/api/leave-requests/${requestId}/reverse`, { note: 'Office closed anyway' })).status).toBe(200)
    expect((await noticesOf('asha', 'leave.reversed'))[0]?.message).toBe('Your approved Casual Leave for 12 Oct 2026 to 13 Oct 2026 was reversed: Office closed anyway.')
  })

  it('tell the approvers when a request is withdrawn', async () => {
    const id = await apply('ravi', '2026-10-19', '2026-10-19')
    expect((await request(app).delete(`/api/leave-requests/${id}`).set('Authorization', as('ravi'))).status).toBe(200)
    expect((await noticesOf('other_manager', 'leave.withdrawn'))[0]?.message).toBe('Person ravi withdrew their request for Casual Leave: 19 Oct 2026.')
    expect(await noticesOf('manager', 'leave.withdrawn')).toHaveLength(0)
  })

  it('never ask somebody to approve their own leave, even when HR filed it for them', async () => {
    // The Super Admin files leave for HR — an approver herself.
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: employeeId.hr, leaveTypeId, leaveYear: 2026, days: 12, reason: 'opening_grant' } })
    const before = (await noticesOf('hr', 'leave.submitted')).length
    const res = await post('super_admin', '/api/leave-requests', { employeeId: employeeId.hr, leaveTypeId, fromDate: '2026-11-02', toDate: '2026-11-02', reason: 'Filed for her' })
    expect(res.status).toBe(201)
    expect((await noticesOf('hr', 'leave.submitted')).length).toBe(before)
  })

  it('say who withdrew a request for somebody else — and tell that somebody', async () => {
    const id = await apply('asha', '2026-11-09', '2026-11-09')
    // HR may not (it is not HR's to decide); the Super Admin, who may stand in, may.
    expect((await request(app).delete(`/api/leave-requests/${id}`).set('Authorization', as('hr'))).status).toBe(403)
    expect((await request(app).delete(`/api/leave-requests/${id}`).set('Authorization', as('super_admin'))).status).toBe(200)
    expect((await noticesOf('manager', 'leave.withdrawn'))[0]?.message).toBe("Person super_admin withdrew Asha Kulkarni's request for Casual Leave: 9 Nov 2026.")
    const [told] = await noticesOf('asha', 'leave.decided')
    expect(told).toMatchObject({ title: 'Leave request withdrawn', message: 'Person super_admin withdrew your request for Casual Leave: 9 Nov 2026.' })
  })

  it('are not sent when the company switches them off', async () => {
    expect((await put('super_admin', '/api/notifications/settings', { changes: [{ event: 'leave.submitted', enabled: false }] })).status).toBe(200)
    const before = (await noticesOf('manager', 'leave.submitted')).length
    await apply('asha', '2026-10-26', '2026-10-26')
    expect((await noticesOf('manager', 'leave.submitted')).length).toBe(before)
    await put('super_admin', '/api/notifications/settings', { changes: [{ event: 'leave.submitted', enabled: true }] })
  })
})

describe('the switches', () => {
  it('list every event, whom it tells, and whether it is on', async () => {
    const res = await get('super_admin', '/api/notifications/settings')
    expect(res.status).toBe(200)
    const payslip = res.body.data.find((e: { event: string }) => e.event === 'payslip.ready')
    expect(payslip).toMatchObject({ group: 'Payroll', label: 'A payslip is ready', tells: 'The employee it belongs to', optional: true, enabled: true })
  })

  it('cannot turn off a security notice, name an event that does not exist, or be changed by HR', async () => {
    expect((await put('super_admin', '/api/notifications/settings', { changes: [{ event: 'account.password_changed', enabled: false }] })).status).toBe(400)
    expect((await put('super_admin', '/api/notifications/settings', { changes: [{ event: 'made.up', enabled: false }] })).status).toBe(400)
    expect((await put('hr', '/api/notifications/settings', { changes: [{ event: 'leave.submitted', enabled: false }] })).status).toBe(403)
    expect((await get('hr', '/api/notifications/settings')).status).toBe(403)
  })
})

describe('the bell', () => {
  it('lists a person’s own notices, newest first, with the unread count', async () => {
    const res = await get('manager', '/api/notifications')
    expect(res.status).toBe(200)
    expect(res.body.data.length).toBeGreaterThan(0)
    expect(res.body.data.every((n: { read: boolean }) => n.read === false)).toBe(true)
    expect(res.body.meta.unread).toBe(res.body.data.length)
    // A request to decide opens straight on Team Requests (Day 22).
    expect(res.body.data[0]).toMatchObject({ type: 'leave', link: '/leave?tab=decide' })
    expect((await get('manager', '/api/notifications/unread-count')).body.data.unread).toBe(res.body.meta.unread)
  })

  it('marks one read, and refuses to touch anybody else’s', async () => {
    const [mine] = await noticesOf('manager')
    expect((await post('manager', `/api/notifications/${mine!.id}/read`)).status).toBe(200)
    expect((await post('manager', `/api/notifications/${mine!.id}/read`)).status).toBe(200)
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: mine!.id } })).readAt).not.toBeNull()
    const [hers] = await noticesOf('asha')
    expect((await post('manager', `/api/notifications/${hers!.id}/read`)).status).toBe(404)
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: hers!.id } })).readAt).toBeNull()
  })

  it('marks all read, and clears — the caller’s own only', async () => {
    expect((await post('asha', '/api/notifications/read-all')).status).toBe(200)
    expect((await get('asha', '/api/notifications/unread-count')).body.data.unread).toBe(0)
    const hrBefore = (await noticesOf('hr')).length
    expect((await request(app).delete('/api/notifications').set('Authorization', as('asha'))).status).toBe(200)
    expect(await noticesOf('asha')).toHaveLength(0)
    expect((await noticesOf('hr')).length).toBe(hrBefore)
  })

  it('has no way to send a notice from outside the server', async () => {
    expect((await post('asha', '/api/notifications', { userId: userId.hr, title: 'Your salary was changed' })).status).toBe(404)
  })
})

describe('paging', () => {
  it('walks every notice once, even when a whole batch shares one moment', async () => {
    // One transaction's notices share its timestamp; a cursor of the time
    // alone would lose all but the first page of them.
    const at = new Date('2026-09-20T10:00:00Z')
    const batch = Array.from({ length: 35 }, (_, i) => ({
      organizationId: orgId, userId: userId.accounts, event: 'payslip.ready', kind: 'payroll' as const, title: `Batch ${i}`, message: 'm', createdAt: at,
    }))
    await prisma.notification.createMany({ data: batch })

    const seen: string[] = []
    let url = '/api/notifications'
    for (let guard = 0; guard < 5; guard++) {
      const res = await get('accounts', url)
      expect(res.status).toBe(200)
      const items = res.body.data as Array<{ id: string; title: string; created_at: string }>
      seen.push(...items.filter((n) => n.title.startsWith('Batch ')).map((n) => n.id))
      if (!res.body.meta.more) break
      const last = items[items.length - 1]!
      url = `/api/notifications?before=${encodeURIComponent(last.created_at)}&beforeId=${last.id}`
    }
    expect(seen).toHaveLength(35)
    expect(new Set(seen).size).toBe(35)
    await prisma.notification.deleteMany({ where: { organizationId: orgId, userId: userId.accounts, title: { startsWith: 'Batch ' } } })
  })

  it('refuses a cursor id without its time', async () => {
    const res = await get('accounts', `/api/notifications?beforeId=${userId.accounts}`)
    expect(res.status).toBe(422)
  })
})

describe('the retention sweep', () => {
  it('counts on a dry run, then clears only notices past 180 days — in this company', async () => {
    const now = new Date('2026-09-28T00:00:00Z')
    const old = { organizationId: orgId, userId: userId.asha, event: 'leave.decided', kind: 'leave' as const, title: 'Old', message: 'Old', createdAt: new Date('2026-03-01T00:00:00Z') }
    await prisma.notification.createMany({ data: [old, { ...old, title: 'Recent', createdAt: new Date('2026-09-01T00:00:00Z') }] })
    const db = forOrg(orgId)

    expect(await sweepOldNotices({ db }, { apply: false, now })).toEqual({ found: 1, cleared: 0 })
    expect(await prisma.notification.count({ where: { organizationId: orgId, title: 'Old' } })).toBe(1)

    expect(await sweepOldNotices({ db }, { apply: true, now })).toEqual({ found: 1, cleared: 1 })
    expect(await prisma.notification.count({ where: { organizationId: orgId, title: 'Old' } })).toBe(0)
    expect(await prisma.notification.count({ where: { organizationId: orgId, title: 'Recent' } })).toBe(1)
  })
})

describe('a password change', () => {
  it('always tells the person whose password it is', async () => {
    const res = await request(app)
      .post('/api/auth/change-password')
      .set('Authorization', as('ravi'))
      .set('X-Requested-With', 'ems')
      .send({ currentPassword: PASSWORD, newPassword: 'AnotherLongPassword2' })
    expect(res.status).toBe(200)
    const [notice] = await noticesOf('ravi', 'account.password_changed')
    expect(notice).toMatchObject({ kind: 'account', title: 'Your password was changed', link: null })
  })
})
