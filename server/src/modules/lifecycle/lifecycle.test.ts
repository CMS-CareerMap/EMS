import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { forOrg } from '../../platform/db/scoped'
import { hashPassword } from '../../platform/auth/password'
import { addCalendarDays, fromDateColumn, toDateColumn, zonedToday } from '../../domain/shared/dates'
import { defaultProbationEnd } from '../../domain/org/lifecycle'
import { employeesForMonth } from '../payroll/payrollRun.repository'

/**
 * The employee lifecycle (client §43), through the API:
 *
 *   Joining soon → Onboarding → Probation → Confirmed → transfers and
 *   promotions → Resigned → Serving notice → Exit → Left
 *
 *   boss (Super Admin) ─┬─ mgrM (Manager) ─┬─ emp1 (on probation)
 *                       │                  ├─ emp2 (resigns, accepted, leaves)
 *                       │                  ├─ emp3 (transferred, promoted; resignation recorded and called off)
 *                       │                  └─ hrA (HR)
 *                       ├─ hrB (HR)
 *                       ├─ acct (Accounts)
 *                       ├─ adm (Admin)
 *                       ├─ soon (joins next week)
 *                       └─ gone (past their last working day, exit not yet completed)
 */

const PREFIX = 'lifecyc'
const PASSWORD = 'CorrectHorseBattery1'
const TIMEZONE = 'Asia/Kolkata'
const app = createApp()

type Who = 'boss' | 'mgrM' | 'emp1' | 'emp2' | 'emp3' | 'hrA' | 'hrB' | 'acct' | 'adm' | 'soon' | 'gone'
const PEOPLE: [Who, string, Who | null][] = [
  ['boss', 'super_admin', null],
  ['mgrM', 'manager', 'boss'],
  ['emp1', 'employee', 'mgrM'],
  ['emp2', 'employee', 'mgrM'],
  ['emp3', 'employee', 'mgrM'],
  ['hrA', 'hr', 'mgrM'],
  ['hrB', 'hr', 'boss'],
  ['acct', 'accounts', 'boss'],
  ['adm', 'admin', 'boss'],
  ['soon', 'employee', 'boss'],
  ['gone', 'employee', 'boss'],
]

let orgId = ''
let clId = ''
let sales = ''
let support = ''
let executive = ''
let lead = ''
const today = zonedToday(new Date(), TIMEZONE)
const emp = {} as Record<Who, string>
const users = {} as Record<Who, string>
const tokens = {} as Record<Who, string>
const email = (who: string) => `${PREFIX}-${who.toLowerCase()}@example.com`

const as = (who: Who) => `Bearer ${tokens[who]}`
const get = (who: Who, url: string) => request(app).get(url).set('Authorization', as(who))
const post = (who: Who, url: string, body: object = {}) => request(app).post(url).set('Authorization', as(who)).send(body)
const put = (who: Who, url: string, body: object) => request(app).put(url).set('Authorization', as(who)).send(body)
const of = (who: Who, url: string) => get(who, `/api/lifecycle/employees/${url}`)
const step = (who: Who, id: string, what: string, body: object = {}) => post(who, `/api/lifecycle/employees/${id}/${what}`, body)
async function signIn(who: Who) {
  const res = await request(app).post('/api/auth/login').send({ identifier: email(who), password: PASSWORD })
  expect(res.status, `sign in ${who}`).toBe(200)
  tokens[who] = res.body.data.accessToken
}
const told = (who: Who, title: string) => prisma.notification.findMany({ where: { organizationId: orgId, userId: users[who], title } })

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  const people = { user: { email: { startsWith: PREFIX } } }
  await prisma.organization.updateMany({ where: { name: { startsWith: PREFIX } }, data: { ownerEmployeeId: null } })
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employmentEvent.deleteMany({ where: org })
  await prisma.resignation.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.passwordResetToken.deleteMany({ where: people })
  await prisma.refreshToken.deleteMany({ where: people })
  await prisma.membership.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.department.deleteMany({ where: org })
  await prisma.designation.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: TIMEZONE } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  clId = (await prisma.leaveType.create({ data: { organizationId: orgId, name: 'Casual Leave', code: 'CL', annualQuota: 12 } })).id
  sales = (await prisma.department.create({ data: { organizationId: orgId, name: 'Sales' } })).id
  support = (await prisma.department.create({ data: { organizationId: orgId, name: 'Support' } })).id
  executive = (await prisma.designation.create({ data: { organizationId: orgId, name: 'Executive' } })).id
  lead = (await prisma.designation.create({ data: { organizationId: orgId, name: 'Team Lead' } })).id

  for (const [who, role] of PEOPLE) {
    const user = await prisma.user.create({ data: { email: email(who), passwordHash: await hashPassword(PASSWORD) } })
    users[who] = user.id
    // Everybody here long since confirmed, except as set below.
    emp[who] = (await prisma.employee.create({
      data: {
        organizationId: orgId, employeeCode: `${PREFIX}-${who}`, fullName: `${who} Person`,
        dateOfJoining: toDateColumn('2024-01-08'), onboardedOn: toDateColumn('2024-01-08'), confirmedOn: toDateColumn('2024-07-08'),
        departmentId: sales, designationId: executive,
      },
    })).id
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active', employeeId: emp[who] } })
  }
  for (const [who, , above] of PEOPLE) {
    if (above) await prisma.employee.update({ where: { id: emp[who] }, data: { reportingManagerId: emp[above] } })
  }
  await prisma.employee.update({ where: { id: emp.emp1 }, data: { dateOfJoining: toDateColumn(addCalendarDays(today, -170)), onboardedOn: toDateColumn(addCalendarDays(today, -170)), confirmedOn: null, probationEndDate: toDateColumn(addCalendarDays(today, 10)) } })
  await prisma.employee.update({ where: { id: emp.soon }, data: { dateOfJoining: toDateColumn(addCalendarDays(today, 7)), onboardedOn: null, confirmedOn: null } })
  await prisma.employee.update({ where: { id: emp.gone }, data: { lastWorkingDate: toDateColumn(addCalendarDays(today, -1)) } })
  for (const [who] of PEOPLE) await signIn(who)
}, 120_000)

