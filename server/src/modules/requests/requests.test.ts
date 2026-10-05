import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { addCalendarDays, fromDateColumn, toDateColumn, zonedToday } from '../../domain/shared/dates'

/**
 * Requests (client §28–29), through the API.
 *
 *   boss (Super Admin) ─┬─ mgrM (Manager) ─┬─ emp1
 *                       │                  └─ emp2 (works remotely)
 *                       ├─ hrA (HR)
 *                       ├─ hrB (HR)
 *                       └─ adm (Admin)
 */

const PREFIX = 'reqtest'
const PASSWORD = 'CorrectHorseBattery1'
const TIMEZONE = 'Asia/Kolkata'
const OFFICE = { latitude: 19.076, longitude: 72.8777 }
const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
const app = createApp()

type Who = 'boss' | 'mgrM' | 'emp1' | 'emp2' | 'hrA' | 'hrB' | 'adm'
const PEOPLE: [Who, string, Who | null][] = [
  ['boss', 'super_admin', null],
  ['mgrM', 'manager', 'boss'],
  ['emp1', 'employee', 'mgrM'],
  ['emp2', 'employee', 'mgrM'],
  ['hrA', 'hr', 'boss'],
  ['hrB', 'hr', 'boss'],
  ['adm', 'admin', 'boss'],
]

let orgId = ''
const today = zonedToday(new Date(), TIMEZONE)
const emp = {} as Record<Who, string>
const users = {} as Record<Who, string>
const tokens = {} as Record<Who, string>
const email = (who: string) => `${PREFIX}-${who.toLowerCase()}@example.com`

const as = (who: Who) => `Bearer ${tokens[who]}`
const get = (who: Who, url: string) => request(app).get(url).set('Authorization', as(who))
const post = (who: Who, url: string, body: object = {}) => request(app).post(url).set('Authorization', as(who)).send(body)
const put = (who: Who, url: string, body: object) => request(app).put(url).set('Authorization', as(who)).send(body)
const ask = (who: Who, body: object) => post(who, '/api/requests', body)
async function signIn(who: Who) {
  const res = await request(app).post('/api/auth/login').send({ identifier: email(who), password: PASSWORD })
  expect(res.status, `sign in ${who}`).toBe(200)
  tokens[who] = res.body.data.accessToken
}
const told = (who: Who, title: string) => prisma.notification.findMany({ where: { organizationId: orgId, userId: users[who], title } })
const workplace = async (who: Who) => (await get(who, '/api/attendance/me/workplace')).body.data as { work_mode: string; location_needed: boolean; overtime_enabled: boolean }
const waitingFor = async (who: Who) => (await get(who, '/api/requests/waiting')).body.data.map((r: { id: string }) => r.id) as string[]

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  const people = { user: { email: { startsWith: PREFIX } } }
  await prisma.organization.updateMany({ where: { name: { startsWith: PREFIX } }, data: { ownerEmployeeId: null } })
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employeeRequest.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.geofenceLocation.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
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
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: TIMEZONE } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  await prisma.geofenceLocation.create({ data: { organizationId: orgId, name: 'Head Office', ...OFFICE, radiusMeters: 30, maxAccuracyMeters: 50 } })
  for (const [who, role] of PEOPLE) {
    const user = await prisma.user.create({ data: { email: email(who), passwordHash: await hashPassword(PASSWORD) } })
    users[who] = user.id
    emp[who] = (await prisma.employee.create({
      data: {
        organizationId: orgId, employeeCode: `${PREFIX}-${who}`, fullName: `${who} Person`, phone: '9800000000',
        dateOfJoining: toDateColumn('2024-01-08'), onboardedOn: toDateColumn('2024-01-08'), confirmedOn: toDateColumn('2024-07-08'),
        workArrangement: who === 'emp2' ? 'remote' : 'office',
      },
    })).id
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active', employeeId: emp[who] } })
  }
  for (const [who, , above] of PEOPLE) {
    if (above) await prisma.employee.update({ where: { id: emp[who] }, data: { reportingManagerId: emp[above] } })
  }
  for (const [who] of PEOPLE) await signIn(who)
}, 120_000)

afterAll(cleanup)

