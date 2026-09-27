import { readFileSync, readdirSync } from 'node:fs'
import { join, relative, dirname, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'

/**
 * The §A5 rules of EMS_BUILD_GUIDE.md, checked on the syntax tree.
 *
 *   npm run lint           — prints every violation, exits 1 if there are any
 *   npm test               — architecture.test.ts runs the same check
 *
 * WHY NOT ESLINT. typescript-eslint parses through TypeScript's JavaScript API,
 * supports TypeScript below 6.1, and this server is on TypeScript 7, which has
 * no such API. @babel/parser reads TypeScript on its own. Every rule here is
 * about the shape of the code — which layer calls what — so a syntax tree is
 * all it needs; nothing here depends on types.
 *
 * WHY THE RULES AT ALL. Each one closes a class of bug the audit found, and each
 * held only as long as everybody remembered it. Written down here, it holds
 * when nobody does.
 *
 * Paths are relative to server/src. Tests are exempt from the rules about
 * production layering (1, 2, 3, 5, 7) — fixtures need the raw client and
 * supertest calls its response `res` — but not from rule 8: a test that reads
 * "today" off a UTC clock fails at 1 a.m. in Pune.
 */

export type Rule = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'R7' | 'R8'

export interface Violation {
  file: string
  line: number
  column: number
  rule: Rule
  message: string
}

export interface CheckOptions {
  /** Prisma model delegates (`employee`, `leaveType`, …) — rule 2 recognises a query by them. */
  delegates: ReadonlySet<string>
}

// ─── What the rules know ────────────────────────────────────────────────────

/** Prisma's query methods. `x.employee.findMany(...)` is a query; `list.find(...)` is not. */
const QUERY_METHODS = new Set([
  'findMany', 'findFirst', 'findFirstOrThrow', 'findUnique', 'findUniqueOrThrow',
  'create', 'createMany', 'createManyAndReturn',
  'update', 'updateMany', 'updateManyAndReturn', 'upsert',
  'delete', 'deleteMany',
  'count', 'aggregate', 'groupBy',
])

/** The client's own methods: transactions, raw SQL, extensions, the connection. */
const CLIENT_METHODS = new Set([
  '$transaction', '$queryRaw', '$queryRawUnsafe', '$executeRaw', '$executeRawUnsafe',
  '$extends', '$connect', '$disconnect', '$on', '$use',
])

const ROLE_NAMES = new Set(['super_admin', 'admin', 'hr', 'manager', 'rm', 'accounts', 'employee'])

/**
 * Rule 7's list. Values that exist only as statutory rates or thresholds are
 * refused whatever their spelling (21_000 is 21000). 0.40, 0.50 and 0.10 are
 * refused as written — a rate written as a rate — because 0.5 is also a half
 * day. 200 and 300 are the PT amounts, and also HTTP OK and a length limit, so
 * they are refused except in those two places.
 */
const STATUTORY_VALUES = new Set([0.12, 0.0075, 0.0325, 0.0833, 0.0367, 21000, 15000, 1250])
const STATUTORY_SPELLINGS = new Set(['0.40', '0.50', '0.10'])
const PT_AMOUNTS = new Set([200, 300])

// ─── The tree ───────────────────────────────────────────────────────────────

interface Node {
  type: string
  loc?: { start: { line: number; column: number } }
  [key: string]: unknown
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'tokens'])

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as Node).type === 'string'
}

/** Depth-first, with the chain of ancestors — nearest last. */
function walk(node: Node, visit: (node: Node, ancestors: Node[]) => void, ancestors: Node[] = []) {
  visit(node, ancestors)
  ancestors.push(node)
  for (const key of Object.keys(node)) {
    if (SKIP_KEYS.has(key)) continue
    const value = node[key]
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, ancestors)
    } else if (isNode(value)) {
      walk(value, visit, ancestors)
    }
  }
  ancestors.pop()
}

// Narrowed to the node kind, so that on the false side a Node stays a Node.
type Member = Node & { type: 'MemberExpression' | 'OptionalMemberExpression' }
type Call = Node & { type: 'CallExpression' | 'OptionalCallExpression' }

const isMember = (n: unknown): n is Member =>
  isNode(n) && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')
const isCall = (n: unknown): n is Call =>
  isNode(n) && (n.type === 'CallExpression' || n.type === 'OptionalCallExpression')

/** The name a member access reaches: `a.b` → "b", `a['b']` → "b". */
function propertyName(member: Node): string | null {
  const property = member.property as Node
  if (!member.computed && property.type === 'Identifier') return property.name as string
  if (property.type === 'StringLiteral') return property.value as string
  return null
}