afterAll(cleanup)

describe('settings', () => {
  it('lets HR read the probation and notice period, and only Settings change them', async () => {
    const read = await get('hrA', '/api/lifecycle/settings')
    expect(read.status).toBe(200)
    expect(read.body.data).toEqual({ probation_months: 6, notice_period_days: 30 })
    expect((await get('emp1', '/api/lifecycle/settings')).status).toBe(403)
    expect((await put('hrA', '/api/lifecycle/settings', { probationMonths: 3, noticePeriodDays: 45 })).status).toBe(403)
    expect((await put('boss', '/api/lifecycle/settings', { probationMonths: 25, noticePeriodDays: 30 })).status).toBe(422)
    expect((await put('boss', '/api/lifecycle/settings', { probationMonths: 3, noticePeriodDays: 200 })).status).toBe(422)

    const saved = await put('boss', '/api/lifecycle/settings', { probationMonths: 3, noticePeriodDays: 45 })
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    expect(saved.body.data).toEqual({ probation_months: 3, notice_period_days: 45 })
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'lifecycle.settings_updated' } })).toBe(1)
    expect((await put('boss', '/api/lifecycle/settings', { probationMonths: 6, noticePeriodDays: 30 })).status).toBe(200)
  })
})

describe('joining', () => {
  it('starts a new joiner in onboarding, with probation ending the company’s months after joining', async () => {
    const joined = addCalendarDays(today, -5)
    const res = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-new1`, fullName: 'New Joiner', dateOfJoining: joined, departmentId: sales })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.lifecycle_stage).toBe('onboarding')
    expect(res.body.data.probation_end_date).toBe(defaultProbationEnd(joined, 6))
    expect(res.body.data.onboarded_on).toBeNull()
    expect(res.body.data.confirmed_on).toBeNull()
  })

  it('takes somebody already working here as confirmed', async () => {
    const res = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-old1`, fullName: 'Old Hand', dateOfJoining: '2023-04-03', confirmedOn: '2023-10-03' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.lifecycle_stage).toBe('confirmed')
    expect(res.body.data.onboarded_on).toBe('2023-04-03')
    expect(res.body.data.probation_end_date).toBeNull()

    const before = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-old2`, fullName: 'Wrong Dates', dateOfJoining: '2023-04-03', confirmedOn: '2023-01-03' })
    expect(before.status).toBe(400)
    expect(before.body.error.message).toBe('The confirmation date (2023-01-03) cannot be before the joining date (2023-04-03).')
    const ahead = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-old3`, fullName: 'Not Yet', dateOfJoining: '2023-04-03', confirmedOn: addCalendarDays(today, 3) })
    expect(ahead.status).toBe(400)
    expect(ahead.body.error.message).toMatch(/is in the future\. Leave it empty for somebody still on probation\.$/)
  })

  it('shows somebody who joins later as joining soon, with nothing to onboard yet', async () => {
    const res = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-fut1`, fullName: 'Future Joiner', dateOfJoining: addCalendarDays(today, 14) })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.lifecycle_stage).toBe('joining_soon')
    const id = res.body.data.id as string

    const view = await of('hrA', id)
    expect(view.body.data.stage).toBe('joining_soon')
    expect(view.body.data.may.complete_onboarding).toBe(false)
    expect((await step('hrA', id, 'onboarding')).status).toBe(409)
  })

  it('lets somebody go who was to join and is not coming — with no last working day', async () => {
    const res = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-fut2`, fullName: 'Not Coming', dateOfJoining: addCalendarDays(today, 10) })
    const id = res.body.data.id as string
    expect((await of('hrA', id)).body.data.may.exit).toBe(true)
    const dated = await step('hrA', id, 'exit', { reason: 'other', lastWorkingDate: today })
    expect(dated.status).toBe(400)
    expect(dated.body.error.message).toMatch(/has not joined yet, so there is no last working day/)
    expect((await step('hrA', id, 'exit', { reason: 'other', lastWorkingDate: null, note: 'Took another offer' })).status).toBe(204)
    const row = await prisma.employee.findUniqueOrThrow({ where: { id } })
    expect(row.archivedAt).not.toBeNull()
    expect(row.lastWorkingDate).toBeNull()
    expect((await of('hrA', id)).body.data.history[0]).toMatchObject({ kind: 'exited', details: { neverJoined: true } })
  })

  it('refuses a date that is not on the calendar', async () => {
    expect((await step('hrA', emp.emp1, 'probation', { probationEndDate: '2026-02-30', note: 'Not a day' })).status).toBe(422)
    expect((await step('hrA', emp.emp1, 'probation', { probationEndDate: '2026-13-01', note: 'Not a day' })).status).toBe(422)
  })

  it('reads confirmed_on from an import', async () => {
    const csv = ['employee_code,full_name,date_of_joining,confirmed_on', `${PREFIX}-imp1,Imported Hand,03/04/2023,03/10/2023`, `${PREFIX}-imp2,Imported New,${addCalendarDays(today, -3).split('-').reverse().join('/')},`].join('\n')
    const res = await post('hrA', '/api/employees/import', { csv, dryRun: false })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.summary.imported).toBe(2)
    const hand = await prisma.employee.findFirstOrThrow({ where: { organizationId: orgId, employeeCode: `${PREFIX}-imp1` } })
    expect(fromDateColumn(hand.confirmedOn)).toBe('2023-10-03')
    expect(fromDateColumn(hand.onboardedOn)).toBe('2023-04-03')
    const fresh = await prisma.employee.findFirstOrThrow({ where: { organizationId: orgId, employeeCode: `${PREFIX}-imp2` } })
    expect(fresh.confirmedOn).toBeNull()
    expect(fromDateColumn(fresh.probationEndDate)).toBe(defaultProbationEnd(addCalendarDays(today, -3), 6))

    const wrong = await post('hrA', '/api/employees/import', { csv: ['employee_code,full_name,date_of_joining,confirmed_on', `${PREFIX}-imp3,Wrong Way,03/04/2023,03/01/2023`].join('\n'), dryRun: true })
    expect(wrong.status).toBe(200)
    expect(wrong.body.data.summary.valid).toBe(0)
    const future = addCalendarDays(today, 5).split('-').reverse().join('/')
    const ahead = await post('hrA', '/api/employees/import', { csv: ['employee_code,full_name,date_of_joining,confirmed_on', `${PREFIX}-imp4,Not Yet,03/04/2023,${future}`].join('\n'), dryRun: true })
    expect(ahead.body.data.rows[0].issues).toEqual([expect.objectContaining({ field: 'confirmed_on' })])
  })
})