describe('an attendance correction', () => {
  const day = addCalendarDays(today, -2)
  let id = ''

  it('is the employee’s to send, for a day already worked, and goes to the person they report to', async () => {
    expect((await ask('emp1', { type: 'attendance_correction', date: addCalendarDays(today, 1), checkIn: '09:30', checkOut: null, reason: 'Forgot to punch' })).status).toBe(400)
    expect((await ask('emp1', { type: 'attendance_correction', date: day, checkIn: null, checkOut: null, reason: 'Forgot to punch' })).status).toBe(400)
    expect((await ask('emp1', { type: 'attendance_correction', date: day, checkIn: '09:00', checkOut: '09:00', reason: 'Forgot to punch' })).status).toBe(400)
    expect((await ask('emp1', { type: 'attendance_correction', date: day, checkIn: '9:3', checkOut: null, reason: 'Forgot to punch' })).status).toBe(422)

    const res = await ask('emp1', { type: 'attendance_correction', date: day, checkIn: '09:30', checkOut: '18:30', reason: 'The punch machine was down' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data).toMatchObject({ status: 'pending', label: 'Attendance correction', from_date: day, decided_by_whom: 'mgrM Person', may: { withdraw: true, decide: false } })
    expect(res.body.data.number).toMatch(/^REQ-\d{4,}$/)
    id = res.body.data.id
    expect(await told('mgrM', 'Attendance correction to decide')).toHaveLength(1)

    const again = await ask('emp1', { type: 'attendance_correction', date: day, checkIn: '09:45', checkOut: null, reason: 'Again' })
    expect(again.status).toBe(409)
  })

  it('is decided by the manager — not HR, and not the employee', async () => {
    expect(await waitingFor('mgrM')).toContain(id)
    expect(await waitingFor('hrA')).not.toContain(id)
    const hr = await post('hrA', `/api/requests/${id}/approve`)
    expect(hr.status).toBe(403)
    expect(hr.body.error.message).toBe('This request is decided by mgrM Person.')
    expect((await post('emp1', `/api/requests/${id}/approve`)).status).toBe(403)
    expect((await post('emp2', `/api/requests/${id}/approve`)).status).toBe(404)
    expect((await post('mgrM', `/api/requests/${id}/reject`, {})).status).toBe(400)
  })

  it('once approved, writes the day — and can no longer be withdrawn', async () => {
    const res = await post('mgrM', `/api/requests/${id}/approve`, { note: 'Confirmed with the guard' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data).toMatchObject({ status: 'approved', decided_by: 'mgrM Person', decision_note: 'Confirmed with the guard' })
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.emp1, date: toDateColumn(day) } })
    expect(row.source).toBe('correction')
    expect(row.status).toBe('present')
    expect(row.checkIn?.getTime()).toBe(Date.parse(`${day}T04:00:00Z`))
    expect(Number(row.hoursWorked)).toBe(9)
    expect(await told('emp1', 'Attendance correction approved')).toHaveLength(1)
    expect((await post('emp1', `/api/requests/${id}/withdraw`)).status).toBe(409)
  })

  it('never overwrites approved leave, nor a month whose payroll is approved', async () => {
    const leaveDay = addCalendarDays(today, -3)
    await prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp.emp1, date: toDateColumn(leaveDay), status: 'on_leave', source: 'leave' } })
    const onLeave = await ask('emp1', { type: 'attendance_correction', date: leaveDay, checkIn: '09:30', checkOut: null, reason: 'Came in after all' })
    expect(onLeave.status).toBe(400)
    expect(onLeave.body.error.message).toMatch(/is a day of approved leave/)

    await prisma.payrollRun.create({
      data: {
        organizationId: orgId, year: 2026, month: 8, status: 'approved', lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 0,
        grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0, calculatedAt: new Date(),
      },
    })
    const closed = await ask('emp1', { type: 'attendance_correction', date: '2026-08-12', checkIn: '09:30', checkOut: null, reason: 'Old day' })
    expect(closed.status).toBe(409)
    await prisma.payrollRun.deleteMany({ where: { organizationId: orgId } })
  })
})