/** Parentheses and TypeScript's `as`, `!` and `satisfies` change nothing a rule cares about. */
function unwrap(node: Node): Node {
  let n = node
  while (['TSAsExpression', 'TSNonNullExpression', 'TSSatisfiesExpression', 'ParenthesizedExpression', 'TSTypeAssertion'].includes(n.type)) {
    n = n.expression as Node
  }
  return n
}

/** Does this expression name a role — `role`, `user.role`, `membership?.role`? */
function isRoleExpression(node: Node): boolean {
  const n = unwrap(node)
  if (n.type === 'Identifier') return n.name === 'role'
  if (isMember(n)) return propertyName(n) === 'role'
  return false
}

function isRoleName(node: Node): boolean {
  const n = unwrap(node)
  return n.type === 'StringLiteral' && ROLE_NAMES.has(n.value as string)
}

// ─── The rules ──────────────────────────────────────────────────────────────

/**
 * Checks one file. `file` is its path relative to server/src, with forward
 * slashes — the rules are about where a file sits.
 */
export function checkSource(file: string, code: string, options: CheckOptions): Violation[] {
  const violations: Violation[] = []
  const isTest = /\.test\.ts$/.test(file)
  const isRepository = /\.repository\.ts$/.test(file)
  const inPlatformDb = file.startsWith('platform/db/')
  const inHttp = file.startsWith('http/')
  const inDomain = file.startsWith('domain/')
  // app.ts assembles Express and main.ts starts it: the top of the HTTP layer.
  const isHttpRoot = file === 'app.ts' || file === 'main.ts'
  const isSerializer = file.startsWith('http/serializers/')
  // Where responses are shaped. Validators, middleware and the request context
  // build other things — a zod schema from parts, the context from the session.
  const shapesResponses = isSerializer || file.startsWith('http/controllers/')

  // A file that does not parse is not something to report and move past.
  const ast = parse(code, { sourceType: 'module', plugins: ['typescript'], sourceFilename: file }) as unknown as { program: Node }

  // One report per rule per line: `ctx.db.employee.findFirst()` is one mistake, not two.
  const seen = new Set<string>()
  const report = (node: Node, rule: Rule, message: string) => {
    const start = node.loc?.start ?? { line: 1, column: 0 }
    const key = `${rule}:${start.line}`
    if (seen.has(key)) return
    seen.add(key)
    violations.push({ file, line: start.line, column: start.column + 1, rule, message })
  }

  /** Where an import points, as a path relative to src, or the package name. */
  const target = (source: string) => (source.startsWith('.') ? join(dirname(file), source).split(sep).join('/') : source)

  walk(ast.program, (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1]

    // ── Imports: rules 1, 3 and 4 ───────────────────────────────────────────
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') &&
      isNode(node.source)
    ) {
      const source = node.source.value as string
      const to = target(source)
      const typeOnly = node.importKind === 'type' || node.exportKind === 'type'

      // Rule 1 — the raw client reaches the rest of the code only through
      // scoped.ts (company-filtered) and unsafe.ts (the conspicuous exception).
      const rawClientFiles = ['platform/db/prisma.ts', 'platform/db/scoped.ts', 'platform/db/unsafe.ts']
      // main.ts owns the process, and closes the client on the way out — the
      // one thing it takes from there (guide, Day 1: graceful shutdown).
      const closesOnly =
        file === 'main.ts' &&
        ((node.specifiers as Node[] | undefined) ?? []).every((s) => (s.imported as Node | undefined)?.name === 'disconnect')
      if (!isTest && !rawClientFiles.includes(file) && !typeOnly && !closesOnly) {
        if (to === 'platform/db/prisma') {
          report(node, 'R1', 'imports the raw Prisma client; use ctx.db (scoped) or unsafeDb (pre-organization flows only)')
        }
        const specifiers = (node.specifiers as Node[] | undefined) ?? []
        if (source === '@prisma/client' && specifiers.some((s) => (s.imported as Node | undefined)?.name === 'PrismaClient' && s.importKind !== 'type')) {
          report(node, 'R1', 'constructs its own PrismaClient; there is exactly one, in platform/db/prisma.ts')
        }
      }

      // Rule 3 — Express stays in the HTTP layer.
      if (!isTest && !inHttp && !isHttpRoot && source === 'express') {
        report(node, 'R3', 'imports express below http/; a service takes plain values, not a request')
      }

      // Rule 4 — the domain is pure: no database, no framework, no other layer.
      if (inDomain) {
        const allowed = source.startsWith('.') ? to.startsWith('domain/') : isTest && source === 'vitest'
        if (!allowed) report(node, 'R4', `domain/ imports "${source}"; it may only import other domain/ files`)
      }
    }

    // Rule 1, the other way in.
    if (!isTest && node.type === 'NewExpression' && (node.callee as Node).type === 'Identifier' && (node.callee as Node).name === 'PrismaClient' && file !== 'platform/db/prisma.ts') {
      report(node, 'R1', 'constructs its own PrismaClient; there is exactly one, in platform/db/prisma.ts')
    }

    // ── Rule 2 — queries live in repositories ───────────────────────────────
    if (!isTest && !isRepository && !inPlatformDb) {
      if (isCall(node) && isMember(node.callee)) {
        const method = propertyName(node.callee)
        const owner = (node.callee as Node).object as Node
        if (method && QUERY_METHODS.has(method) && isMember(owner)) {
          const delegate = propertyName(owner)
          if (delegate && options.delegates.has(delegate)) {
            report(node, 'R2', `queries the database (.${delegate}.${method}) outside a repository; move it into a *.repository.ts function`)
          }
        }
      }
      if (isMember(node)) {
        const name = propertyName(node)
        if (name && CLIENT_METHODS.has(name)) {
          report(node, 'R2', `uses the database client (${name}) outside a repository; transactions go through withTransaction()`)
        }
        // `ctx.db` may be handed to a repository; nothing may be read off it here.
        const object = unwrap(node.object as Node)
        if (isMember(object) && propertyName(object) === 'db' && unwrap(object.object as Node).type === 'Identifier' && (unwrap(object.object as Node).name === 'ctx')) {
          if (!(name && CLIENT_METHODS.has(name))) {
            report(node, 'R2', `reaches into ctx.db${name ? '.' + name : ''} outside a repository; pass ctx.db to a repository function instead`)
          }
        }
      }
    }

    // ── Rule 3 — no request or response objects below http/ ─────────────────
    if (!isTest && !inHttp && !isHttpRoot && (node.type === 'Identifier') && (node.name === 'req' || node.name === 'res')) {
      const isParam = parent && ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod'].includes(parent.type) &&
        (parent.params as Node[]).includes(node)
      if (isParam) report(node, 'R3', `takes "${node.name as string}" below http/; controllers turn requests into plain values`)
    }

    // ── Rule 5 — ask can(), never the role ──────────────────────────────────
    if (!isTest) {
      if (node.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(node.operator as string)) {
        const left = node.left as Node
        const right = node.right as Node
        if ((isRoleExpression(left) && isRoleName(right)) || (isRoleName(left) && isRoleExpression(right))) {
          report(node, 'R5', 'compares a role; ask can(permission) instead, so the permission can move between roles')
        }
      }
      if (node.type === 'SwitchStatement' && isRoleExpression(node.discriminant as Node) &&
        (node.cases as Node[]).some((c) => c.test && isRoleName(c.test as Node))) {
        report(node, 'R5', 'switches on a role; ask can(permission) instead')
      }
      if (isCall(node) && isMember(node.callee) && propertyName(node.callee) === 'includes') {
        const list = unwrap((node.callee as Node).object as Node)
        const args = node.arguments as Node[]
        if (list.type === 'ArrayExpression' && (list.elements as Node[]).some((e) => e && isRoleName(e)) && args[0] && isRoleExpression(args[0])) {
          report(node, 'R5', 'checks a role against a list; ask can(permission) instead')
        }
      }
    }

    // ── Rule 6 — serializers list their fields and invent nothing ───────────
    if (!isTest && shapesResponses) {
      if (node.type === 'LogicalExpression' && (node.operator === '??' || node.operator === '||')) {
        const fallback = unwrap(node.right as Node)
        const invented = ['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'TemplateLiteral', 'ArrayExpression', 'ObjectExpression'].includes(fallback.type)
        // Climb past wrappers to see whether this is the value of a response field.
        let i = ancestors.length - 1
        while (i >= 0 && ['TSAsExpression', 'TSNonNullExpression', 'ParenthesizedExpression', 'ConditionalExpression', 'LogicalExpression'].includes(ancestors[i]!.type)) i--
        const holder = ancestors[i]
        if (invented && holder?.type === 'ObjectProperty') {
          report(node, 'R6', `falls back to a made-up value (${node.operator as string} ${fallback.type.replace('Literal', '').toLowerCase()}); send null, or the real value`)
        }
      }
      if (node.type === 'SpreadElement' && parent?.type === 'ObjectExpression') {
        const argument = unwrap(node.argument as Node)
        const copiesRow = argument.type === 'Identifier' || isMember(argument)
        // `meta: { requestId, ...extra }` spreads response metadata, not a row.
        const grand = ancestors[ancestors.length - 2]
        const inMeta = grand?.type === 'ObjectProperty' && ((grand.key as Node).name === 'meta')
        if (copiesRow && (isSerializer || !inMeta)) {
          report(node, 'R6', 'spreads an object into a response, sending whatever it holds; list the fields instead')
        }
      }
    }

    // ── Rule 7 — statutory numbers live in domain/ ──────────────────────────
    if (!isTest && !inDomain && node.type === 'NumericLiteral') {
      const value = node.value as number
      const raw = ((node.extra as { raw?: string } | undefined)?.raw ?? String(value)).replace(/_/g, '')
      if (STATUTORY_VALUES.has(value) || STATUTORY_SPELLINGS.has(raw)) {
        report(node, 'R7', `hardcodes ${raw}, a statutory rate or threshold; it belongs in domain/ or in settings`)
      } else if (PT_AMOUNTS.has(value) && !isStatusOrLength(node, ancestors)) {
        report(node, 'R7', `hardcodes ${raw}, a professional-tax amount; PT comes from the state's slabs`)
      }
    }

    // ── Rule 8 — calendar days come from dates.ts ───────────────────────────
    if (file !== 'domain/shared/dates.ts' && isMember(node) && propertyName(node) === 'toISOString') {
      report(node, 'R8', 'calls toISOString(); use fromDateColumn / zonedToday for a day, isoInstant for a moment (domain/shared/dates.ts)')
    }
  })

  return violations
}