describe('onboarding', () => {
  it('shows HR the checklist, completes it once, and starts probation', async () => {
    const id = (await prisma.employee.findFirstOrThrow({ where: { organizationId: orgId, employeeCode: `${PREFIX}-new1` } })).id
    const view = await of('hrA', id)
    expect(view.status).toBe(200)
    expect(view.body.data.stage).toBe('onboarding')
    expect(view.body.data.onboarding).toMatchObject({ login_active: false, login_invited: false, has_manager: false, bank_status: null })
    expect(view.body.data.may.complete_onboarding).toBe(true)

    expect((await step('emp1', id, 'onboarding')).status).toBe(403)
    const done = await step('hrA', id, 'onboarding', { note: 'Papers in order' })
    expect(done.status, JSON.stringify(done.body)).toBe(200)
    expect(done.body.data.stage).toBe('probation')
    expect(done.body.data.onboarded_on).toBe(today)
    expect(done.body.data.history[0]).toMatchObject({ kind: 'onboarding_completed', note: 'Papers in order', by: 'hrA Person' })

    const again = await step('hrA', id, 'onboarding')
    expect(again.status).toBe(409)
    expect(again.body.error.message).toBe('New Joiner is on probation, so there is no onboarding to complete. Reload to see where they stand.')
  })

  it('lists who needs HR, within HR’s reach', async () => {
    const res = await get('hrA', '/api/lifecycle/summary')
    expect(res.status).toBe(200)
    const names = (list: { full_name: string }[]) => list.map((i) => i.full_name)
    expect(names(res.body.data.joining_soon)).toEqual(expect.arrayContaining(['soon Person', 'Future Joiner']))
    expect(names(res.body.data.onboarding)).toContain('Imported New')
    expect(names(res.body.data.probation_ending)).toContain('emp1 Person')
    expect(names(res.body.data.exit_due)).toEqual(['gone Person'])
    expect((await get('mgrM', '/api/lifecycle/summary')).status).toBe(403)
  })
})

