import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '../../src/platform/db/prisma'
import { seedForOrganization } from './referenceData'

/**
 * Reference data has two jobs: give a new company everything it needs, and do
 * no harm when it runs again on a company that has since made the data its own.
 */

const PREFIX = 'seedtest'
let orgId = ''
const target = () => ({ id: orgId, timezone: 'Asia/Kolkata' })
// A fixed moment, so the years below do not depend on when the suite runs.
const NOW = new Date('2026-09-27T06:00:00Z')

const counts = async () => {
  const where = { organizationId: orgId }
  return {
    departments: await prisma.department.count({ where }),
    designations: await prisma.designation.count({ where }),
    shifts: await prisma.shift.count({ where }),
    leaveTypes: await prisma.leaveType.count({ where }),
    components: await prisma.salaryComponent.count({ where }),
    openPt: await prisma.ptSlab.count({ where: { ...where, effectiveTo: null } }),
    holidays: await prisma.holiday.count({ where }),
    openPolicies: await prisma.organizationPolicy.count({ where: { ...where, effectiveTo: null } }),
    documentTypes: await prisma.documentType.count({ where }),
  }
}

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org` } })).id
})

afterAll(async () => {
  // Everything here cascades from the company.
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
  await prisma.$disconnect()
})

describe('reference data', () => {
  it('gives a new company everything it needs on day one', async () => {
    await seedForOrganization(prisma, target(), NOW)

    expect(await counts()).toEqual({
      departments: 5,
      designations: 6,
      shifts: 3,
      leaveTypes: 5,
      components: 6,
      openPt: 5,
      // Three fixed national holidays, for this year AND next — January must
      // not arrive with an empty calendar.
      holidays: 6,
      openPolicies: 1,
      // The compliance checklist: Aadhaar, PAN, offer letter, resume required.
      documentTypes: 8,
    })
    expect(await prisma.documentType.count({ where: { organizationId: orgId, required: true } })).toBe(4)

    const policy = await prisma.organizationPolicy.findFirstOrThrow({ where: { organizationId: orgId } })
    expect(policy.effectiveFrom).toEqual(new Date(Date.UTC(2026, 3, 1)))
    const nextYear = await prisma.holiday.count({ where: { organizationId: orgId, date: new Date(Date.UTC(2027, 0, 26)) } })
    expect(nextYear).toBe(1)
  })

  it('changes nothing when it runs again', async () => {
    const before = await counts()
    await seedForOrganization(prisma, target(), NOW)
    expect(await counts()).toEqual(before)
  })

  it('does not bring back what the company renamed', async () => {
    await prisma.department.update({
      where: { organizationId_name: { organizationId: orgId, name: 'Sales' } },
      data: { name: 'Sales & Marketing' },
    })
    await prisma.holiday.updateMany({
      where: { organizationId: orgId, name: 'Gandhi Jayanti' },
      data: { name: 'Gandhi Jayanti (national holiday)' },
    })

    await seedForOrganization(prisma, target(), NOW)

    expect(await prisma.department.count({ where: { organizationId: orgId, name: 'Sales' } })).toBe(0)
    expect(await prisma.holiday.count({ where: { organizationId: orgId, name: 'Gandhi Jayanti' } })).toBe(0)
    expect((await counts()).holidays).toBe(6)
  })

  it('leaves a revised PT table as the only one, even in a later financial year', async () => {
    // The company revised Maharashtra from 1 October: the old table closed the
    // day before, the new one open.
    await prisma.ptSlab.updateMany({
      where: { organizationId: orgId, state: 'Maharashtra', effectiveTo: null },
      data: { effectiveTo: new Date(Date.UTC(2026, 8, 30)) },
    })
    await prisma.ptSlab.create({
      data: {
        organizationId: orgId,
        state: 'Maharashtra',
        gender: 'any',
        minGross: 0,
        amount: 200,
        effectiveFrom: new Date(Date.UTC(2026, 9, 1)),
      },
    })

    // The next financial year's run used to open a second table beside it.
    await seedForOrganization(prisma, target(), new Date('2027-05-01T06:00:00Z'))

    const open = await prisma.ptSlab.findMany({ where: { organizationId: orgId, effectiveTo: null } })
    expect(open).toHaveLength(1)
    expect(open[0]!.effectiveFrom).toEqual(new Date(Date.UTC(2026, 9, 1)))
  })
})