/**
 * 200 and 300 are allowed as an HTTP status (`res.status(200)`, `reply(res, 200)`,
 * `status(dryRun ? 200 : 201)`) and as a length limit (`.max(200)`,
 * `optionalText(300)`, `text.length > 200`).
 */
function isStatusOrLength(literal: Node, ancestors: Node[]): boolean {
  let child: Node = literal
  let i = ancestors.length - 1
  while (i >= 0 && ['ConditionalExpression', 'TSAsExpression', 'ParenthesizedExpression'].includes(ancestors[i]!.type)) {
    child = ancestors[i]!
    i--
  }
  const holder = ancestors[i]
  if (!holder) return false

  if (isCall(holder) && (holder.arguments as Node[]).includes(child)) {
    const callee = holder.callee as Node
    const name = isMember(callee) ? propertyName(callee) : callee.type === 'Identifier' ? (callee.name as string) : null
    if (name && ['status', 'sendStatus', 'max', 'min', 'length', 'optionalText'].includes(name)) return true
    const first = (holder.arguments as Node[])[0]
    if (first && first.type === 'Identifier' && first.name === 'res') return true
  }
  if (holder.type === 'BinaryExpression') {
    const other = holder.left === child ? (holder.right as Node) : (holder.left as Node)
    if (isMember(other) && propertyName(other) === 'length') return true
  }
  return false
}

