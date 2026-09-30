import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { prisma } from '../../platform/db/prisma'
import { forOrg } from '../../platform/db/scoped'
import { storage } from '../../platform/storage'
import { env } from '../../config/env'
import { sweepOrganization } from './sweeper.service'

/**
 * The sweeper removes files no row points at — and never one a row does, or
 * one young enough to belong to a save still in progress.
 */

const PREFIX = 'sweeptest'
let orgId = ''
const keys = { kept: '', orphan: '', young: '' }

beforeAll(async () => {
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
  orgId = (await prisma.organization.create({ data: { name: `${PREFIX}-org` } })).id
  const employee = await prisma.employee.create({ data: { organizationId: orgId, employeeCode: 'SW-1', fullName: 'Sweep Test' } })
  const type = await prisma.documentType.create({ data: { organizationId: orgId, code: 'pan', label: 'PAN' } })

  keys.kept = `org/${orgId}/employee-document/${employee.id}/kept.pdf`
  keys.orphan = `org/${orgId}/employee-document/${employee.id}/orphan.pdf`
  keys.young = `org/${orgId}/employee-document/${employee.id}/young.pdf`
  for (const key of Object.values(keys)) await storage().put(key, Buffer.from('%PDF-1.4'), 'application/pdf')

  await prisma.employeeDocument.create({
    data: {
      organizationId: orgId, employeeId: employee.id, documentTypeId: type.id, fileName: 'pan.pdf', contentType: 'application/pdf',
      bytes: 8, sha256: 'x', storageKey: keys.kept, uploadedAt: new Date(), supersededAt: new Date(),
    },
  })
  // Two days old — past the grace period.
  const old = new Date(Date.now() - 48 * 3_600_000)
  await utimes(join(env.STORAGE_PATH, keys.orphan), old, old)
  await utimes(join(env.STORAGE_PATH, keys.kept), old, old)
})

afterAll(async () => {
  for (const key of Object.values(keys)) await storage().delete(key)
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
  await prisma.$disconnect()
})

describe('the storage sweeper', () => {
  it('reports, and touches nothing, without --apply', async () => {
    const result = await sweepOrganization({ db: forOrg(orgId), organizationId: orgId }, { apply: false })
    expect(result).toEqual({ scanned: 3, orphans: [keys.orphan], deleted: 0 })
    expect(await storage().exists(keys.orphan)).toBe(true)
  })

  it('removes only the old file nothing points at — a replaced document’s file is kept', async () => {
    const result = await sweepOrganization({ db: forOrg(orgId), organizationId: orgId }, { apply: true })
    expect(result.deleted).toBe(1)
    expect(await storage().exists(keys.orphan)).toBe(false)
    expect(await storage().exists(keys.kept)).toBe(true)
    expect(await storage().exists(keys.young)).toBe(true)
  })
})
