import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { monthRange } from './attendance.repository'
import { toDateColumn, zonedToday, fromDateColumn } from '../../domain/shared/dates'

/**
 * Attendance as HR and managers see it: lists, monthly hours, corrections and
 * the biometric import.
 *
 * The headline here is the month range. The old client built the end of a month
 * as `${year}-${month}-31`, which is not a date in February, April, June,
 * September or November — so the monthly view was BLANK FIVE MONTHS A YEAR.
 * Nobody reported that as a bug; they reported that attendance "sometimes does
 * not load", which is a far harder thing to find.
 */

const PREFIX = 'attadm'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
let shiftId = ''
let aliceId = ''
let bobId = ''
let strangerId = ''
const tokens: Record<string, string> = {}

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.attendance.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.shift.deleteMany({ where: org })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(
  key: string,
  role: 'hr' | 'manager' | 'employee',
  options: { reportsTo?: string } = {},
): Promise<string> {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  const membership = await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  const employee = await prisma.employee.create({
    data: {
      organizationId: orgId,
      memberships: { connect: { id: membership.id } },
      employeeCode: `${PREFIX}-${key}`,
      fullName: `${key} person`,
      shiftId,
      reportingManagerId: options.reportsTo ?? null,
    },
  })

  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
  return employee.id
}

const as = (key: string) => `Bearer ${tokens[key]}`
const get = (path: string, key = 'hr') =>
  request(app).get(`/api/attendance${path}`).set('Authorization', as(key))

/** Writes a day directly, so the tests do not depend on the punch flow. */
async function day(employeeId: string, date: string, hours: number, status = 'present') {
  await prisma.attendance.create({
    data: {
      organizationId: orgId,
      employeeId,
      date: toDateColumn(date),
      checkIn: new Date(`${date}T03:30:00Z`),
      checkOut: new Date(`${date}T12:30:00Z`),
      hoursWorked: hours,
      expectedHours: 9,
      status: status as 'present',
      source: 'punch',
      shiftId,
    },
  })
}

beforeAll(async () => {
  await cleanup()

  const org = await prisma.organization.create({
    data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' },
  })
  orgId = org.id

  const shift = await prisma.shift.create({
    data: {
      organizationId: orgId,
      name: 'General',
      startTime: '09:30',
      endTime: '18:30',
      breakMinutes: 60,
      expectedHours: 9,
    },
  })
  shiftId = shift.id

  await makeUser('hr', 'hr')
  const manager = await makeUser('mgr', 'manager')
  aliceId = await makeUser('alice', 'employee', { reportsTo: manager })
  bobId = await makeUser('bob', 'employee', { reportsTo: manager })
  strangerId = await makeUser('stranger', 'employee')
})

beforeEach(async () => {
  await prisma.attendance.deleteMany({ where: { organization: { name: { startsWith: PREFIX } } } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the month range — the bug that emptied five months a year', () => {
  it('covers the whole of every month, including the short ones', () => {
    // The old code wrote `${year}-${month}-31`. These five are the ones where
    // that string is not a date at all.
    for (const [month, lastDay] of [
      [2, 28],
      [4, 30],
      [6, 30],
      [9, 30],
      [11, 30],
    ] as const) {
      const { from, until } = monthRange(2026, month)

      expect(fromDateColumn(from)).toBe(`2026-${String(month).padStart(2, '0')}-01`)

      // Half-open: the last day of the month is INSIDE, the first of the next
      // is not. Correct for every month without knowing how long any of them is.
      const last = new Date(Date.UTC(2026, month - 1, lastDay))
      expect(last >= from && last < until).toBe(true)
    }
  })

  it('includes 29 February in a leap year', () => {
    const { from, until } = monthRange(2028, 2)
    const leapDay = new Date(Date.UTC(2028, 1, 29))
    expect(leapDay >= from && leapDay < until).toBe(true)
  })

  it('actually returns rows for a 30-day month', async () => {
    // April used to come back empty. This is the same query the page makes.
    await day(aliceId, '2026-04-30', 8)

    const res = await get('/?year=2026&month=4')

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0].date).toBe('2026-04-30')
  })

  it('actually returns rows for February', async () => {
    await day(aliceId, '2026-02-28', 8)

    const res = await get('/?year=2026&month=2')
    expect(res.body.data).toHaveLength(1)
  })
})

