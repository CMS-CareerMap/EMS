import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'

/**
 * Settings.
 *
 * The bar the guide sets is "every tab persists and survives a reload", which
 * sounds trivial and is exactly what the old app failed: the Company tab
 * collected fourteen fields, showed a tick, and stored none of them. So every
 * test here saves, re-reads through a SEPARATE request, and checks the value
 * came back — not that the response echoed what was sent.
 */

const PREFIX = 'settest'
const PASSWORD = 'CorrectHorseBattery1'

const app = createApp()

let orgId = ''
const tokens: Record<string, string> = {}

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.ptSlab.deleteMany({ where: org })
  await prisma.holiday.deleteMany({ where: org })
  await prisma.geofenceLocation.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function makeUser(key: string, role: 'super_admin' | 'hr') {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({
    data: { email, passwordHash: await hashPassword(PASSWORD) },
  })
  await prisma.membership.create({
    data: { userId: user.id, organizationId: orgId, role, status: 'active' },
  })
  const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
  tokens[key] = res.body.data.accessToken
}

const as = (key: string) => `Bearer ${tokens[key]}`
const get = (path: string, key = 'boss') =>
  request(app).get(`/api/settings${path}`).set('Authorization', as(key))
const put = (path: string, body: object, key = 'boss') =>
  request(app).put(`/api/settings${path}`).set('Authorization', as(key)).send(body)