// ─── The whole tree ─────────────────────────────────────────────────────────

/** Model names from the Prisma schema, as the client's delegates spell them. */
export function prismaDelegates(schemaDir: string): Set<string> {
  const names = new Set<string>()
  for (const file of readdirSync(schemaDir)) {
    if (!file.endsWith('.prisma')) continue
    for (const match of readFileSync(join(schemaDir, file), 'utf8').matchAll(/^model\s+(\w+)/gm)) {
      const model = match[1]!
      names.add(model[0]!.toLowerCase() + model.slice(1))
    }
  }
  return names
}

function listTs(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listTs(full, out)
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) out.push(full)
  }
  return out
}

/** Every violation under `serverRoot/src`, in file order. */
export function checkServer(serverRoot: string): Violation[] {
  const src = resolve(serverRoot, 'src')
  const options = { delegates: prismaDelegates(resolve(serverRoot, 'prisma/schema')) }
  return listTs(src).flatMap((full) =>
    checkSource(relative(src, full).split(sep).join('/'), readFileSync(full, 'utf8'), options),
  )
}

export const RULES: Record<Rule, string> = {
  R1: 'only platform/db/scoped.ts and unsafe.ts import the raw Prisma client',
  R2: 'database queries only in *.repository.ts',
  R3: 'req / res never below http/',
  R4: 'domain/ imports nothing from the rest of the project',
  R5: 'never compare a role; ask can(permission)',
  R6: 'serializers list fields and invent no fallback values',
  R7: 'no statutory constant outside domain/',
  R8: 'no toISOString() outside domain/shared/dates.ts',
}
