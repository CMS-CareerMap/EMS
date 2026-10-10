import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { forOrg } from '../../platform/db/scoped'
import { hashPassword } from '../../platform/auth/password'
import { addCalendarDays, fromDateColumn, toDateColumn, zonedToday } from '../../domain/shared/dates'
import { leaveYearBounds } from '../../domain/leave/grant'
import { remindLeaveYearEnd } from './leaveEntitlement.service'

/**
 * Leave, seen and used day to day (client, 10 Oct 2026):
 *   A  one's own month in pay terms on Attendance — leave by type, paid and unpaid days;
 *   B  a leave type's statement, like a passbook;
 *   C  the year-end reminder of days that will lapse;
 *   D  an absent day: told, offered "apply leave", and turned to leave once approved;
 *   E  who else of the team is away, beside a request waiting to be decided.
 */

const PREFIX = 'lxtrtest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

const today = zonedToday(new Date(), 'Asia/Kolkata')
const YEAR = Number(today.slice(0, 4)) - (Number(today.slice(5, 7)) >= 4 ? 0 : 1)

/** A Monday about three weeks back, with its Thursday in the same month — days already past, in reach of an application. */
function pastMonday(): string {
  let day = addCalendarDays(today, -21)
  while (new Date(`${day}T00:00:00Z`).getUTCDay() !== 1) day = addCalendarDays(day, -1)
  if (addCalendarDays(day, 3).slice(0, 7) !== day.slice(0, 7)) day = addCalendarDays(day, -7)
  return day
}
const MON = pastMonday()
const [TUE, WED, THU] = [1, 2, 3].map((n) => addCalendarDays(MON, n)) as [string, string, string]
const yearOf = (day: string) => Number(day.slice(0, 4)) - (Number(day.slice(5, 7)) >= 4 ? 0 : 1)