describe('own work goes up the tree', () => {
  it('refuses HR its own record and a fellow HR person’s, and says whom to ask', async () => {
    const own = await step('hrA', emp.hrA, 'confirm', { confirmedOn: today })
    expect(own.status).toBe(403)
    expect(own.body.error.message).toMatch(/^You cannot change your own employment record\. It goes to the person above you: /)
    const peer = await step('hrA', emp.hrB, 'promote', { designationId: lead, effectiveDate: today })
    expect(peer.status).toBe(403)
    expect(peer.body.error.message).toMatch(/^hrB Person does this kind of work too, so their employment record is done by the people above them\./)

    const view = await of('hrA', emp.hrB)
    expect(view.body.data.may).toMatchObject({ transfer: false, promote: false, exit: false, record_resignation: false })
    expect(view.body.data.goes_to).toBeTruthy()
    // The Super Admin does it.
    expect((await of('boss', emp.hrB)).body.data.may.promote).toBe(true)
  })

  it('keeps a senior’s resignation from HR below them until it is accepted', async () => {
    const res = await post('mgrM', '/api/lifecycle/resignations', { reason: 'Starting a company' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    const rid = res.body.data.resignation.id as string
    // hrA reports to mgrM: not on the card, not in the directory, not told.
    expect((await get('hrA', '/api/lifecycle/summary')).body.data.resigned.map((i: { full_name: string }) => i.full_name)).not.toContain('mgrM Person')
    expect((await get('hrA', `/api/employees/${emp.mgrM}`)).body.data.lifecycle_stage).toBe('confirmed')
    expect((await of('hrA', emp.mgrM)).body.data).toMatchObject({ detailed: false, resignation: null })
    expect(await told('hrA', 'A resignation')).toHaveLength(0)
    // hrB, beside mgrM under boss, runs it — and the Super Admin decides it.
    expect((await get('hrB', '/api/lifecycle/summary')).body.data.resigned.map((i: { full_name: string }) => i.full_name)).toContain('mgrM Person')
    expect(await told('hrB', 'A resignation')).toHaveLength(1)
    expect(await told('boss', 'A resignation')).toHaveLength(1)
    expect((await post('mgrM', `/api/lifecycle/resignations/${rid}/withdraw`)).status).toBe(204)
    await prisma.notification.deleteMany({ where: { organizationId: orgId } })
  })

  it('tells whoever accepts a waiting resignation now, when its person is moved on the Company Tree', async () => {
    const res = await post('emp3', '/api/lifecycle/resignations', { reason: 'Moving abroad' })
    expect(res.status).toBe(201)
    expect((await request(app).patch(`/api/employees/${emp.emp3}`).set('Authorization', as('boss')).send({ reportingManagerId: emp.adm })).status).toBe(200)
    const notices = await told('adm', 'A resignation')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.message).toBe('After a change in the company tree, emp3 Person\'s resignation is yours to accept.')
    expect((await post('emp3', `/api/lifecycle/resignations/${res.body.data.resignation.id}/withdraw`)).status).toBe(204)
    expect((await request(app).patch(`/api/employees/${emp.emp3}`).set('Authorization', as('boss')).send({ reportingManagerId: emp.mgrM })).status).toBe(200)
    await prisma.notification.deleteMany({ where: { organizationId: orgId } })
  })

  it('refuses HR the record of somebody above them in the tree', async () => {
    const res = await step('hrA', emp.mgrM, 'promote', { designationId: lead, effectiveDate: today })
    expect(res.status).toBe(403)
    expect(res.body.error.message).toBe('mgrM Person is above you in the company tree, so their employment record is changed by the Super Admin.')
    const view = (await of('hrA', emp.mgrM)).body.data
    expect(view.may).toMatchObject({ promote: false, transfer: false, record_resignation: false, exit: false })
    expect(view.goes_to).toBe('the Super Admin')
  })

  it('holds on the employee record too: one’s own designation, a senior’s, a peer’s', async () => {
    const own = await request(app).patch(`/api/employees/${emp.hrA}`).set('Authorization', as('hrA')).send({ designationId: lead })
    expect(own.status).toBe(403)
    expect(own.body.error.message).toMatch(/^You cannot change your own employment record/)
    expect((await request(app).patch(`/api/employees/${emp.mgrM}`).set('Authorization', as('hrA')).send({ designationId: lead })).status).toBe(403)
    expect((await request(app).patch(`/api/employees/${emp.hrB}`).set('Authorization', as('hrA')).send({ lastWorkingDate: addCalendarDays(today, 60) })).status).toBe(403)
    // An ordinary employee's designation changes, and the history says so.
    const fine = await request(app).patch(`/api/employees/${emp.emp1}`).set('Authorization', as('hrA')).send({ designationId: lead })
    expect(fine.status, JSON.stringify(fine.body)).toBe(200)
    expect((await of('hrA', emp.emp1)).body.data.history[0]).toMatchObject({ kind: 'promoted', details: { fromDesignation: 'Executive', toDesignation: 'Team Lead', via: 'edit' } })
    expect((await request(app).patch(`/api/employees/${emp.emp1}`).set('Authorization', as('hrA')).send({ designationId: executive })).status).toBe(200)
  })

  it('holds on the rest of the record: own PF, a fellow HR person’s phone, a senior’s details', async () => {
    // Opting oneself out of PF would change one's own pay with nobody seeing it.
    const own = await request(app).patch(`/api/employees/${emp.hrA}`).set('Authorization', as('hrA')).send({ statutory: { pfApplicable: false } })
    expect(own.status).toBe(403)
    expect(own.body.error.message).toMatch(/^You cannot change your own record\. Ask for the change on My Details/)
    expect((await request(app).patch(`/api/employees/${emp.hrB}`).set('Authorization', as('hrA')).send({ phone: '9800000001' })).status).toBe(403)
    const senior = await request(app).patch(`/api/employees/${emp.mgrM}`).set('Authorization', as('hrA')).send({ phone: '9800000002' })
    expect(senior.status).toBe(403)
    expect(senior.body.error.message).toMatch(/above you in the company tree, so their record is changed by the Super Admin/)
    // An ordinary employee's details are HR's to keep.
    expect((await request(app).patch(`/api/employees/${emp.emp1}`).set('Authorization', as('hrA')).send({ phone: '9800000003' })).status).toBe(200)
  })
})

describe('probation', () => {
  it('extends it with a reason, and never into the past', async () => {
    expect((await step('hrA', emp.emp1, 'probation', { probationEndDate: addCalendarDays(today, 40) })).status).toBe(422)
    const past = await step('hrA', emp.emp1, 'probation', { probationEndDate: addCalendarDays(today, -1), note: 'Needs more time' })
    expect(past.status).toBe(400)
    const res = await step('hrA', emp.emp1, 'probation', { probationEndDate: addCalendarDays(today, 40), note: 'Needs more time' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.probation_end_date).toBe(addCalendarDays(today, 40))
    expect(res.body.data.history[0]).toMatchObject({ kind: 'probation_extended', details: { from: addCalendarDays(today, 10), to: addCalendarDays(today, 40) } })
    expect(await told('emp1', 'Probation extended')).toHaveLength(1)
    const summary = await get('hrA', '/api/lifecycle/summary')
    expect(summary.body.data.probation_ending.map((i: { full_name: string }) => i.full_name)).not.toContain('emp1 Person')
  })

  it('confirms on a day up to today, once', async () => {
    expect((await step('hrA', emp.emp1, 'confirm', { confirmedOn: addCalendarDays(today, 1) })).status).toBe(400)
    const res = await step('hrA', emp.emp1, 'confirm', { confirmedOn: today, note: null })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.stage).toBe('confirmed')
    expect(res.body.data.confirmed_on).toBe(today)
    expect(await told('emp1', 'You are confirmed')).toHaveLength(1)
    expect((await step('hrA', emp.emp1, 'confirm', { confirmedOn: today })).status).toBe(409)
    expect((await step('hrA', emp.emp1, 'probation', { probationEndDate: addCalendarDays(today, 50), note: 'Too late now' })).status).toBe(409)
    const list = await get('hrA', `/api/employees/${emp.emp1}`)
    expect(list.body.data.lifecycle_stage).toBe('confirmed')
  })
})

describe('transfers and promotions', () => {
  it('moves somebody to another department, and leaves the company tree to the Super Admin', async () => {
    expect((await step('hrA', emp.emp3, 'transfer', { departmentId: sales, effectiveDate: today })).status).toBe(400)
    const early = await step('hrA', emp.emp3, 'transfer', { departmentId: support, effectiveDate: '2023-12-01' })
    expect(early.status).toBe(400)
    expect(early.body.error.message).toMatch(/cannot be before emp3 Person joined/)

    const res = await step('hrA', emp.emp3, 'transfer', { departmentId: support, effectiveDate: today, note: 'Support needs people' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.department_id).toBe(support)
    expect(res.body.data.history[0]).toMatchObject({ kind: 'transferred', details: { fromDepartment: 'Sales', toDepartment: 'Support' } })
    expect(await told('emp3', 'You have been transferred')).toHaveLength(1)

    const tree = await step('hrA', emp.emp3, 'transfer', { reportingManagerId: emp.adm, effectiveDate: today })
    expect(tree.status).toBe(403)
    expect(tree.body.error.message).toBe('Who somebody reports to is set by the Super Admin, on Settings → Company Tree. Ask the Super Admin to move them.')

    const moved = await step('boss', emp.emp3, 'transfer', { reportingManagerId: emp.adm, effectiveDate: today })
    expect(moved.status, JSON.stringify(moved.body)).toBe(200)
    expect(moved.body.data.history[0].details).toMatchObject({ fromManager: 'mgrM Person', toManager: 'adm Person' })
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.emp3 } })).reportingManagerId).toBe(emp.adm)
    expect((await step('boss', emp.emp3, 'transfer', { reportingManagerId: emp.mgrM, effectiveDate: today })).status).toBe(200)
  })

  it('promotes to another designation', async () => {
    expect((await step('hrA', emp.emp3, 'promote', { designationId: executive, effectiveDate: today })).status).toBe(400)
    const res = await step('hrA', emp.emp3, 'promote', { designationId: lead, effectiveDate: today, note: 'Well earned' })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.designation_id).toBe(lead)
    expect(res.body.data.history[0]).toMatchObject({ kind: 'promoted', details: { fromDesignation: 'Executive', toDesignation: 'Team Lead' } })
    expect(await told('emp3', 'Congratulations on your promotion')).toHaveLength(1)
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'lifecycle.promoted' } })).toBe(1)
  })
})

