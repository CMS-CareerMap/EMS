import { describe, it, expect } from 'vitest'
import { resolve } from 'node:path'
import { checkSource, checkServer, type Rule } from './architecture'

/**
 * The checker is only worth something if it catches what it says it catches
 * and nothing else. Each rule gets the mistake it exists for, and the nearest
 * correct code, which must pass.
 */

const options = { delegates: new Set(['employee', 'leaveType', 'organizationPolicy']) }
const rules = (file: string, code: string): Rule[] => checkSource(file, code, options).map((v) => v.rule)

describe('rule 1 — the raw Prisma client', () => {
  it('is refused outside scoped.ts and unsafe.ts', () => {
    expect(rules('modules/leave/leave.service.ts', `import { prisma } from '../../platform/db/prisma'`)).toEqual(['R1'])
    expect(rules('modules/leave/leave.service.ts', `import { PrismaClient } from '@prisma/client'`)).toEqual(['R1'])
  })

  it('is fine where it is meant to be, and for types', () => {
    expect(rules('platform/db/scoped.ts', `import { prisma } from './prisma'`)).toEqual([])
    expect(rules('modules/leave/leave.service.ts', `import type { Prisma } from '@prisma/client'`)).toEqual([])
    expect(rules('modules/leave/leave.test.ts', `import { prisma } from '../../platform/db/prisma'`)).toEqual([])
  })

  it('lets main.ts close the client, and nothing more', () => {
    expect(rules('main.ts', `import { disconnect } from './platform/db/prisma'`)).toEqual([])
    expect(rules('main.ts', `import { prisma } from './platform/db/prisma'`)).toEqual(['R1'])
  })
})

describe('rule 2 — queries in repositories', () => {
  it('refuses a query in a service, through ctx.db or a transaction', () => {
    expect(rules('modules/leave/leave.service.ts', `await ctx.db.leaveType.findFirst({ where: { id } })`)).toEqual(['R2'])
    expect(rules('modules/leave/leave.service.ts', `await tx.employee.update({ where: { id }, data })`)).toEqual(['R2'])
    expect(rules('modules/leave/leave.service.ts', `const d = ctx.db.employee`)).toEqual(['R2'])
    expect(rules('modules/leave/leave.service.ts', `await ctx.db.$transaction(async (tx) => {})`)).toEqual(['R2'])
  })

  it('allows handing ctx.db to a repository, and the same query in one', () => {
    expect(rules('modules/leave/leave.service.ts', `await repo.findType(ctx.db, id)`)).toEqual([])
    expect(rules('modules/leave/leave.service.ts', `await withTransaction(ctx.db, async (tx) => repo.save(tx, row))`)).toEqual([])
    expect(rules('modules/leave/leave.repository.ts', `export const find = (db, id) => db.leaveType.findFirst({ where: { id } })`)).toEqual([])
  })

  it('is not fooled by arrays and maps', () => {
    expect(rules('modules/leave/leave.service.ts', `rows.find((r) => r.id === id); cache.delete(key); this.items.count()`)).toEqual([])
  })
})

describe('rule 3 — requests stay in http/', () => {
  it('refuses express or a req/res parameter below http/', () => {
    expect(rules('modules/leave/leave.service.ts', `import type { Request } from 'express'`)).toEqual(['R3'])
    expect(rules('modules/leave/leave.service.ts', `export function apply(req, body) {}`)).toEqual(['R3'])
  })

  it('is what controllers and app.ts are for', () => {
    expect(rules('http/controllers/leave.controller.ts', `import type { RequestHandler } from 'express'\nexport const get = (req, res) => res.json({})`)).toEqual([])
    expect(rules('app.ts', `app.use((req, res, next) => next())`)).toEqual([])
  })
})

describe('rule 4 — a pure domain', () => {
  it('refuses a domain file reaching outside domain/', () => {
    expect(rules('domain/payroll/salary.ts', `import { logger } from '../../platform/logger'`)).toEqual(['R4'])
    expect(rules('domain/payroll/salary.ts', `import type { Gender } from '@prisma/client'`)).toEqual(['R4'])
  })

  it('allows other domain files, and vitest in its tests', () => {
    expect(rules('domain/payroll/salary.ts', `import { addCalendarDays } from '../shared/dates'`)).toEqual([])
    expect(rules('domain/payroll/salary.test.ts', `import { describe } from 'vitest'`)).toEqual([])
  })
})