let orgId = ''
const type: Record<string, string> = {}
const tokens: Record<string, string> = {}
const users: Record<string, string> = {}
const emp: Record<string, string> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.updateMany({ where: org, data: { reportingManagerId: null } })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function person(key: string, options: { role?: string; reportsTo?: string } = {}) {
  let membershipId: string | null = null
  if (options.role) {
    const user = await prisma.user.create({ data: { email: `${PREFIX}-${key}@example.com`, passwordHash: await hashPassword(PASSWORD) } })
    users[key] = user.id
    membershipId = (await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: options.role, status: 'active' } })).id
  }
  const e = await prisma.employee.create({
    data: {
      organizationId: orgId,
      ...(membershipId ? { memberships: { connect: { id: membershipId } } } : {}),
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key[0]!.toUpperCase()}${key.slice(1)} Test`,
      dateOfJoining: toDateColumn('2020-01-06'),
      onboardedOn: toDateColumn('2020-01-06'),
      confirmedOn: toDateColumn('2020-01-06'),
      reportingManagerId: options.reportsTo ?? null,
    },
  })
  emp[key] = e.id
  if (options.role) tokens[key] = (await request(app).post('/api/auth/login').send({ identifier: `${PREFIX}-${key}@example.com`, password: PASSWORD })).body.data.accessToken
  // The year's leave, for the days used here and today's year alike.
  for (const leaveYear of new Set([YEAR, yearOf(MON)])) {
    await prisma.leaveLedgerEntry.createMany({ data: [
      { organizationId: orgId, employeeId: e.id, leaveTypeId: type.CL!, leaveYear, days: 12, reason: 'opening_grant' },
      { organizationId: orgId, employeeId: e.id, leaveTypeId: type.EL!, leaveYear, days: 15, reason: 'opening_grant' },
    ] })
  }
  return e.id
}

const as = (key: string) => `Bearer ${tokens[key]}`
const get = (key: string, path: string) => request(app).get(`/api${path}`).set('Authorization', as(key))
const send = (key: string, method: 'post' | 'put' | 'delete', path: string, body: object = {}) => request(app)[method](`/api${path}`).set('Authorization', as(key)).send(body)
const apply = (key: string, body: object) => send(key, 'post', '/leave-requests', { reason: 'Personal work', ...body })

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01'), leaveYearStartMonth: 4, weeklyOffDays: [0] } })
  type.CL = (await prisma.leaveType.create({ data: { organizationId: orgId, code: 'CL', name: 'Casual Leave', annualQuota: 12 } })).id
  type.EL = (await prisma.leaveType.create({ data: { organizationId: orgId, code: 'EL', name: 'Earned Leave', annualQuota: 15, carryForward: true, carryForwardCap: 10 } })).id
  type.LOP = (await prisma.leaveType.create({ data: { organizationId: orgId, code: 'LOP', name: 'Loss of Pay', annualQuota: 0, isPaid: false } })).id

  await person('boss', { role: 'super_admin' })
  await person('hema', { role: 'hr' })
  const manoj = await person('manoj', { role: 'manager' })
  await person('priya', { role: 'employee', reportsTo: manoj })
  await person('sunil', { role: 'employee', reportsTo: manoj })
  await person('ravi', { role: 'employee', reportsTo: manoj })
})

afterAll(cleanup)

describe('D — an absent day: told, offered leave, and leave once approved', () => {
  it('tells the person when a day is marked absent — once, with the way to apply leave for it', async () => {
    const marked = await send('hema', 'post', '/attendance/mark', { employeeId: emp.priya, date: THU, status: 'absent' })
    expect(marked.status, JSON.stringify(marked.body)).toBe(201)
    const told = await prisma.notification.findMany({ where: { userId: users.priya, event: 'attendance.absent' } })
    expect(told).toHaveLength(1)
    expect(told[0]!.link).toBe(`/leave?apply=1&from=${THU}&to=${THU}`)
    expect(told[0]!.message).toMatch(/An absent day is cut from pay\. If you were on leave, apply for it/)
    // Marked absent again: nothing new to tell.
    await send('hema', 'post', '/attendance/mark', { employeeId: emp.priya, date: THU, status: 'absent', note: 'Again' })
    expect(await prisma.notification.count({ where: { userId: users.priya, event: 'attendance.absent' } })).toBe(1)
  })

  it('tells each person once for a machine file with absent days', async () => {
    const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
    const csv = ['employee_id,date,in_time,out_time', `${PREFIX}-ravi,${dmy(MON)},,`, `${PREFIX}-ravi,${dmy(TUE)},,`, `${PREFIX}-sunil,${dmy(MON)},09:30,18:30`].join('\n')
    const res = await request(app).post('/api/attendance/import').set('Authorization', as('hema')).send({ csv, dryRun: false })
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201)
    const told = await prisma.notification.findMany({ where: { userId: users.ravi, event: 'attendance.absent' } })
    expect(told.map((n) => n.title)).toEqual(['Marked absent on 2 days'])
    expect(await prisma.notification.count({ where: { userId: users.sunil, event: 'attendance.absent' } })).toBe(0)
  })

  it('turns an unpunched absent day into the leave once approved — and back when reversed', async () => {
    const res = await apply('priya', { leaveTypeId: type.CL, fromDate: THU, toDate: THU })
    expect(res.status, JSON.stringify(res.body)).toBe(201)
    expect((await send('manoj', 'post', `/leave-requests/${res.body.data.id}/approve`)).status).toBe(200)
    const day = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.priya, date: toDateColumn(THU) } })
    expect([day.status, day.source, day.statusBeforeLeave, day.sourceBeforeLeave]).toEqual(['on_leave', 'leave', 'absent', 'manual'])

    expect((await send('manoj', 'post', `/leave-requests/${res.body.data.id}/reverse`)).status).toBe(200)
    const back = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.priya, date: toDateColumn(THU) } })
    expect([back.status, back.source, back.statusBeforeLeave]).toEqual(['absent', 'manual', null])

    // Taken again, for what follows.
    const again = await apply('priya', { leaveTypeId: type.CL, fromDate: THU, toDate: THU })
    expect((await send('manoj', 'post', `/leave-requests/${again.body.data.id}/approve`)).status).toBe(200)
  })

  it('takes the next machine file of the month with the day in it blank: the leave stands', async () => {
    const dmy = (day: string) => `${day.slice(8, 10)}/${day.slice(5, 7)}/${day.slice(0, 4)}`
    // Priya's Thursday is her leave now (above); the month's file comes again, with it blank.
    const csv = ['employee_id,date,in_time,out_time', `${PREFIX}-priya,${dmy(THU)},,`, `${PREFIX}-sunil,${dmy(TUE)},09:30,18:30`].join('\n')
    const res = await request(app).post('/api/attendance/import').set('Authorization', as('hema')).send({ csv, dryRun: false })
    expect(res.status, JSON.stringify(res.body).slice(0, 400)).toBe(201)
    expect(res.body.data.summary).toMatchObject({ total_rows: 2, valid: 1, invalid: 0, on_leave: 1, imported: 1 })
    const day = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.priya, date: toDateColumn(THU) } })
    expect([day.status, day.statusBeforeLeave]).toEqual(['on_leave', 'absent'])
    // A punch on it is still refused: it would charge the leave for a day worked.
    const punched = await request(app).post('/api/attendance/import').set('Authorization', as('hema'))
      .send({ csv: ['employee_id,date,in_time,out_time', `${PREFIX}-priya,${dmy(THU)},09:30,18:30`].join('\n'), dryRun: true })
    expect(punched.body.data.rows[0].issues[0].message).toMatch(/has approved leave on/)
  })

  it('tells only the logins leave is applied for from — not a login that cannot apply', async () => {
    await person('asha', { role: 'accounts' })
    const marked = await send('hema', 'post', '/attendance/mark', { employeeId: emp.asha, date: MON, status: 'absent' })
    expect(marked.status, JSON.stringify(marked.body)).toBe(201)
    expect(await prisma.notification.count({ where: { userId: users.asha, event: 'attendance.absent' } })).toBe(0)
  })

  it('never takes over a day with a punch on it', async () => {
    await send('hema', 'post', '/attendance/mark', { employeeId: emp.sunil, date: WED, status: 'present', checkIn: '09:30', checkOut: '11:00' })
    const marked = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.sunil, date: toDateColumn(WED) } })
    const res = await apply('sunil', { leaveTypeId: type.CL, fromDate: WED, toDate: WED })
    expect((await send('manoj', 'post', `/leave-requests/${res.body.data.id}/approve`)).status).toBe(200)
    const day = await prisma.attendance.findFirstOrThrow({ where: { employeeId: emp.sunil, date: toDateColumn(WED) } })
    expect([day.id, day.status, day.statusBeforeLeave]).toEqual([marked.id, marked.status, null])
  })
})

describe('A — one’s own month in pay terms', () => {
  it('names each leave day by its type, counts paid and unpaid days as payroll does, and offers leave for absent days', async () => {
    // Tuesday and Wednesday as Loss of Pay; Thursday is Casual Leave (above); Ravi has two absent days.
    const lop = await apply('priya', { leaveTypeId: type.LOP, fromDate: TUE, toDate: WED })
    expect((await send('manoj', 'post', `/leave-requests/${lop.body.data.id}/approve`)).status).toBe(200)

    const [year, month] = MON.split('-').map(Number) as [number, number]
    const res = await get('priya', `/attendance/me/pay-days?year=${year}&month=${month}`)
    expect(res.status).toBe(200)
    const d = res.body.data
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    expect(d).toMatchObject({ employed: true, unpaid_days: 2, paid_days: daysInMonth - 2, employment_days: daysInMonth })
    expect(d.leave_days.map((l: { date: string; leave_type_name: string; paid: boolean }) => `${l.date}:${l.leave_type_name}:${l.paid}`)).toEqual([
      `${TUE}:Loss of Pay:false`, `${WED}:Loss of Pay:false`, `${THU}:Casual Leave:true`,
    ])
    expect(d.absent_days).toEqual([])

    // Ravi: two absent days, each with the way to apply leave for it — until he does. A Sunday
    // marked absent costs nothing and counts no leave: not offered.
    const SUN = addCalendarDays(MON, 6).slice(0, 7) === MON.slice(0, 7) ? addCalendarDays(MON, 6) : addCalendarDays(MON, -1)
    expect((await send('hema', 'post', '/attendance/mark', { employeeId: emp.ravi, date: SUN, status: 'absent' })).status).toBe(201)
    const ravi = (await get('ravi', `/attendance/me/pay-days?year=${year}&month=${month}`)).body.data
    expect(ravi.unpaid_days).toBe(2)
    expect(ravi.absent_days).toEqual([
      { date: MON, applied: false, leave: null, can_apply: true, why: null },
      { date: TUE, applied: false, leave: null, can_apply: true, why: null },
    ])
    // Only the month's own payroll closes it: a later month approved does not.
    const later = month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
    const run = await prisma.payrollRun.create({ data: {
      organizationId: orgId, ...later, status: 'approved', lopBasis: 'calendar_days', sandwichRule: false,
      employeeCount: 0, grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0, calculatedAt: new Date(),
    } })
    try {
      const open = (await get('ravi', `/attendance/me/pay-days?year=${year}&month=${month}`)).body.data
      expect(open.absent_days.map((a: { can_apply: boolean }) => a.can_apply)).toEqual([true, true])
    } finally {
      await prisma.payrollRun.delete({ where: { id: run.id } })
    }
    expect((await apply('ravi', { leaveTypeId: type.CL, fromDate: MON, toDate: MON })).status).toBe(201)
    const after = (await get('ravi', `/attendance/me/pay-days?year=${year}&month=${month}`)).body.data
    expect(after.absent_days[0]).toMatchObject({ date: MON, applied: true, can_apply: false, leave: { status: 'pending', leave_type_name: 'Casual Leave', half: false } })
  })

  it('is one’s own only, and refuses a month that is not a month', async () => {
    expect((await get('priya', `/attendance/me/pay-days?year=2026&month=13`)).status).toBe(422)
    expect((await get('priya', `/attendance/me/pay-days?year=2026&month=10&employeeId=${emp.ravi}`)).status).toBe(422)
  })
})

describe('B — a leave type’s statement', () => {
  it('lists every movement, oldest first, with the balance after each', async () => {
    const leaveYear = yearOf(MON)
    const res = await get('priya', `/leave-requests/statement?leaveTypeId=${type.CL}&leaveYear=${leaveYear}`)
    expect(res.status).toBe(200)
    const s = res.body.data
    expect(s.lines.map((l: { reason: string; days: number; balance: number }) => `${l.reason}:${l.days}:${l.balance}`)).toEqual([
      'opening_grant:12:12', 'consumed:-1:11', 'reversal:1:12', 'consumed:-1:11',
    ])
    expect(s.lines[1]).toMatchObject({ from_date: THU, to_date: THU })
    expect(s).toMatchObject({ code: 'CL', balance: 11, taken: 1, unlimited: false })

    const lop = (await get('priya', `/leave-requests/statement?leaveTypeId=${type.LOP}&leaveYear=${leaveYear}`)).body.data
    expect([lop.unlimited, lop.balance, lop.taken, lop.lines.length]).toEqual([true, -2, 2, 1])
  })

  it('reads a type as limited for somebody with their own days of it, as Leave Balance does', async () => {
    await prisma.employeeLeaveEntitlement.create({ data: { organizationId: orgId, employeeId: emp.sunil!, leaveTypeId: type.LOP!, annualQuota: 5 } })
    try {
      const own = (await get('sunil', `/leave-requests/statement?leaveTypeId=${type.LOP}&leaveYear=${yearOf(MON)}`)).body.data
      expect(own.unlimited).toBe(false)
      const card = (await get('sunil', '/leave-requests/balances')).body.data.balances.find((b: { code: string }) => b.code === 'LOP')
      expect(card.unlimited).toBe(false)
    } finally {
      await prisma.employeeLeaveEntitlement.deleteMany({ where: { employeeId: emp.sunil!, leaveTypeId: type.LOP! } })
    }
  })

  it('is shown to HR on the profile, and to nobody else', async () => {
    const hr = await get('hema', `/leave-balances/people/${emp.priya}/statement?leaveTypeId=${type.CL}&leaveYear=${yearOf(MON)}`)
    expect(hr.status).toBe(200)
    expect(hr.body.data.balance).toBe(11)
    expect((await get('sunil', `/leave-requests/statement?leaveTypeId=${type.CL}&employeeId=${emp.priya}`)).status).toBe(404)
    expect((await get('manoj', `/leave-balances/people/${emp.priya}/statement?leaveTypeId=${type.CL}`)).status).toBe(403)
    // Her manager decides her leave, so sees her statement from the leave page.
    expect((await get('manoj', `/leave-requests/statement?leaveTypeId=${type.CL}&employeeId=${emp.priya}`)).status).toBe(200)
  })
})

describe('E — who else of the team is away, beside a waiting request', () => {
  it('names teammates away on those days — waiting or approved — and nobody outside them', async () => {
    const day = addCalendarDays(today, 14 + ((8 - new Date(`${addCalendarDays(today, 14)}T00:00:00Z`).getUTCDay()) % 7))
    const sunil = await apply('sunil', { leaveTypeId: type.CL, fromDate: day, toDate: addCalendarDays(day, 1) })
    expect((await send('manoj', 'post', `/leave-requests/${sunil.body.data.id}/approve`)).status).toBe(200)
    await apply('ravi', { leaveTypeId: type.CL, fromDate: addCalendarDays(day, 1), toDate: addCalendarDays(day, 1) })
    await apply('priya', { leaveTypeId: type.CL, fromDate: addCalendarDays(day, 7), toDate: addCalendarDays(day, 7) })
    const asked = await apply('priya', { leaveTypeId: type.CL, fromDate: day, toDate: day })
    expect(asked.status).toBe(201)

    const team = (await get('manoj', '/leave-requests/team')).body.data.requests
    const hers = team.find((r: { id: string }) => r.id === asked.body.data.id)
    expect(hers.team_away.map((a: { full_name: string; status: string }) => `${a.full_name}:${a.status}`)).toEqual(['Sunil Test:approved'])
    const ravis = team.find((r: { employee_id: string; from_date: string }) => r.employee_id === emp.ravi && r.from_date === addCalendarDays(day, 1))
    expect(ravis.team_away.map((a: { full_name: string }) => a.full_name)).toEqual(['Sunil Test'])
    const far = team.find((r: { employee_id: string; from_date: string }) => r.employee_id === emp.priya && r.from_date === addCalendarDays(day, 7))
    expect(far.team_away).toEqual([])
    // Not on lists of those who do not decide: nothing to weigh there.
    const own = (await get('priya', '/leave-requests')).body.data
    expect(own.every((r: { team_away: unknown }) => r.team_away === null)).toBe(true)
  })
})

describe('C — the year-end reminder', () => {
  it('is read and set by whoever sets leave types, within 1 to 90 days, and audited', async () => {
    expect((await get('hema', '/leave-balances/reminder')).body.data).toEqual({ days: 30 })
    expect((await send('hema', 'put', '/leave-balances/reminder', { days: 45 })).body.data).toEqual({ days: 45 })
    expect((await send('hema', 'put', '/leave-balances/reminder', { days: 0 })).status).toBe(422)
    expect((await send('hema', 'put', '/leave-balances/reminder', { days: 91 })).status).toBe(422)
    expect((await send('priya', 'put', '/leave-balances/reminder', { days: 10 })).status).toBe(403)
    const logged = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'leave.reminder_updated' } })
    expect(logged?.details).toMatchObject({ days: 45, before: 30 })
  })

  it('tells each person once, in the year’s last days, of what would lapse — not what carries, not unpaid leave', async () => {
    const lastDay = addCalendarDays(leaveYearBounds(YEAR, 4).nextFrom, -1)
    const db = forOrg(orgId)
    // Unpaid leave with a limit, unused: nothing lost by leaving it — never urged to be taken.
    type.LWP = (await prisma.leaveType.create({ data: { organizationId: orgId, code: 'LWP', name: 'Leave Without Pay', annualQuota: 10, isPaid: false } })).id
    await prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp.boss!, leaveTypeId: type.LWP, leaveYear: YEAR, days: 10, reason: 'opening_grant' } })
    // Too early: nothing due.
    expect((await remindLeaveYearEnd(db, orgId, { apply: true, asOf: addCalendarDays(lastDay, -60) })).due).toBe(false)
    const dry = await remindLeaveYearEnd(db, orgId, { apply: false, asOf: addCalendarDays(lastDay, -10) })
    expect(dry.due).toBe(true)
    expect(await prisma.notification.count({ where: { organizationId: orgId, event: 'leave.year_ending' } })).toBe(0)

    const sent = await remindLeaveYearEnd(db, orgId, { apply: true, asOf: addCalendarDays(lastDay, -10) })
    expect(sent.people).toBe(dry.people)
    const boss = await prisma.notification.findFirstOrThrow({ where: { userId: users.boss, event: 'leave.year_ending' } })
    // The boss: 12 days of Casual Leave left, and 15 of Earned Leave of which 10 carry.
    expect(boss.message).toContain('Casual Leave 12 days, Earned Leave 5 days (beyond the 10 days that carry)')
    expect(boss.message).not.toContain('Loss of Pay')
    expect(boss.message).not.toContain('Leave Without Pay')
    expect(boss.link).toBe('/leave?tab=balance')
    const mark = await prisma.leaveYearEndNotice.findFirstOrThrow({ where: { employeeId: emp.boss!, leaveYear: YEAR } })
    expect(Number(mark.days)).toBe(17)

    const again = await remindLeaveYearEnd(db, orgId, { apply: true, asOf: addCalendarDays(lastDay, -9) })
    expect(again.people).toBe(0)
    expect(await prisma.notification.count({ where: { userId: users.boss, event: 'leave.year_ending' } })).toBe(1)

    // Cleared from the bell: still told — not told again the next night.
    expect((await send('boss', 'delete', '/notifications')).status).toBe(200)
    const cleared = await remindLeaveYearEnd(db, orgId, { apply: true, asOf: addCalendarDays(lastDay, -8) })
    expect(cleared.people).toBe(0)
    expect(await prisma.notification.count({ where: { userId: users.boss, event: 'leave.year_ending' } })).toBe(0)
  })
})

describe('the absent alert and the reminder are settings, like every notice', () => {
  it('lists both in Settings → Notifications, to be switched off', async () => {
    const list = (await get('boss', '/notifications/settings')).body.data
    const events = list.map((e: { event: string; group: string }) => `${e.event}:${e.group}`)
    expect(events).toEqual(expect.arrayContaining(['attendance.absent:Attendance', 'leave.year_ending:Leave']))
    expect(fromDateColumn(toDateColumn(THU))).toBe(THU)
  })
})