describe('working from home', () => {
  let id = ''

  it('needs the office location until it is approved', async () => {
    const res = await ask('emp1', { type: 'work_from_home', fromDate: today, toDate: addCalendarDays(today, 2), reason: 'Plumber at home' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    id = res.body.data.id
    expect((await ask('emp1', { type: 'on_duty', fromDate: addCalendarDays(today, 1), toDate: addCalendarDays(today, 1), reason: 'Client visit' })).status).toBe(409)
    expect((await ask('emp1', { type: 'work_from_home', fromDate: addCalendarDays(today, -1), toDate: today, reason: 'Late ask' })).status).toBe(400)
    expect((await ask('emp1', { type: 'work_from_home', fromDate: addCalendarDays(today, 5), toDate: addCalendarDays(today, 40), reason: 'Too long' })).status).toBe(400)

    expect(await workplace('emp1')).toMatchObject({ work_mode: 'office', location_needed: true })
    const office = await post('emp1', '/api/attendance/punch-in', {})
    expect(office.status).toBe(403)
  })

  it('once approved, lets them check in from home — recorded as work from home', async () => {
    expect((await post('mgrM', `/api/requests/${id}/approve`)).status).toBe(200)
    expect(await workplace('emp1')).toMatchObject({ work_mode: 'wfh', location_needed: false })
    const res = await request(app).post('/api/attendance/punch-in').set('Authorization', as('emp1')).set('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Mobile').send({})
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.work_mode).toBe('wfh')
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.emp1, date: toDateColumn(today) } })
    expect(row.workMode).toBe('wfh')
    expect(row.checkInDevice).toBeTruthy()
    // It started today, so it is no longer theirs to withdraw.
    expect((await post('emp1', `/api/requests/${id}/withdraw`)).status).toBe(409)
  })

  it('can still ask for a location reading, when the company wants one', async () => {
    expect((await put('boss', '/api/requests/settings', { correctionApprover: 'manager', wfhApprover: 'manager', overtimeApprover: 'manager', profileApprover: 'hr', encashmentApprover: 'hr', wfhGpsRequired: true })).status).toBe(200)
    const later = await ask('mgrM', { type: 'on_duty', fromDate: today, toDate: today, reason: 'Client visit' })
    expect(later.status, JSON.stringify(later.body)).toBe(201)
    expect((await post('boss', `/api/requests/${later.body.data.id}/approve`)).status).toBe(200)
    expect(await workplace('mgrM')).toMatchObject({ work_mode: 'on_duty', location_needed: true })
    expect((await post('mgrM', '/api/attendance/punch-in', {})).status).toBe(403)
    const ok = await post('mgrM', '/api/attendance/punch-in', { latitude: 28.6, longitude: 77.2, accuracyMeters: 20 })
    expect(ok.status, JSON.stringify(ok.body)).toBe(201)
    expect(ok.body.data.work_mode).toBe('on_duty')
    expect((await put('boss', '/api/requests/settings', { correctionApprover: 'manager', wfhApprover: 'manager', overtimeApprover: 'manager', profileApprover: 'hr', encashmentApprover: 'hr', wfhGpsRequired: false })).status).toBe(200)
  })

  it('may be withdrawn before its first day, even when approved', async () => {
    const res = await ask('emp1', { type: 'work_from_home', fromDate: addCalendarDays(today, 10), toDate: addCalendarDays(today, 10), reason: 'Next week' })
    expect((await post('mgrM', `/api/requests/${res.body.data.id}/approve`)).status).toBe(200)
    const back = await post('emp1', `/api/requests/${res.body.data.id}/withdraw`)
    expect(back.status).toBe(200)
    expect(back.body.data.status).toBe('withdrawn')
    expect(await told('mgrM', 'Work from home withdrawn')).toHaveLength(1)
  })

  it('is not asked of somebody who works remotely: they check in from anywhere', async () => {
    expect((await ask('emp2', { type: 'work_from_home', fromDate: today, toDate: today, reason: 'Home' })).status).toBe(400)
    expect(await workplace('emp2')).toMatchObject({ work_mode: 'remote', location_needed: false })
    const res = await post('emp2', '/api/attendance/punch-in', {})
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.work_mode).toBe('remote')
  })
})