describe('a resignation', () => {
  let rid = ''

  it('is the employee’s own to hand in, with the notice period as the day asked for', async () => {
    const me = await get('emp2', '/api/lifecycle/me')
    expect(me.status).toBe(200)
    expect(me.body.data.may).toMatchObject({ resign: true, withdraw: false, transfer: false })

    expect((await post('emp2', '/api/lifecycle/resignations', { reason: 'x' })).status).toBe(422)
    const past = await post('emp2', '/api/lifecycle/resignations', { reason: 'Moving cities', requestedLastDay: addCalendarDays(today, -2) })
    expect(past.status).toBe(400)
    const res = await post('emp2', '/api/lifecycle/resignations', { reason: 'Moving cities' })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect(res.body.data.stage).toBe('resigned')
    expect(res.body.data.resignation).toMatchObject({ status: 'submitted', requested_last_day: addCalendarDays(today, 30), on_behalf: false, decided_by_whom: 'mgrM Person' })
    expect(res.body.data.may).toMatchObject({ resign: false, withdraw: true })
    rid = res.body.data.resignation.id

    const again = await post('emp2', '/api/lifecycle/resignations', { reason: 'Moving cities' })
    expect(again.status).toBe(409)
    expect(again.body.error.message).toBe('You have already resigned.')
    // The person they report to, and HR.
    expect(await told('mgrM', 'A resignation')).toHaveLength(1)
    expect(await told('hrA', 'A resignation')).toHaveLength(1)
    expect(await told('emp2', 'A resignation')).toHaveLength(0)
  })

  it('is accepted by the person they report to — not HR, and not themselves', async () => {
    const waiting = await get('mgrM', '/api/lifecycle/resignations/waiting')
    expect(waiting.body.data).toEqual([expect.objectContaining({ id: rid, full_name: 'emp2 Person', requested_last_day: addCalendarDays(today, 30) })])
    expect((await get('hrA', '/api/lifecycle/resignations/waiting')).body.data).toEqual([])

    const hr = await post('hrA', `/api/lifecycle/resignations/${rid}/accept`, { lastWorkingDay: addCalendarDays(today, 20) })
    expect(hr.status).toBe(403)
    expect(hr.body.error.message).toBe('This resignation is accepted by mgrM Person, the person they report to in the company tree.')
    const own = await post('emp2', `/api/lifecycle/resignations/${rid}/accept`, { lastWorkingDay: addCalendarDays(today, 20) })
    expect(own.status).toBe(403)
    expect((await post('emp3', `/api/lifecycle/resignations/${rid}/accept`, { lastWorkingDay: today })).status).toBe(404)
    expect((await post('mgrM', `/api/lifecycle/resignations/${rid}/accept`, { lastWorkingDay: addCalendarDays(today, -1) })).status).toBe(400)

    const view = await of('mgrM', emp.emp2)
    expect(view.body.data.may.accept_resignation).toBe(true)
    expect((await of('hrA', emp.emp2)).body.data.may.accept_resignation).toBe(false)
  })

  it('is not announced to the rest of the directory before it is accepted', async () => {
    // Admin reads every employee record, and is neither HR nor the person they report to.
    const admin = (await of('adm', emp.emp2)).body.data
    expect(admin).toMatchObject({ stage: 'confirmed', detailed: false, resignation: null, history: [], onboarding: null })
    expect((await get('adm', `/api/employees/${emp.emp2}`)).body.data.lifecycle_stage).toBe('confirmed')
    // The person they report to, and HR, see it.
    expect((await get('mgrM', `/api/employees/${emp.emp2}`)).body.data.lifecycle_stage).toBe('resigned')
    expect((await get('hrA', `/api/employees/${emp.emp2}`)).body.data.lifecycle_stage).toBe('resigned')
    expect((await of('mgrM', emp.emp2)).body.data.detailed).toBe(true)
    // Nor is its last working day set around it on the employee record.
    const edit = await request(app).patch(`/api/employees/${emp.emp2}`).set('Authorization', as('hrA')).send({ lastWorkingDate: addCalendarDays(today, 40) })
    expect(edit.status).toBe(409)
    expect(edit.body.error.message).toBe('emp2 Person\'s last working day comes from their resignation. Change it there: call the resignation off, or complete the exit.')
  })

  it('can be withdrawn before it is accepted, and handed in again', async () => {
    expect((await post('emp1', `/api/lifecycle/resignations/${rid}/withdraw`)).status).toBe(404)
    expect((await post('emp2', `/api/lifecycle/resignations/${rid}/withdraw`)).status).toBe(204)
    // Whoever was told it was handed in is told it is taken back.
    expect(await told('mgrM', 'Resignation withdrawn')).toHaveLength(1)
    expect(await told('hrA', 'Resignation withdrawn')).toHaveLength(1)
    const me = await get('emp2', '/api/lifecycle/me')
    expect(me.body.data.stage).toBe('confirmed')
    expect(me.body.data.resignation.status).toBe('withdrawn')

    const res = await post('emp2', '/api/lifecycle/resignations', { reason: 'Moving cities after all', requestedLastDay: addCalendarDays(today, 25) })
    expect(res.status).toBe(201)
    rid = res.body.data.resignation.id
  })

  it('once accepted sets the last working day, and can no longer be withdrawn', async () => {
    const res = await post('mgrM', `/api/lifecycle/resignations/${rid}/accept`, { lastWorkingDay: addCalendarDays(today, 20), note: 'Thank you' })
    expect(res.status, JSON.stringify(res.body)).toBe(204)
    const view = await of('hrA', emp.emp2)
    expect(view.body.data.stage).toBe('notice_period')
    expect(view.body.data.last_working_date).toBe(addCalendarDays(today, 20))
    expect(view.body.data.resignation).toMatchObject({ status: 'accepted', decided_by: 'mgrM Person', last_working_day: addCalendarDays(today, 20) })
    // The exit can still be completed before the last working day — relieving them early.
    expect(view.body.data.may).toMatchObject({ exit: true, exit_from: addCalendarDays(today, 20) })
    // Once accepted, it is known: the whole directory sees them serving notice.
    expect((await get('adm', `/api/employees/${emp.emp2}`)).body.data.lifecycle_stage).toBe('notice_period')
    expect(await told('emp2', 'Resignation accepted')).toHaveLength(1)
    expect((await post('mgrM', `/api/lifecycle/resignations/${rid}/accept`, { lastWorkingDay: addCalendarDays(today, 20) })).status).toBe(409)

    const late = await post('emp2', `/api/lifecycle/resignations/${rid}/withdraw`)
    expect(late.status).toBe(409)
    expect(late.body.error.message).toMatch(/already been accepted/)
    expect((await get('hrA', `/api/employees/${emp.emp2}`)).body.data.lifecycle_stage).toBe('notice_period')
  })

  it('refuses leave past the last working day', async () => {
    const from = addCalendarDays(today, 22)
    const res = await post('emp2', '/api/leave-requests/preview', { leaveTypeId: clId, fromDate: from, toDate: from })
    expect(res.status).toBe(200)
    expect(res.body.data.problem).toMatchObject({ reason: 'outside_employment' })
  })

  it('recorded by HR for somebody else, then called off by HR — and called off after acceptance clears the last day', async () => {
    const res = await step('hrA', emp.emp3, 'resignation', { reason: 'Letter handed in', submittedOn: addCalendarDays(today, -2) })
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(res.body.data.resignation).toMatchObject({ status: 'submitted', on_behalf: true, submitted_by: 'hrA Person', requested_last_day: addCalendarDays(today, 28) })
    expect(await told('emp3', 'A resignation')).toHaveLength(1)
    const first = res.body.data.resignation.id as string

    expect((await post('emp3', `/api/lifecycle/resignations/${first}/cancel`, { note: 'Staying on' })).status).toBe(403)
    expect((await post('hrA', `/api/lifecycle/resignations/${first}/cancel`, {})).status).toBe(422)
    expect((await post('hrA', `/api/lifecycle/resignations/${first}/cancel`, { note: 'Staying on' })).status).toBe(204)
    expect((await of('hrA', emp.emp3)).body.data.stage).toBe('confirmed')
    expect(await told('emp3', 'Resignation called off')).toHaveLength(1)

    const again = await post('emp3', '/api/lifecycle/resignations', { reason: 'Leaving for studies' })
    const second = again.body.data.resignation.id as string
    expect((await post('mgrM', `/api/lifecycle/resignations/${second}/accept`, { lastWorkingDay: addCalendarDays(today, 15) })).status).toBe(204)
    expect((await of('hrA', emp.emp3)).body.data.last_working_date).toBe(addCalendarDays(today, 15))
    expect((await post('mgrM', `/api/lifecycle/resignations/${second}/cancel`, { note: 'Changed their mind' })).status).toBe(204)
    const after = await of('hrA', emp.emp3)
    expect(after.body.data.stage).toBe('confirmed')
    expect(after.body.data.last_working_date).toBeNull()
    expect((await post('mgrM', `/api/lifecycle/resignations/${second}/cancel`, { note: 'Changed their mind' })).status).toBe(409)
  })

  it('accepted, settles the leave after the last working day: waiting cancelled, approved given back, across it refused', async () => {
    // Not a Sunday, so each is a day of leave.
    const workday = (offset: number) => { let d = addCalendarDays(today, offset); while (new Date(`${d}T00:00:00Z`).getUTCDay() === 0) d = addCalendarDays(d, 1); return d }
    const yearOf = (d: string) => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1)
    for (const leaveYear of new Set([yearOf(today), yearOf(addCalendarDays(today, 40))])) {
      await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp.emp3, leaveTypeId: clId, leaveYear, days: 12, reason: 'opening_grant' } })
    }
    const balance = async () => Number((await prisma.leaveLedgerEntry.aggregate({ where: { employeeId: emp.emp3, leaveTypeId: clId }, _sum: { days: true } }))._sum.days)
    const applyFor = async (from: string, to: string) => {
      const res = await post('emp3', '/api/leave-requests', { leaveTypeId: clId, fromDate: from, toDate: to, reason: 'Before I go' })
      expect(res.status, JSON.stringify(res.body)).toBe(201)
      return res.body.data.id as string
    }
    const approved = await applyFor(workday(24), workday(24))
    expect((await post('mgrM', `/api/leave-requests/${approved}/approve`, {})).status).toBe(200)
    const waiting = await applyFor(workday(27), workday(27))
    const across = await applyFor(workday(12), workday(19))
    const before = await balance()

    const resigned = await post('emp3', '/api/lifecycle/resignations', { reason: 'Leaving for studies' })
    const lastDay = workday(15)
    expect((await post('mgrM', `/api/lifecycle/resignations/${resigned.body.data.resignation.id}/accept`, { lastWorkingDay: lastDay })).status).toBe(204)

    const status = async (id: string) => (await prisma.leaveRequest.findUniqueOrThrow({ where: { id } })).status
    expect(await status(waiting)).toBe('cancelled')
    expect(await status(approved)).toBe('cancelled')
    // The approved day comes back to the balance.
    expect(await balance()).toBe(before + 1)
    // Across the last day: left to its approver, who cannot approve it.
    expect(await status(across)).toBe('pending')
    const refused = await post('mgrM', `/api/leave-requests/${across}/approve`, {})
    expect(refused.status).toBe(409)
    expect(refused.body.error.message).toMatch(/runs past the last working day/)

    // Leave them as the tests after this expect: staying on.
    expect((await post('mgrM', `/api/leave-requests/${across}/reject`, { note: 'Past your last day' })).status).toBe(200)
    expect((await post('mgrM', `/api/lifecycle/resignations/${resigned.body.data.resignation.id}/cancel`, { note: 'Staying on' })).status).toBe(204)
  })
})