describe('monthly hours — the figure the client asked for', () => {
  it('totals hours per employee from the database, not from a page of rows', async () => {
    await day(aliceId, '2026-04-01', 8)
    await day(aliceId, '2026-04-02', 7.5)
    await day(aliceId, '2026-04-03', 4, 'half_day')
    await day(bobId, '2026-04-01', 9)

    const res = await get('/monthly-summary?year=2026&month=4')

    expect(res.status).toBe(200)

    const alice = res.body.data.employees.find((e: { employee_id: string }) =>
      e.employee_id.endsWith('alice'),
    )
    expect(alice.total_hours).toBe(19.5)
    expect(alice.days_present).toBe(2)
    expect(alice.days_half).toBe(1)

    // The company figure the client wants at the end of the month.
    expect(res.body.data.grand_total_hours).toBe(28.5)
  })

  it('ignores days outside the month', async () => {
    await day(aliceId, '2026-03-31', 9)
    await day(aliceId, '2026-04-01', 8)
    await day(aliceId, '2026-05-01', 9)

    const res = await get('/monthly-summary?year=2026&month=4')
    const alice = res.body.data.employees[0]

    expect(alice.total_hours).toBe(8)
  })

  it('compares against expected hours for days actually worked, not the whole month', async () => {
    await day(aliceId, '2026-04-01', 8)
    await day(aliceId, '2026-04-02', 8)

    const res = await get('/monthly-summary?year=2026&month=4')
    const alice = res.body.data.employees[0]

    // Two days at a nine-hour shift. Counting the whole month would report a
    // shortfall of a hundred and seventy hours for somebody on leave.
    expect(alice.expected_hours).toBe(18)
    expect(alice.total_hours).toBe(16)
  })

  it('returns nothing rather than zero for a month with no rows', async () => {
    const res = await get('/monthly-summary?year=2026&month=7')
    expect(res.body.data.employees).toEqual([])
    expect(res.body.data.grand_total_hours).toBe(0)
  })
})

describe('the data scope', () => {
  it('shows a manager their team and nobody else', async () => {
    await day(aliceId, '2026-04-01', 8)
    await day(strangerId, '2026-04-01', 8)

    const res = await get('/?year=2026&month=4', 'mgr')
    const codes = res.body.data.map((r: { employee_code: string }) => r.employee_code)

    expect(codes).toContain(`${PREFIX}-alice`)
    // §4.4: a manager sees attendance only for their direct reports.
    expect(codes).not.toContain(`${PREFIX}-stranger`)
  })

  it('shows HR everybody', async () => {
    await day(aliceId, '2026-04-01', 8)
    await day(strangerId, '2026-04-01', 8)

    const res = await get('/?year=2026&month=4')
    expect(res.body.data).toHaveLength(2)
  })

  it('narrows a manager monthly total to their team too', async () => {
    await day(aliceId, '2026-04-01', 8)
    await day(strangerId, '2026-04-01', 9)

    const res = await get('/monthly-summary?year=2026&month=4', 'mgr')
    expect(res.body.data.grand_total_hours).toBe(8)
  })
})

describe('the day summary', () => {
  it('keeps "not marked" separate from "absent"', async () => {
    await day(aliceId, '2026-04-01', 8)

    const res = await get('/summary?date=2026-04-01')

    expect(res.body.data.present).toBe(1)
    expect(res.body.data.absent).toBe(0)
    // Five employees exist and one has a row. The other four have not been
    // recorded — which the old dashboard reported as absent, so the whole
    // company looked absent every morning until somebody started marking.
    expect(res.body.data.not_marked).toBe(4)
    expect(res.body.data.total_employees).toBe(5)
  })
})

