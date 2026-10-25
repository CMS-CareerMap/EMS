import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { prisma } from '../../platform/db/prisma'
import { forOrg } from '../../platform/db/scoped'
import { hashPassword } from '../../platform/auth/password'
import { fromDateColumn, toDateColumn } from '../../domain/shared/dates'
import { keepHolidayYear } from './holidayYear.service'

/**
 * The holiday calendar from one year to the next (client, 25 Oct 2026): the
 * next year's fixed national holidays from October — once, never one the
 * company removed, never a day gone by — and in December, whoever keeps the
 * calendar told once if the festivals are missing.
 */

const PREFIX = 'hyeartest'
let orgId = ''
let hrUser = ''

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.holiday.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

/** Noon in India on a day. */
const at = (day: string) => new Date(`${day}T06:30:00Z`)
const keep = (day: string, apply = true) => keepHolidayYear(forOrg(orgId), orgId, { apply, now: at(day) })
const holidaysOf = async (year: number) =>
  (await prisma.holiday.findMany({ where: { organizationId: orgId, date: { gte: toDateColumn(`${year}-01-01`), lte: toDateColumn(`${year}-12-31`) } }, orderBy: { date: 'asc' } }))
    .map((h) => `${fromDateColumn(h.date)} ${h.name}`)

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })).id
  hrUser = (await prisma.user.create({ data: { email: `${PREFIX}-hr@example.com`, passwordHash: await hashPassword('CorrectHorseBattery1') } })).id
  await prisma.membership.create({ data: { userId: hrUser, organizationId: orgId, role: 'hr', status: 'active' } })
})

beforeEach(async () => {
  await prisma.holiday.deleteMany({ where: { organizationId: orgId } })
  await prisma.notification.deleteMany({ where: { organizationId: orgId } })
  await prisma.organization.update({ where: { id: orgId }, data: { fixedHolidaysThrough: 2026, holidayReminderYear: null } })
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the next year’s fixed holidays', () => {
  it('waits for October', async () => {
    expect((await keep('2026-09-30')).added).toBe(0)
    expect(await holidaysOf(2027)).toEqual([])
  })

  it('adds the next year’s three from October — once', async () => {
    expect((await keep('2026-10-01')).added).toBe(3)
    expect(await holidaysOf(2027)).toEqual(['2027-01-26 Republic Day', '2027-08-15 Independence Day', '2027-10-02 Gandhi Jayanti'])
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).fixedHolidaysThrough).toBe(2027)
    expect((await keep('2026-10-02')).added).toBe(0)
    const audit = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'holiday.fixed_added' } })
    expect(audit?.details).toMatchObject({ year: 2027, added: 3, skipped: 0 })
  })

  it('never puts back one the company removed', async () => {
    await keep('2026-10-01')
    await prisma.holiday.deleteMany({ where: { organizationId: orgId, date: toDateColumn('2027-10-02') } })
    await keep('2026-11-01')
    expect(await holidaysOf(2027)).toEqual(['2027-01-26 Republic Day', '2027-08-15 Independence Day'])
  })

  it('keeps the company’s own name for the day', async () => {
    await prisma.holiday.create({ data: { organizationId: orgId, date: toDateColumn('2027-08-15'), name: 'Swatantrata Diwas', type: 'public' } })
    await keep('2026-10-01')
    expect(await holidaysOf(2027)).toEqual(['2027-01-26 Republic Day', '2027-08-15 Swatantrata Diwas', '2027-10-02 Gandhi Jayanti'])
  })

  it('catches a year missed — but never makes a day gone by a holiday', async () => {
    await prisma.organization.update({ where: { id: orgId }, data: { fixedHolidaysThrough: 2025 } })
    await keep('2026-11-01')
    // 2026's three have all gone by on 1 November; 2027's are added.
    expect(await holidaysOf(2026)).toEqual([])
    expect(await holidaysOf(2027)).toHaveLength(3)
  })

  it('writes nothing on a dry run', async () => {
    expect((await keep('2026-10-01', false)).added).toBe(3)
    expect(await holidaysOf(2027)).toEqual([])
  })
})

describe('the December reminder', () => {
  it('tells whoever keeps the calendar, once, when next year has only the fixed three', async () => {
    await keep('2026-10-01')
    expect((await keep('2026-12-02')).reminded).toBe(true)
    const told = await prisma.notification.findMany({ where: { userId: hrUser, event: 'holidays.next_year_missing' } })
    expect(told).toHaveLength(1)
    expect(told[0]!.title).toMatch(/2027/)
    await keep('2026-12-03')
    expect(await prisma.notification.count({ where: { userId: hrUser, event: 'holidays.next_year_missing' } })).toBe(1)
  })

  it('says nothing once a festival is entered, and nothing before December', async () => {
    await prisma.holiday.create({ data: { organizationId: orgId, date: toDateColumn('2027-11-08'), name: 'Diwali', type: 'public' } })
    expect((await keep('2026-12-02')).reminded).toBe(false)
    await prisma.holiday.deleteMany({ where: { organizationId: orgId, name: 'Diwali' } })
    expect((await keep('2026-11-30')).reminded).toBe(false)
    expect(await prisma.notification.count({ where: { organizationId: orgId } })).toBe(0)
  })
})