describe('a profile change', () => {
  let id = ''

  it('is reviewed by HR, never the manager', async () => {
    expect((await ask('emp1', { type: 'profile_change', changes: { phone: '9800000000' }, reason: 'Same number' })).status).toBe(400)
    const res = await ask('emp1', { type: 'profile_change', changes: { phone: '9811111111', address: '12 New Road, Pune', dateOfBirth: '1995-05-20' }, reason: 'Moved house' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.decided_by_whom).toBe('HR, who keeps employee records')
    id = res.body.data.id
    expect(await waitingFor('hrA')).toContain(id)
    expect(await waitingFor('mgrM')).not.toContain(id)
    // Personal details: the manager does not even see the request.
    expect((await post('mgrM', `/api/requests/${id}/approve`)).status).toBe(404)
    expect(await told('hrA', 'Profile change to decide')).toHaveLength(1)
  })

  it('once approved, changes the record — and the audit log names the details, never their values', async () => {
    expect((await post('hrA', `/api/requests/${id}/approve`)).status).toBe(200)
    const row = await prisma.employee.findUniqueOrThrow({ where: { id: emp.emp1 } })
    expect(row.phone).toBe('9811111111')
    expect(row.address).toBe('12 New Road, Pune')
    expect(fromDateColumn(row.dateOfBirth)).toBe('1995-05-20')
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'request.approved', entityId: id } })
    expect(entry.details).toMatchObject({ changes: { phone: null, address: null, dateOfBirth: null } })
    const log = (await get('boss', '/api/audit-log')).body.data as { summary: string }[]
    const text = log.map((e) => e.summary).join(' | ')
    expect(text).toMatch(/profile change REQ-\d{4}: phone; address; date of birth/i)
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { organizationId: orgId } }))).not.toContain('9811111111')
  })

  it('of an HR person goes up the tree: their fellow HR does not decide it', async () => {
    const res = await ask('hrA', { type: 'profile_change', changes: { nationality: 'Indian' }, reason: 'Missing' })
    expect(res.status).toBe(201)
    expect(await waitingFor('hrB')).not.toContain(res.body.data.id)
    expect(await waitingFor('boss')).toContain(res.body.data.id)
  })
})

describe('the edges of a correction', () => {
  const back = (n: number) => addCalendarDays(today, -n)

  it('is refused at approval once the day has become approved leave', async () => {
    const day = back(9)
    const sent = await ask('emp1', { type: 'attendance_correction', date: day, checkIn: '09:30', checkOut: '11:30', reason: 'Came in briefly' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    await prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp.emp1, date: toDateColumn(day), status: 'on_leave', source: 'leave' } })
    const res = await post('mgrM', `/api/requests/${sent.body.data.id}/approve`)
    expect(res.status).toBe(409)
    expect((await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.emp1, date: toDateColumn(day) } })).status).toBe('on_leave')
  })

  it('keeps a holiday a holiday — the times are recorded, the day is not graded', async () => {
    const day = back(10)
    await prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp.emp1, date: toDateColumn(day), status: 'holiday', source: 'manual' } })
    const sent = await ask('emp1', { type: 'attendance_correction', date: day, checkIn: '10:00', checkOut: '12:00', reason: 'Came in for the audit' })
    expect((await post('mgrM', `/api/requests/${sent.body.data.id}/approve`)).status).toBe(200)
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.emp1, date: toDateColumn(day) } })
    expect(row.status).toBe('holiday')
    expect(row.checkIn).not.toBeNull()
  })

  it('reads a night shift’s morning check-out as the next day', async () => {
    const day = back(11)
    await prisma.attendance.create({
      data: { organizationId: orgId, employeeId: emp.emp1, date: toDateColumn(day), status: 'present', source: 'punch', checkIn: new Date(`${day}T16:30:00Z`) },
    })
    const sent = await ask('emp1', { type: 'attendance_correction', date: day, checkOut: '06:00', reason: 'Forgot to check out after the night shift' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    expect((await post('mgrM', `/api/requests/${sent.body.data.id}/approve`)).status).toBe(200)
    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.emp1, date: toDateColumn(day) } })
    // 22:00 IST in, 06:00 IST the next morning out.
    expect(row.checkOut?.getTime()).toBe(Date.parse(`${addCalendarDays(day, 1)}T00:30:00Z`))
    const none = await ask('emp1', { type: 'attendance_correction', date: back(13), checkOut: '06:00', reason: 'Night shift' })
    expect(none.status).toBe(400)
    expect(none.body.error.message).toMatch(/Nothing is recorded on .*, so give both/)
    const both = await ask('emp1', { type: 'attendance_correction', date: back(12), checkIn: '22:00', checkOut: '06:00', reason: 'Night shift' })
    expect(both.status, JSON.stringify(both.body)).toBe(201)
  })
})