describe('the owner', () => {
  it('hands in no resignation: nobody is above them to accept it', async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: emp.boss } })
    expect((await get('boss', '/api/lifecycle/me')).body.data.may.resign).toBe(false)
    const res = await post('boss', '/api/lifecycle/resignations', { reason: 'Stepping down' })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/^The company owner does not hand in a resignation/)
    await prisma.organization.update({ where: { id: orgId }, data: { ownerEmployeeId: null } })
  })
})

describe('the employee export', () => {
  it('has a Stage column, and the Stage filter the list applies', async () => {
    const res = await request(app).get('/api/employees/export?stage=notice_period').set('Authorization', as('hrA')).buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = []
      r.on('data', (c: Buffer) => chunks.push(c))
      r.on('end', () => cb(null, Buffer.concat(chunks)))
    })
    expect(res.status).toBe(200)
    const lines = (res.body as Buffer).toString('utf8').replace(/^\uFEFF/, '').trim().split(/\r?\n/)
    expect(lines[0]).toContain(',Stage,Status')
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('emp2 Person')
    expect(lines[1]).toContain('Serving notice')
  })
})

describe('the exit', () => {
  it('waits for the last working day, and is refused for logins HR may not manage', async () => {
    const ahead = await step('hrA', emp.emp2, 'exit', { reason: 'resigned', lastWorkingDate: addCalendarDays(today, 20) })
    expect(ahead.status).toBe(400)
    expect(ahead.body.error.message).toMatch(/cannot be later than today/)

    const accounts = await step('hrA', emp.acct, 'exit', { reason: 'terminated', lastWorkingDate: today })
    expect(accounts.status).toBe(403)
    expect(accounts.body.error.message).toBe('You can switch off only the logins of people whose role is below yours.')
    const above = await step('hrA', emp.mgrM, 'exit', { reason: 'terminated', lastWorkingDate: today })
    expect(above.status).toBe(403)
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.mgrM } })).archivedAt).toBeNull()
    expect((await prisma.employee.findUniqueOrThrow({ where: { id: emp.acct } })).archivedAt).toBeNull()
    // Nor is the button offered for them; the Super Admin's is.
    expect((await of('hrA', emp.acct)).body.data.may).toMatchObject({ exit: false, exit_from: null, transfer: true })
    expect((await of('hrA', emp.mgrM)).body.data.may.exit).toBe(false)
    expect((await of('boss', emp.acct)).body.data.may.exit).toBe(true)
  })

  it('closes every login, archives the record, completes the resignation, and pays the last month', async () => {
    const refreshBefore = await prisma.refreshToken.count({ where: { userId: users.emp2, revokedAt: null } })
    expect(refreshBefore).toBeGreaterThan(0)

    const res = await step('hrA', emp.emp2, 'exit', { reason: 'resigned', lastWorkingDate: today, note: 'Relieved early' })
    expect(res.status, JSON.stringify(res.body)).toBe(204)

    const row = await prisma.employee.findUniqueOrThrow({ where: { id: emp.emp2 } })
    expect(row.status).toBe('inactive')
    expect(row.archivedAt).not.toBeNull()
    expect(row.exitReason).toBe('resigned')
    expect(fromDateColumn(row.lastWorkingDate)).toBe(today)
    expect((await prisma.membership.findMany({ where: { employeeId: emp.emp2 } })).every((m) => m.status === 'inactive')).toBe(true)
    expect(await prisma.refreshToken.count({ where: { userId: users.emp2, revokedAt: null } })).toBe(0)
    expect((await prisma.resignation.findMany({ where: { employeeId: emp.emp2, status: { in: ['submitted', 'accepted'] } } }))).toHaveLength(0)
    expect(await prisma.resignation.count({ where: { employeeId: emp.emp2, status: 'completed' } })).toBe(1)

    const login = await request(app).post('/api/auth/login').send({ identifier: email('emp2'), password: PASSWORD })
    expect(login.status).not.toBe(200)

    const view = await of('hrA', emp.emp2)
    expect(view.body.data.stage).toBe('left')
    expect(view.body.data.history[0]).toMatchObject({ kind: 'exited', note: 'Relieved early', details: { reason: 'resigned', loginsClosed: 1 } })
    expect(Object.entries(view.body.data.may).filter(([k, v]) => k !== 'exit_from' && v === true)).toEqual([])
    expect((await step('hrA', emp.emp2, 'exit', { reason: 'resigned', lastWorkingDate: today })).status).toBe(409)

    // Paid for this month, to the last working day.
    const [year, month] = today.split('-').map(Number) as [number, number]
    const monthStart = toDateColumn(`${year}-${String(month).padStart(2, '0')}-01`)
    const monthEnd = new Date(Date.UTC(year, month, 0))
    const paid = await employeesForMonth(forOrg(orgId), monthStart, monthEnd)
    expect(paid.map((p) => p.id)).toContain(emp.emp2)
    const next = await employeesForMonth(forOrg(orgId), new Date(Date.UTC(year, month, 1)), new Date(Date.UTC(year, month + 1, 0)))
    expect(next.map((p) => p.id)).not.toContain(emp.emp2)
  })
})