describe('rule 5 — permissions, not roles', () => {
  it('refuses comparing, switching on or listing roles', () => {
    expect(rules('modules/leave/leave.service.ts', `if (ctx.role === 'hr') {}`)).toEqual(['R5'])
    expect(rules('modules/leave/leave.service.ts', `if ('super_admin' !== user.role) {}`)).toEqual(['R5'])
    expect(rules('modules/leave/leave.service.ts', `switch (member.role) { case 'accounts': break }`)).toEqual(['R5'])
    expect(rules('modules/leave/leave.service.ts', `if (['hr', 'admin'].includes(role)) {}`)).toEqual(['R5'])
  })

  it('allows can(), and a role used as data', () => {
    expect(rules('modules/leave/leave.service.ts', `if (ctx.can('leave:approve')) {}`)).toEqual([])
    expect(rules('modules/user/user.repository.ts', `db.membership.count({ where: { role: 'super_admin' } })`)).toEqual([])
  })
})

describe('rule 6 — serializers', () => {
  it('refuses an invented value in a response field, and a spread row', () => {
    expect(rules('http/serializers/employee.serializer.ts', `const out = { department: row.department?.name ?? 'General' }`)).toEqual(['R6'])
    expect(rules('http/controllers/payroll.controller.ts', `const out = { gross: Number(row.gross) || 0 }`)).toEqual(['R6'])
    expect(rules('http/serializers/employee.serializer.ts', `const out = { ...row, id: row.id }`)).toEqual(['R6'])
  })

  it('allows null for missing, composing allow-lists, and response metadata', () => {
    expect(rules('http/serializers/employee.serializer.ts', `const out = { archived_at: row.archivedAt ?? null, ...base(row) }`)).toEqual([])
    expect(rules('http/controllers/settings.controller.ts', `res.json({ data, meta: { requestId, ...extra } })`)).toEqual([])
    expect(rules('http/controllers/leave.controller.ts', `parseBody(schema, req.body ?? {})`)).toEqual([])
  })
})

describe('rule 7 — statutory numbers', () => {
  it('refuses rates and thresholds outside domain/', () => {
    expect(rules('modules/payroll/payroll.service.ts', `const pf = wage * 0.12`)).toEqual(['R7'])
    expect(rules('modules/payroll/payroll.service.ts', `if (gross <= 21_000) {}`)).toEqual(['R7'])
    expect(rules('modules/payroll/payroll.service.ts', `const basic = ctc * 0.40`)).toEqual(['R7'])
    expect(rules('modules/payroll/payroll.service.ts', `const pt = gross > 10000 ? 200 : 0`)).toEqual(['R7'])
  })

  it('allows them in domain/, and 200 as a status or a length', () => {
    expect(rules('domain/payroll/statutory.ts', `export const PF_RATE = 0.12`)).toEqual([])
    expect(rules('http/controllers/leave.controller.ts', `res.status(200).json({}); res.status(dry ? 200 : 201); reply(res, 200, row)`)).toEqual([])
    expect(rules('http/validators/auth.validator.ts', `z.string().max(200); optionalText(300)`)).toEqual([])
    expect(rules('platform/auth/password.ts', `if (plain.length > 200) {}`)).toEqual([])
    expect(rules('modules/leave/leave.service.ts', `const half = 0.5`)).toEqual([])
  })
})

describe('rule 8 — calendar days', () => {
  it('refuses toISOString everywhere but dates.ts, tests included', () => {
    expect(rules('http/controllers/leave.controller.ts', `const day = value.toISOString().slice(0, 10)`)).toEqual(['R8'])
    expect(rules('modules/leave/leave.test.ts', `expect(row.date.toISOString()).toBe(x)`)).toEqual(['R8'])
    expect(rules('domain/shared/dates.ts', `export const day = (value) => value.toISOString().slice(0, 10)`)).toEqual([])
  })

  it('reads code, not comments or strings', () => {
    expect(rules('modules/leave/leave.service.ts', `// never call toISOString() here\nconst note = 'toISOString is banned'`)).toEqual([])
  })
})

describe('server/src', () => {
  it('keeps every §A5 rule', () => {
    const violations = checkServer(resolve(__dirname, '..'))
    // The list, not a count, so the failure says where to look.
    expect(violations.map((v) => `${v.rule} src/${v.file}:${v.line} ${v.message}`)).toEqual([])
  })
})