beforeAll(async () => {
  await cleanup()
  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org` } })
  orgId = org.id
  await makeUser('boss', 'super_admin')
  await makeUser('hr', 'hr')
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the Company tab, which used to discard everything', () => {
  it('saves all fourteen fields and gives them back on a fresh read', async () => {
    const payload = {
      name: `${PREFIX}-CareerMap`,
      legalName: 'CareerMap Solutions Private Limited',
      gstin: '27AABCU9603R1ZM',
      pan: 'AABCU9603R',
      address: '3rd Floor, Tech Park',
      city: 'Pune',
      state: 'Maharashtra',
      pincode: '411045',
      phone: '02041234567',
      email: 'hello@example.com',
      website: 'https://example.com',
      timezone: 'Asia/Kolkata',
      dateFormat: 'DD/MM/YYYY' as const,
      currency: 'INR',
    }

    const saved = await put('/company', payload)
    expect(saved.status).toBe(200)

    // A SEPARATE request. The old app's failure would have passed a test that
    // only checked the save response, because the response echoed the input.
    const reread = await get('/company')

    expect(reread.body.data.legal_name).toBe('CareerMap Solutions Private Limited')
    expect(reread.body.data.gstin).toBe('27AABCU9603R1ZM')
    expect(reread.body.data.address).toBe('3rd Floor, Tech Park')
    expect(reread.body.data.city).toBe('Pune')
    expect(reread.body.data.pincode).toBe('411045')
    expect(reread.body.data.website).toBe('https://example.com')
    expect(reread.body.data.date_format).toBe('DD/MM/YYYY')
  })

  it('leaves untouched fields alone rather than nulling them', async () => {
    await put('/company', { city: 'Mumbai' })
    const reread = await get('/company')

    expect(reread.body.data.city).toBe('Mumbai')
    // Sending a partial form must not wipe what it did not include.
    expect(reread.body.data.gstin).toBe('27AABCU9603R1ZM')
  })

  it('refuses a time zone that is not one, which would break every "today"', async () => {
    // The old Company tab sent its option LABELS — 'Asia/Kolkata (IST)'. Saved,
    // every calculation of today's date would throw.
    expect((await put('/company', { timezone: 'Asia/Kolkata (IST)' })).status).toBe(422)
    expect((await put('/company', { timezone: 'Mars/Olympus' })).status).toBe(422)
    expect((await put('/company', { timezone: 'Asia/Dubai' })).status).toBe(200)
    expect((await put('/company', { timezone: 'Asia/Kolkata' })).status).toBe(200)
  })

  it('wants country and currency codes in capitals, as they are compared', async () => {
    expect((await put('/company', { country: 'in' })).status).toBe(422)
    expect((await put('/company', { country: 'IN', currency: 'INR' })).status).toBe(200)
  })

  it('rejects an unknown field instead of ignoring it', async () => {
    const res = await put('/company', { city: 'Pune', employeeCount: 500 })
    expect(res.status).toBe(422)
  })

  it('refuses a role without settings access', async () => {
    const res = await request(app)
      .get('/api/settings/company')
      .set('Authorization', as('hr'))
    expect(res.status).toBe(403)
  })
})

describe('statutory policy', () => {
  it('materialises the statutory defaults on first read', async () => {
    const res = await get('/payroll')

    expect(res.status).toBe(200)
    expect(res.body.data.pf_employee).toBe(12)
    expect(res.body.data.esi_threshold).toBe(21000)
    // ₹25,000 from 17 September 2026; the pension ceiling waits for the
    // accountant at ₹15,000.
    expect(res.body.data.pf_wage_ceiling).toBe(25000)
    expect(res.body.data.eps_wage_ceiling).toBe(15000)
  })

  it('saves a rate change and reads it back', async () => {
    await put('/payroll', { esiThreshold: 25000 })
    const reread = await get('/payroll')
    expect(reread.body.data.esi_threshold).toBe(25000)
  })

  it('carries forward the rates that were not changed', async () => {
    await put('/payroll', { pfEmployeeRate: 10 })
    const reread = await get('/payroll')

    expect(reread.body.data.pf_employee).toBe(10)
    // Changed in the previous test. A new period must inherit it, not reset to
    // the schema default.
    expect(reread.body.data.esi_threshold).toBe(25000)
  })

  it('treats a same-day change as a correction, not a new period', async () => {
    await put('/payroll', { payDay: 5 })
    await put('/payroll', { payDay: 7 })

    const history = await request(app)
      .get('/api/settings/payroll/history')
      .set('Authorization', as('boss'))

    // Everything so far happened today, so there is one period — not one per
    // edit, which would make the history unreadable.
    expect(history.body.data).toHaveLength(1)
    expect(history.body.data[0].pay_day).toBe(7)
  })

  it('opens a new period when the change is on a later day', async () => {
    // Backdate the current period so the next edit is "a later day".
    const current = await prisma.organizationPolicy.findFirst({
      where: { organizationId: orgId, effectiveTo: null },
    })
    await prisma.organizationPolicy.update({
      where: { id: current!.id },
      data: { effectiveFrom: new Date(Date.UTC(2026, 0, 1)) },
    })

    await put('/payroll', { pfEmployeeRate: 12 })

    const history = await request(app)
      .get('/api/settings/payroll/history')
      .set('Authorization', as('boss'))

    expect(history.body.data).toHaveLength(2)

    // The OLD period keeps the old rate. This is the whole point: a payslip
    // issued under the old rules stays explainable.
    const closed = history.body.data.find((p: { effective_to: string | null }) => p.effective_to)
    expect(closed.pf_employee).toBe(10)

    const open = history.body.data.find((p: { effective_to: string | null }) => !p.effective_to)
    expect(open.pf_employee).toBe(12)
  })

  it('refuses a rate above 100 percent', async () => {
    const res = await put('/payroll', { pfEmployeeRate: 500 })
    expect(res.status).toBe(422)
  })

  it('refuses a negative rate', async () => {
    const res = await put('/payroll', { esiEmployeeRate: -1 })
    expect(res.status).toBe(422)
  })

  it('refuses a pay day that does not exist in February', async () => {
    // A pay day of the 30th works for eleven months and then silently does not
    // exist, which is a bug that appears once a year.
    const res = await put('/payroll', { payDay: 30 })
    expect(res.status).toBe(422)
  })

  it('counts days by calendar, with no sandwich rule, until told otherwise', async () => {
    const res = await get('/payroll')
    expect(res.body.data.lop_basis).toBe('calendar_days')
    expect(res.body.data.sandwich_rule).toBe(false)
    // The client deducts no income tax through payroll.
    expect(res.body.data.tds_enabled).toBe(false)
  })

  it('saves the LOP basis and the sandwich rule, and carries them into the next period', async () => {
    expect((await put('/payroll', { lopBasis: 'fixed_30', sandwichRule: true, tdsEnabled: true })).status).toBe(200)

    // Backdate, so the next change opens a new period rather than correcting.
    const current = await prisma.organizationPolicy.findFirst({
      where: { organizationId: orgId, effectiveTo: null },
    })
    await prisma.organizationPolicy.update({
      where: { id: current!.id },
      data: { effectiveFrom: new Date(Date.UTC(2026, 1, 1)) },
    })
    await put('/payroll', { payDay: 3 })

    const reread = await get('/payroll')
    expect(reread.body.data).toMatchObject({ lop_basis: 'fixed_30', sandwich_rule: true, tds_enabled: true, pay_day: 3 })
  })

  it('refuses a basis that is not one of the three', async () => {
    expect((await put('/payroll', { lopBasis: 'fixed_26' })).status).toBe(422)
  })
})

describe('geofence, which used to live in one admin browser', () => {
  it('saves to the server and is readable by a different request', async () => {
    const saved = await put('/geofence', {
      name: 'Head Office',
      latitude: 18.5204303,
      longitude: 73.8567437,
      radiusMeters: 250,
    })
    expect(saved.status).toBe(200)

    const reread = await get('/geofence')
    const office = reread.body.data.find((g: { name: string }) => g.name === 'Head Office')

    expect(office.latitude).toBeCloseTo(18.5204303, 6)
    expect(office.radius_meters).toBe(250)
    // The page works in kilometres; the column stores metres.
    expect(office.radius_km).toBe(0.25)
  })

  it('updates the same location rather than adding a second one', async () => {
    await put('/geofence', {
      name: 'Head Office',
      latitude: 18.52,
      longitude: 73.85,
      radiusMeters: 500,
    })

    const reread = await get('/geofence')
    const offices = reread.body.data.filter((g: { name: string }) => g.name === 'Head Office')
    expect(offices).toHaveLength(1)
    expect(offices[0].radius_meters).toBe(500)
  })

  it('refuses coordinates that are not on Earth', async () => {
    const res = await put('/geofence', {
      name: 'Nowhere',
      latitude: 200,
      longitude: 73.85,
      radiusMeters: 250,
    })
    expect(res.status).toBe(422)
  })

  it('refuses a radius that would cover the state', async () => {
    const res = await put('/geofence', {
      name: 'Too Big',
      latitude: 18.52,
      longitude: 73.85,
      radiusMeters: 500_000,
    })
    expect(res.status).toBe(422)
  })
})

describe('leave types', () => {
  it('creates one and lists it', async () => {
    const created = await request(app)
      .post('/api/settings/leave-types')
      .set('Authorization', as('boss'))
      .send({ name: 'Bereavement Leave', code: 'BL', annualQuota: 5, isPaid: true })

    expect(created.status).toBe(201)
    expect(created.body.data.code).toBe('BL')

    const list = await get('/leave-types')
    expect(list.body.data.map((t: { code: string }) => t.code)).toContain('BL')
  })

  it('edits a quota and reads it back', async () => {
    const list = await get('/leave-types')
    const bl = list.body.data.find((t: { code: string }) => t.code === 'BL')

    await request(app)
      .patch(`/api/settings/leave-types/${bl.id}`)
      .set('Authorization', as('boss'))
      .send({ annualQuota: 7 })

    const reread = await get('/leave-types')
    expect(reread.body.data.find((t: { code: string }) => t.code === 'BL').days).toBe(7)
  })

  it('refuses carry-forward with no cap', async () => {
    const res = await request(app)
      .post('/api/settings/leave-types')
      .set('Authorization', as('boss'))
      .send({ name: 'Broken Leave', code: 'XL', carryForward: true })

    // "Carry forward: yes, up to zero days" is not a configuration, it is a
    // half-filled form that would quietly carry nothing.
    expect(res.status).toBe(422)
  })

  it('refuses a duplicate code', async () => {
    const res = await request(app)
      .post('/api/settings/leave-types')
      .set('Authorization', as('boss'))
      .send({ name: 'Another One', code: 'BL', annualQuota: 1 })

    expect(res.status).toBe(409)
  })

  it('archives rather than deletes, so ledger history stays explainable', async () => {
    const list = await get('/leave-types')
    const bl = list.body.data.find((t: { code: string }) => t.code === 'BL')

    const res = await request(app)
      .delete(`/api/settings/leave-types/${bl.id}`)
      .set('Authorization', as('boss'))
    expect(res.status).toBe(204)

    const after = await get('/leave-types')
    expect(after.body.data.map((t: { code: string }) => t.code)).not.toContain('BL')

    // The row is still there. A leave balance whose type had vanished could not
    // be explained — "four days of what?".
    const row = await prisma.leaveType.findUnique({ where: { id: bl.id } })
    expect(row).not.toBeNull()
    expect(row?.archivedAt).not.toBeNull()
  })
})

describe('the client requirements added on Day 9', () => {
  it('accepts the 15–30 m geofence the client asked for', async () => {
    // The first validator had a floor of 50 m, which would have refused the
    // client's actual requirement.
    const res = await put('/geofence', {
      name: 'Tight Fence',
      latitude: 18.52,
      longitude: 73.85,
      radiusMeters: 20,
    })

    expect(res.status).toBe(200)
    const fence = res.body.data.find((g: { name: string }) => g.name === 'Tight Fence')
    expect(fence.radius_meters).toBe(20)
  })

  it('carries an accuracy gate, because 20 m needs one', async () => {
    const res = await put('/geofence', {
      name: 'Tight Fence',
      latitude: 18.52,
      longitude: 73.85,
      radiusMeters: 20,
      maxAccuracyMeters: 25,
    })

    const fence = res.body.data.find((g: { name: string }) => g.name === 'Tight Fence')
    // A phone that reports "give or take 40 m" cannot decide a 20 m fence, so
    // Day 11 refuses that reading rather than guessing either way.
    expect(fence.max_accuracy_meters).toBe(25)
  })

  it('refuses an accuracy gate no phone could ever satisfy', async () => {
    const res = await put('/geofence', {
      name: 'Impossible',
      latitude: 18.52,
      longitude: 73.85,
      radiusMeters: 20,
      maxAccuracyMeters: 5,
    })

    // Demanding 5 m accuracy would reject every reading and lock the whole
    // company out — a setting that cannot be satisfied is not a setting.
    expect(res.status).toBe(422)
  })

  it('lets HR manage leave types', async () => {
    const res = await request(app)
      .post('/api/settings/leave-types')
      .set('Authorization', as('hr'))
      .send({ name: 'Study Leave', code: 'STL', annualQuota: 3 })

    expect(res.status).toBe(201)
  })

  it('does not let HR touch company or statutory settings', async () => {
    const company = await request(app)
      .put('/api/settings/company')
      .set('Authorization', as('hr'))
      .send({ city: 'Nagpur' })
    expect(company.status).toBe(403)

    const payroll = await request(app)
      .put('/api/settings/payroll')
      .set('Authorization', as('hr'))
      .send({ pfEmployeeRate: 1 })
    expect(payroll.status).toBe(403)
  })
})

describe('what the Day 9 audit found in these screens', () => {
  it('brings back an archived leave type instead of refusing it', async () => {
    // BL was archived above. Adding it again used to be a 409 about a type
    // nobody could see — its code is unique for ever.
    const res = await request(app)
      .post('/api/settings/leave-types')
      .set('Authorization', as('boss'))
      .send({ name: 'Bereavement Leave', code: 'bl', annualQuota: 4 })

    expect(res.status).toBe(200)
    expect(res.body.meta.restored).toBe(true)
    expect(res.body.data).toMatchObject({ code: 'BL', days: 4 })

    const list = await get('/leave-types')
    expect(list.body.data.map((t: { code: string }) => t.code)).toContain('BL')
  })

  it('answers a rename onto a taken code with a sentence, not a crash', async () => {
    const created = await request(app)
      .post('/api/settings/leave-types')
      .set('Authorization', as('boss'))
      .send({ name: 'Sabbatical', code: 'SAB', annualQuota: 2 })

    const res = await request(app)
      .patch(`/api/settings/leave-types/${created.body.data.id}`)
      .set('Authorization', as('boss'))
      .send({ code: 'BL' })

    expect(res.status).toBe(409)
    expect(res.body.error.message).toMatch(/already uses that name or code/)
  })

  it('lets the leave year move before any leave exists, and not after', async () => {
    expect((await put('/payroll', { leaveYearStartMonth: 1 })).status).toBe(200)

    // Somebody is granted their opening balance...
    const employee = await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: 'settest-ly', fullName: 'Has Leave' },
    })
    const type = await prisma.leaveType.findFirst({ where: { organizationId: orgId, archivedAt: null } })
    await prisma.leaveLedgerEntry.create({
      data: { organizationId: orgId, employeeId: employee.id, leaveTypeId: type!.id, leaveYear: 2026, days: 12, reason: 'opening_grant' },
    })

    // ...and now the year is fixed: moving it would split that balance across
    // two years that never existed.
    const refused = await put('/payroll', { leaveYearStartMonth: 4 })
    expect(refused.status).toBe(409)

    // Sending the value it already has is not a change, and is fine.
    expect((await put('/payroll', { leaveYearStartMonth: 1 })).status).toBe(200)
  })

  it("starts a changed rate on the company's date, not UTC's", async () => {
    // One clean period from January, so the next change opens a new one and
    // nothing earlier in this file shares its dates.
    await prisma.organizationPolicy.deleteMany({ where: { organizationId: orgId } })
    await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: new Date(Date.UTC(2026, 0, 1)) } })

    // 20:00 UTC on 30 June is 01:30 on 1 July in India. The old code started
    // the new rate on 30 June — inside the previous month's payroll.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-06-30T20:00:00Z'))
    try {
      expect((await put('/payroll', { payDay: 3 })).status).toBe(200)
    } finally {
      vi.useRealTimers()
    }

    const history = await request(app).get('/api/settings/payroll/history').set('Authorization', as('boss'))
    const newest = history.body.data.find((p: { effective_to: string | null }) => !p.effective_to)
    expect(newest.effective_from).toBe('2026-07-01')
    const closed = history.body.data.find((p: { effective_to: string | null }) => p.effective_to === '2026-06-30')
    expect(closed).toBeDefined()
  })
})