describe('overtime', () => {
  it('is off until the company turns it on — the app offers no claim, and one sent is refused', async () => {
    expect((await workplace('emp1')).overtime_enabled).toBe(false)
    const res = await ask('emp1', { type: 'overtime', date: addCalendarDays(today, -2), reason: 'Stayed late' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/does not pay overtime/)
  })
})

describe('a profile change and personal details', () => {
  it('is asked, like leave, only from a login that may apply for leave', async () => {
    // The Admin role login has no leave:apply: the person asks from their employee login (Day 23).
    expect((await ask('adm', { type: 'profile_change', changes: { nationality: 'Indian' }, reason: 'Missing' })).status).toBe(403)
  })

  it('is not decided, nor seen, by a role that may not read personal details', async () => {
    const sent = await ask('emp2', { type: 'profile_change', changes: { address: '7 Hill Road' }, reason: 'Moved' })
    expect(sent.status).toBe(201)
    expect((await post('adm', `/api/requests/${sent.body.data.id}/approve`)).status).toBe(404)
    const listed = (await get('adm', '/api/requests/all')).body.data ?? []
    expect(listed.some((r: { id: string }) => r.id === sent.body.data.id)).toBe(false)
    expect(await told('adm', 'Profile change to decide')).toHaveLength(0)
    expect((await post('hrA', `/api/requests/${sent.body.data.id}/approve`)).status).toBe(200)
  })
})

describe('the approval settings', () => {
  it('are the Super Admin’s, and send a kind of request to HR when chosen', async () => {
    expect((await get('hrA', '/api/requests/settings')).status).toBe(403)
    expect((await put('boss', '/api/requests/settings', { correctionApprover: 'hr', wfhApprover: 'manager', overtimeApprover: 'manager', profileApprover: 'hr', encashmentApprover: 'hr', wfhGpsRequired: false })).status).toBe(200)
    const res = await ask('emp1', { type: 'attendance_correction', date: addCalendarDays(today, -4), checkIn: '09:30', checkOut: '18:00', reason: 'Left without punching out' })
    expect(res.status).toBe(201)
    expect(res.body.data.decided_by_whom).toBe('HR, who corrects attendance')
    expect(await waitingFor('hrA')).toContain(res.body.data.id)
    expect(await waitingFor('mgrM')).not.toContain(res.body.data.id)
    expect((await put('boss', '/api/requests/settings', { correctionApprover: 'manager', wfhApprover: 'manager', overtimeApprover: 'manager', profileApprover: 'hr', encashmentApprover: 'hr', wfhGpsRequired: false })).status).toBe(200)
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'request.settings_updated' } })).toBeGreaterThan(0)
  })
})

describe('the owner', () => {
  it('needs nobody’s approval', async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: emp.boss } })
    const res = await ask('boss', { type: 'work_from_home', fromDate: addCalendarDays(today, 3), toDate: addCalendarDays(today, 3), reason: 'Board papers' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.status).toBe('approved')
    await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: null } })
  })
})

