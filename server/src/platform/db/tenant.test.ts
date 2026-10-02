import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { Prisma } from '@prisma/client'
import { GLOBAL_MODELS, TENANT_MODELS } from './tenantModels'

/**
 * Multi-tenant conformance.
 *
 * Reads Prisma's own model metadata and fails the build if a new table forgets
 * the tenant column, or carries a unique constraint that could collide across
 * companies. Cheap to maintain, and it catches the one class of mistake that is
 * close to unfixable after go-live.
 *
 * WHEN YOU ADD A MODEL you must list it below. That is deliberate: an
 * unclassified model fails CI rather than slipping through unnoticed.
 */

// The lists come from tenantModels.ts, which is also what scoped.ts reads at
// runtime. Keeping a second copy here would let the two drift — and the drift
// that matters is a model this test knows about but the scoping extension does
// not, which is silently unscoped data.

/**
 * Single-field @unique on a tenant table, deliberately allowed.
 *
 * A bare @unique is dangerous when the value is human-meaningful — two
 * companies must both be able to use employeeCode "EMP001". It is harmless
 * when the value is a foreign key to an already globally-unique row, because
 * the referenced row belongs to exactly one company anyway.
 *
 * Every entry needs a reason. If you cannot write one, it does not belong here.
 */
const ALLOWED_BARE_UNIQUES: Record<string, string> = {
  'EmployeeBankAccount.employeeId':
    'One-to-one with Employee. A uuid FK, so two companies cannot produce the same value; the unique is what enforces one bank account per employee',
  'EmployeeStatutoryIdentity.employeeId':
    'One-to-one with Employee, same reasoning as the bank account — a uuid FK, and the constraint is what makes it one-to-one',
}

const models = Prisma.dmmf.datamodel.models

const byName = (name: string) => {
  const m = models.find((x) => x.name === name)
  if (!m) throw new Error(`Model ${name} is listed in this test but not in the schema`)
  return m
}

/** Prisma's DMMF exposes unique indexes but not plain @@index, so read the source. */
const schemaDir = join(__dirname, '../../../prisma/schema')
const schemaText = readdirSync(schemaDir)
  .filter((f) => f.endsWith('.prisma'))
  .map((f) => readFileSync(join(schemaDir, f), 'utf8'))
  .join('\n')

function modelBlock(name: string): string {
  const match = schemaText.match(new RegExp(`model\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`))
  if (!match) throw new Error(`Could not find model ${name} in the schema files`)
  return match[1]!
}

describe('multi-tenant conformance', () => {
  it('has a model list that matches the schema', () => {
    expect(models.map((m) => m.name).sort()).toEqual([...GLOBAL_MODELS, ...TENANT_MODELS].sort())
  })

  it.each([...TENANT_MODELS])('%s carries a required organizationId', (name) => {
    const field = byName(name).fields.find((f) => f.name === 'organizationId')
    expect(field, `${name} has no organizationId`).toBeDefined()
    expect(field!.isRequired, `${name}.organizationId is optional`).toBe(true)
  })

  it.each([...TENANT_MODELS])('%s has no unjustified single-field @unique', (name) => {
    const offenders = byName(name)
      .fields.filter((f) => f.isUnique && !f.isId && f.name !== 'organizationId')
      .map((f) => `${name}.${f.name}`)
      .filter((key) => !(key in ALLOWED_BARE_UNIQUES))

    expect(
      offenders,
      `add organizationId to the constraint, or justify it in ALLOWED_BARE_UNIQUES: ${offenders.join(', ')}`,
    ).toEqual([])
  })

  it.each([...TENANT_MODELS])('%s has no compound unique that omits organizationId', (name) => {
    for (const compound of byName(name).uniqueFields) {
      expect(
        compound,
        `${name} @@unique([${compound.join(', ')}]) omits organizationId`,
      ).toContain('organizationId')
    }
  })

  it.each([...TENANT_MODELS])('%s is indexed on organizationId', (name) => {
    const block = modelBlock(name)
    const hasIndex = /@@index\(\[\s*organizationId/.test(block)
    const hasUnique = /@@unique\(\[\s*organizationId/.test(block)
    expect(
      hasIndex || hasUnique,
      `${name} needs an @@index or @@unique starting with organizationId, or every query will scan the table`,
    ).toBe(true)
  })
})

describe('timestamp discipline', () => {
  it('gives every DateTime an explicit type — timestamptz for instants, date for calendar days', () => {
    const offenders: string[] = []

    for (const model of models) {
      for (const field of model.fields) {
        if (field.type !== 'DateTime') continue
        const native = (field as { nativeType?: [string, string[]] | null }).nativeType
        const kind = native?.[0]
        // Prisma's default maps to `timestamp` WITHOUT a zone, which silently
        // breaks attendance dates, leave boundaries and payroll cutoffs.
        if (kind !== 'Timestamptz' && kind !== 'Date') {
          offenders.push(`${model.name}.${field.name} (${kind ?? 'untyped'})`)
        }
      }
    }

    expect(offenders, `add @db.Timestamptz(3) or @db.Date: ${offenders.join(', ')}`).toEqual([])
  })
})