describe('HR marking and correcting', () => {
  const mark = (body: object, key = 'hr') =>
    request(app).post('/api/attendance/mark').set('Authorization', as(key)).send(body)

  it('records a day and computes the hours', async () => {
    const res = await mark({
      employeeId: aliceId,
      date: '2026-04-01',
      status: 'present',
      checkIn: '09:30',
      checkOut: '18:30',
    })

    expect(res.status).toBe(201)
    // Nine hours elapsed, minus the shift's sixty-minute break.
    expect(res.body.data.hours_worked).toBe(8)
    expect(res.body.data.source).toBe('manual')
  })

  it('marks an amended punch as manual, so nobody has to guess later', async () => {
    await day(aliceId, '2026-04-01', 8)
    const listed = await get('/?date=2026-04-01')
    expect(listed.body.data[0].source).toBe('punch')

    const res = await request(app)
      .patch(`/api/attendance/${listed.body.data[0].id}`)
      .set('Authorization', as('hr'))
      .send({ status: 'present', checkIn: '10:00', checkOut: '18:00' })

    expect(res.status).toBe(200)
    // It stops claiming to be a punch. That is the entire reason `source` exists.
    expect(res.body.data.source).toBe('manual')
    expect(res.body.data.hours_worked).toBe(7)
  })

  it('handles an overnight correction without producing negative hours', async () => {
    const res = await mark({
      employeeId: aliceId,
      date: '2026-04-01',
      status: 'present',
      checkIn: '22:00',
      checkOut: '06:00',
    })

    expect(res.body.data.hours_worked).toBe(7)
    expect(res.body.data.note).toMatch(/overnight/i)
  })

  it('refuses a day that has not happened yet', async () => {
    const res = await mark({
      employeeId: aliceId,
      date: '2099-01-01',
      status: 'present',
    })

    // Without this, a typo in the year quietly creates attendance in 2099.
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/future/i)
  })

  it('lets the hours override a status HR guessed at', async () => {
    const res = await mark({
      employeeId: aliceId,
      date: '2026-04-01',
      status: 'present',
      checkIn: '09:30',
      checkOut: '15:00',
    })

    // 5.5 hours elapsed MINUS the shift's sixty-minute break is 4.5 worked —
    // exactly half of a nine-hour shift. The break is easy to forget and is
    // the difference between a half day and an absent one.
    expect(res.body.data.hours_worked).toBe(4.5)
    expect(res.body.data.status).toBe('half_day')
  })

  it('refuses a manager, who may see attendance but not change it', async () => {
    const res = await mark({ employeeId: aliceId, date: '2026-04-01', status: 'present' }, 'mgr')
    expect(res.status).toBe(403)
  })

  it('refuses an employee marking their own day', async () => {
    const res = await mark({ employeeId: aliceId, date: '2026-04-01', status: 'present' }, 'alice')

    // They punch; they do not write their own attendance record.
    expect(res.status).toBe(403)
  })
})

describe('biometric CSV import', () => {
  const HEADER = 'employee_id,date,in_time,out_time'

  const upload = (csv: string, dryRun = true, key = 'hr') =>
    request(app)
      .post('/api/attendance/import')
      .set('Authorization', as(key))
      .send({ csv, dryRun })

  it('previews without writing anything', async () => {
    const csv = [HEADER, `${PREFIX}-alice,01/04/2026,09:30,18:30`].join('\n')
    const res = await upload(csv)

    expect(res.status).toBe(200)
    expect(res.body.data.summary.valid).toBe(1)
    expect(res.body.data.summary.imported).toBe(0)
    expect(await prisma.attendance.count({ where: { employeeId: aliceId } })).toBe(0)
  })

  it('imports with source = biometric', async () => {
    const csv = [HEADER, `${PREFIX}-alice,01/04/2026,09:30,18:30`].join('\n')
    const res = await upload(csv, false)

    expect(res.status).toBe(201)
    expect(res.body.data.summary.imported).toBe(1)

    const row = await prisma.attendance.findFirstOrThrow({ where: { employeeId: aliceId } })
    // A day from a fingerprint reader and a day HR typed in are different kinds
    // of evidence, and somebody will need to tell them apart.
    expect(row.source).toBe('biometric')
    expect(Number(row.hoursWorked)).toBe(8)
    // No GPS check was made, and that is recorded as null rather than invented.
    expect(row.geofenceVerified).toBeNull()
  })

  it('reads the time formats biometric machines actually write', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-alice,01/04/2026,09:30:00,06:30 PM`,
      `${PREFIX}-bob,01/04/2026,9:30 AM,18:30`,
    ].join('\n')

    const res = await upload(csv)
    expect(res.body.data.summary.invalid).toBe(0)
  })

  it('says how many days it would overwrite, before it does', async () => {
    await day(aliceId, '2026-04-01', 8)

    const csv = [HEADER, `${PREFIX}-alice,01/04/2026,09:30,18:30`].join('\n')
    const res = await upload(csv)

    // Replacing a day HR already corrected by hand is worth knowing BEFORE
    // pressing import.
    expect(res.body.data.summary.would_overwrite).toBe(1)
  })

  it('catches an unknown employee code', async () => {
    const csv = [HEADER, `NOBODY-123,01/04/2026,09:30,18:30`].join('\n')
    const res = await upload(csv)

    expect(JSON.stringify(res.body.data.rows[0].issues)).toMatch(/No employee with code/)
  })

  it('catches the same person twice on the same day', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-alice,01/04/2026,09:30,18:30`,
      `${PREFIX}-alice,01/04/2026,10:00,19:00`,
    ].join('\n')

    const res = await upload(csv)
    expect(JSON.stringify(res.body.data.rows[1].issues)).toMatch(/already appears/)
  })

  it('refuses the whole file when any row is bad', async () => {
    const csv = [
      HEADER,
      `${PREFIX}-alice,01/04/2026,09:30,18:30`,
      `NOBODY-123,01/04/2026,09:30,18:30`,
    ].join('\n')

    const res = await upload(csv, false)

    expect(res.status).toBe(400)
    expect(await prisma.attendance.count({ where: { employeeId: aliceId } })).toBe(0)
  })

  it('refuses a manager', async () => {
    const csv = [HEADER, `${PREFIX}-alice,01/04/2026,09:30,18:30`].join('\n')
    expect((await upload(csv, false, 'mgr')).status).toBe(403)
  })
})