describe('reading', () => {
  it('shows HR everybody’s requests, and anybody else only what their reach shows', async () => {
    const all = await get('hrA', '/api/requests/all')
    expect(all.status).toBe(200)
    expect(all.body.data.length).toBeGreaterThan(3)
    // An employee's attendance reach is their own: their own requests, and no one's profile changes.
    const own = await get('emp1', '/api/requests/all')
    expect(own.body.data.every((r: { employee_id: string }) => r.employee_id === emp.emp1)).toBe(true)
    expect((await get('mgrM', '/api/requests/all')).body.data.some((r: { type: string }) => r.type === 'profile_change')).toBe(false)
    const mine = await get('emp1', '/api/requests/mine')
    expect(mine.body.data.every((r: { employee_id: string }) => r.employee_id === emp.emp1)).toBe(true)
    const pending = await get('hrA', '/api/requests/all?status=pending&type=profile_change')
    expect(pending.body.data.every((r: { status: string; type: string }) => r.status === 'pending' && r.type === 'profile_change')).toBe(true)
  })

  it('stops showing a request to whoever decided it once that person’s requests are no longer theirs', async () => {
    // A working day far enough ahead to clash with nothing above.
    let day = addCalendarDays(today, 20)
    while (new Date(`${day}T00:00:00Z`).getUTCDay() === 0) day = addCalendarDays(day, 1)
    const sent = await ask('emp1', { type: 'on_duty', fromDate: day, toDate: day, reason: 'Client visit in Nashik' })
    expect(sent.status, JSON.stringify(sent.body)).toBe(201)
    const id = sent.body.data.id as string
    expect((await post('mgrM', `/api/requests/${id}/approve`)).status).toBe(200)
    expect((await get('mgrM', `/api/requests/${id}`)).status).toBe(200)

    // emp1 now reports to somebody else: mgrM decided it once, and decides none of emp1's now.
    await prisma.employee.update({ where: { id: emp.emp1 }, data: { reportingManagerId: emp.boss } })
    try {
      expect((await get('mgrM', `/api/requests/${id}`)).status).toBe(404)
      expect((await get('mgrM', `/api/requests/${id}/attachment`)).status).toBe(404)
      // The person themselves, and the one who decides for them now, still see it.
      expect((await get('emp1', `/api/requests/${id}`)).status).toBe(200)
      expect((await get('boss', `/api/requests/${id}`)).status).toBe(200)
    } finally {
      await prisma.employee.update({ where: { id: emp.emp1 }, data: { reportingManagerId: emp.mgrM } })
    }
    // Back under mgrM: theirs to read again.
    expect((await get('mgrM', `/api/requests/${id}`)).status).toBe(200)
  })

  it('gives the employee their own details to start a profile change from', async () => {
    const res = await get('emp1', '/api/requests/my-details')
    expect(res.body.data).toMatchObject({ phone: '9811111111', address: '12 New Road, Pune', dateOfBirth: '1995-05-20' })
  })
})

describe('a supporting file', () => {
  it('is added by the employee while it waits, and opened by whoever may see the request', async () => {
    const res = await ask('emp1', { type: 'attendance_correction', date: addCalendarDays(today, -5), checkIn: '10:00', checkOut: '18:00', reason: 'Gate register shows it' })
    const id = res.body.data.id as string
    const upload = await request(app).post(`/api/requests/${id}/attachment`).set('Authorization', as('emp1')).attach('file', PDF, 'gate.pdf')
    expect(upload.status, JSON.stringify(upload.body)).toBe(200)
    expect(upload.body.data.attachment).toMatchObject({ name: 'gate.pdf', type: 'application/pdf' })
    expect((await request(app).post(`/api/requests/${id}/attachment`).set('Authorization', as('emp1')).attach('file', PDF, 'again.pdf')).status).toBe(409)
    expect((await request(app).post(`/api/requests/${id}/attachment`).set('Authorization', as('mgrM')).attach('file', PDF, 'x.pdf')).status).toBe(404)

    const open = await get('mgrM', `/api/requests/${id}/attachment`)
    expect(open.status).toBe(200)
    expect(open.headers['content-type']).toMatch(/application\/pdf/)
    expect((await get('emp2', `/api/requests/${id}/attachment`)).status).toBe(404)
  })
})

describe('personal details on the employee record', () => {
  it('are written and read by whoever sees statutory details, and by the person', async () => {
    const set = await request(app).patch(`/api/employees/${emp.emp2}`).set('Authorization', as('hrA')).send({ personal: { emergencyContactName: 'Asha', emergencyContactPhone: '9822222222' } })
    expect(set.status, JSON.stringify(set.body)).toBe(200)
    expect(set.body.data).toMatchObject({ emergency_contact_name: 'Asha', emergency_contact_phone: '9822222222' })
    // A manager reads the record, not the personal details — nor may they write them.
    const manager = await get('mgrM', `/api/employees/${emp.emp2}`)
    expect(manager.status).toBe(200)
    expect(manager.body.data).not.toHaveProperty('emergency_contact_name')
    expect((await request(app).patch(`/api/employees/${emp.emp2}`).set('Authorization', as('mgrM')).send({ personal: { address: 'x' } })).status).toBe(403)
  })
})