describe('removing somebody from Settings → Users', () => {
  it('keeps what an approved payroll paid: the last working day stays, and the history says why', async () => {
    const hire = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-rem2`, fullName: 'Removed Later', dateOfJoining: '2025-02-03', confirmedOn: '2025-08-04', login: { email: email('rem2'), role: 'employee' } })
    const id = hire.body.data.id as string
    const [year, month] = today.split('-').map(Number) as [number, number]
    const run = await prisma.payrollRun.create({
      data: {
        organizationId: orgId, year, month, status: 'approved', lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 0,
        grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0, calculatedAt: new Date(),
      },
    })
    const membership = await prisma.membership.findFirstOrThrow({ where: { employeeId: id } })
    expect((await request(app).delete(`/api/users/${membership.id}`).set('Authorization', as('boss'))).status).toBe(204)
    await prisma.payrollRun.delete({ where: { id: run.id } })
    const row = await prisma.employee.findUniqueOrThrow({ where: { id } })
    expect(row.archivedAt).not.toBeNull()
    expect(row.lastWorkingDate).toBeNull()
    expect((await of('hrA', id)).body.data.history[0].details).toMatchObject({ via: 'access_removed', payrollClosed: true })
  })

  it('leaves as the exit leaves: inactive, paid to today, history and resignation closed', async () => {
    const hire = await post('hrA', '/api/employees', { employeeCode: `${PREFIX}-rem1`, fullName: 'Removed Person', dateOfJoining: '2025-02-03', confirmedOn: '2025-08-04', login: { email: email('rem1'), role: 'employee' } })
    expect(hire.status, JSON.stringify(hire.body)).toBe(201)
    const id = hire.body.data.id as string
    const membership = await prisma.membership.findFirstOrThrow({ where: { employeeId: id } })
    expect((await request(app).delete(`/api/users/${membership.id}`).set('Authorization', as('boss'))).status).toBe(204)
    const row = await prisma.employee.findUniqueOrThrow({ where: { id } })
    expect(row.status).toBe('inactive')
    expect(row.archivedAt).not.toBeNull()
    expect(fromDateColumn(row.lastWorkingDate)).toBe(today)
    expect((await of('hrA', id)).body.data).toMatchObject({ stage: 'left', history: [expect.objectContaining({ kind: 'exited', details: expect.objectContaining({ via: 'access_removed', lastWorkingDate: today }) })] })
  })
})

describe('attendance follows the lifecycle', () => {
  it('opens check-in on the joining day and closes it after the last working day', async () => {
    const early = await post('soon', '/api/attendance/punch-in', {})
    expect(early.status).toBe(403)
    expect(early.body.error.message).toMatch(/^You join on .+\. Checking in opens on your first day\.$/)
    const late = await post('gone', '/api/attendance/punch-in', {})
    expect(late.status).toBe(403)
    expect(late.body.error.message).toMatch(/^Your last working day was .+, so there is nothing to check in to\.$/)
    expect((await post('emp1', '/api/attendance/punch-in', {})).status).toBe(201)
  })

  it('refuses leave before the joining day', async () => {
    const res = await post('soon', '/api/leave-requests/preview', { leaveTypeId: clId, fromDate: addCalendarDays(today, 1), toDate: addCalendarDays(today, 1) })
    expect(res.status).toBe(200)
    expect(res.body.data.problem).toMatchObject({ reason: 'outside_employment' })
  })
})

describe('somebody past their last working day', () => {
  it('is HR’s to exit, from that day', async () => {
    const view = await of('hrA', emp.gone)
    expect(view.body.data.stage).toBe('exit_due')
    expect(view.body.data.may.exit).toBe(true)
    const res = await step('hrA', emp.gone, 'exit', { reason: 'contract_ended', lastWorkingDate: addCalendarDays(today, -1) })
    expect(res.status, JSON.stringify(res.body)).toBe(204)
    expect((await get('hrA', '/api/lifecycle/summary')).body.data.exit_due).toEqual([])
  })
})
