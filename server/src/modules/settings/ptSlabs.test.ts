import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { toDateColumn, fromDateColumn } from '../../domain/shared/dates'

/**
 * Setting a state's professional-tax table — and payroll then charging it.
 */

const PREFIX = 'pttest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()

let orgId = ''
const tokens: Record<string, string> = {}

async function cleanup() {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.esiCoverage.deleteMany({ where: org })
  await prisma.employeeSalaryComponent.deleteMany({ where: org })
  await prisma.employeeFinancial.deleteMany({ where: org })
  await prisma.employeeStatutoryIdentity.deleteMany({ where: org })
  await prisma.salaryComponent.deleteMany({ where: org })
  await prisma.ptSlab.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

async function login(key: string, role: 'super_admin' | 'hr') {
  const email = `${PREFIX}-${key}@example.com`
  const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
  await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
  tokens[key] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
}

const as = (key: string) => `Bearer ${tokens[key]}`
const put = (body: Record<string, unknown>, key = 'boss') =>
  request(app).put('/api/settings/pt-slabs').set('Authorization', as(key)).send(body)
const current = async (state: string) =>
  (await request(app).get(`/api/settings/pt-slabs?state=${state}`).set('Authorization', as('boss'))).body.data

/** Karnataka as the state writes it: nothing below ₹25,000, then ₹200. */
const KARNATAKA = [
  { gender: 'any', from: 0, amount: 0 },
  { gender: 'any', from: 25000, amount: 200 },
]

beforeAll(async () => {
  await cleanup()
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org` } })).id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: toDateColumn('2020-04-01') } })
  await login('boss', 'super_admin')
  await login('hr', 'hr')
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe("setting a state's PT table", () => {
  it('stores it with no gaps — each slab ends a paisa below the next', async () => {
    const res = await put({ state: 'Karnataka', effectiveFrom: '2026-04-01', slabs: KARNATAKA })

    expect(res.status).toBe(200)
    expect(res.body.data.map((s: { min_gross: number; max_gross: number | null }) => [s.min_gross, s.max_gross]))
      .toEqual([[0, 24999.99], [25000, null]])
  })

  it('refuses a table that would take more than ₹2,500 a year', async () => {
    const res = await put({ state: 'Goa', effectiveFrom: '2026-04-01', slabs: [{ gender: 'any', from: 0, amount: 250 }] })
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/capped at ₹2500/)
    expect(await current('Goa')).toEqual([])
  })

  it('refuses slabs for men with none for women', async () => {
    const res = await put({ state: 'Goa', effectiveFrom: '2026-04-01', slabs: [{ gender: 'male', from: 0, amount: 200 }] })
    expect(res.status).toBe(400)
  })

  it('treats a later date as a revision, closing the old table the day before', async () => {
    await put({ state: 'Kerala', effectiveFrom: '2026-04-01', slabs: [{ gender: 'any', from: 0, amount: 100 }] })
    const res = await put({ state: 'Kerala', effectiveFrom: '2026-10-01', slabs: [{ gender: 'any', from: 0, amount: 150 }] })

    expect(res.status).toBe(200)
    expect(res.body.data.map((s: { amount: number }) => s.amount)).toEqual([150])

    const closed = await prisma.ptSlab.findFirst({ where: { organizationId: orgId, state: 'Kerala', amount: 100 } })
    expect(fromDateColumn(closed?.effectiveTo)).toBe('2026-09-30')
  })

  it('treats the same date as a correction, and keeps the spelling on record', async () => {
    await put({ state: 'Tamil Nadu', effectiveFrom: '2026-04-01', slabs: [{ gender: 'any', from: 0, amount: 100 }] })
    const res = await put({ state: 'tamil nadu', effectiveFrom: '2026-04-01', slabs: [{ gender: 'any', from: 0, amount: 120 }] })

    expect(res.status).toBe(200)
    expect(res.body.data).toHaveLength(1)
    expect(res.body.data[0]).toMatchObject({ state: 'Tamil Nadu', amount: 120 })
  })

  it('refuses a date before the current table started', async () => {
    const res = await put({ state: 'Karnataka', effectiveFrom: '2025-04-01', slabs: KARNATAKA })
    expect(res.status).toBe(409)
  })

  it('is refused to HR — statutory settings belong to Super Admin', async () => {
    expect((await put({ state: 'Bihar', effectiveFrom: '2026-04-01', slabs: KARNATAKA }, 'hr')).status).toBe(403)
  })
})

describe('what payroll then does', () => {
  it('charges a Karnataka employee from the new table', async () => {
    const basic = await prisma.salaryComponent.create({
      data: { organizationId: orgId, code: 'BASIC', label: 'Basic', countsForPf: true, displayOrder: 1 },
    })
    const employee = await prisma.employee.create({
      data: {
        organizationId: orgId,
        employeeCode: `${PREFIX}-ka`,
        fullName: 'Bengaluru Hire',
        gender: 'male',
        dateOfJoining: toDateColumn('2026-01-01'),
        statutoryIdentity: { create: { organizationId: orgId, ptState: 'Karnataka' } },
        financials: {
          create: {
            organizationId: orgId,
            ctc: 360000,
            effectiveFrom: toDateColumn('2026-01-01'),
            components: { create: [{ organizationId: orgId, salaryComponentId: basic.id, amount: 30000 }] },
          },
        },
      },
    })

    const res = await request(app).post('/api/payroll/calculate').set('Authorization', as('boss'))
      .send({ employeeId: employee.id, year: 2026, month: 9 })

    expect(res.status).toBe(200)
    // Before this table existed: ₹0 and a warning, every month.
    expect(res.body.data.professional_tax).toBe(200)
    expect(res.body.data.warnings.join(' ')).not.toMatch(/No PT slabs/)
  })
})