describe('the day roster', () => {
  const DATE = '2026-09-14'
  const names = (res: { body: { data: { employees: { full_name: string }[] } } }) =>
    res.body.data.employees.map((e: { full_name: string }) => e.full_name).sort()

  it('lists everybody, and says who has not been marked rather than calling them absent', async () => {
    await day(aliceId, DATE, 8)

    const res = await get(`/day?date=${DATE}`)
    expect(res.status).toBe(200)
    expect(res.body.data.date).toBe(DATE)
    expect(res.body.data.employees).toHaveLength(5)

    const alice = res.body.data.employees.find((e: { employee_id: string }) => e.employee_id === aliceId)
    expect(alice.attendance.status).toBe('present')
    expect(alice.attendance.hours_worked).toBe(8)

    // Null is "nobody has said", which the page shows as not marked. The old
    // page matched on ids from two different systems and showed EVERYONE this
    // way, including people who had punched in.
    const bob = res.body.data.employees.find((e: { employee_id: string }) => e.employee_id === bobId)
    expect(bob.attendance).toBeNull()
  })

  it("gives a manager their own team and nobody else's", async () => {
    const res = await get(`/day?date=${DATE}`, 'mgr')

    expect(res.status).toBe(200)
    expect(names(res)).toEqual(['alice person', 'bob person', 'mgr person'])
  })

  it('gives an employee only themselves', async () => {
    const res = await get(`/day?date=${DATE}`, 'alice')

    expect(res.status).toBe(200)
    expect(names(res)).toEqual(['alice person'])
  })

  it('leaves out somebody who had not joined yet, or had already left', async () => {
    const [future, gone] = await Promise.all([
      prisma.employee.create({
        data: {
          organizationId: orgId,
          employeeCode: `${PREFIX}-future`,
          fullName: 'Joins Later',
          dateOfJoining: toDateColumn('2026-10-01'),
        },
      }),
      prisma.employee.create({
        data: {
          organizationId: orgId,
          employeeCode: `${PREFIX}-gone`,
          fullName: 'Left Earlier',
          dateOfJoining: toDateColumn('2024-01-01'),
          lastWorkingDate: toDateColumn('2026-08-31'),
        },
      }),
    ])

    try {
      const res = await get(`/day?date=${DATE}`)
      expect(names(res)).not.toContain('Joins Later')
      expect(names(res)).not.toContain('Left Earlier')

      // And the same two ARE there on a day they were employed.
      const earlier = await get('/day?date=2026-08-20')
      expect(names(earlier)).toContain('Left Earlier')
      const later = await get('/day?date=2026-10-05')
      expect(names(later)).toContain('Joins Later')
    } finally {
      await prisma.employee.deleteMany({ where: { id: { in: [future.id, gone.id] } } })
    }
  })

  it("defaults to the company's today, not UTC's", async () => {
    const res = await get('/day')
    expect(res.status).toBe(200)
    expect(res.body.data.date).toBe(zonedToday(new Date(), 'Asia/Kolkata'))
  })

  it('refuses a date it cannot read', async () => {
    expect((await get('/day?date=14-09-2026')).status).toBe(422)
  })
})
