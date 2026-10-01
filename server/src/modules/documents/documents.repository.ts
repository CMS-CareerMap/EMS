import type { CompanyDocumentCategory, DocumentStatus, Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'
import type { ScopeContext } from '../../platform/authz/scope'
import { employeesInScope, ownedRowsInScope } from '../../platform/authz/scopeWhere'

/**
 * Documents: the checklist of types, each employee's files, and the company's.
 *
 * Employee files are read through the DATA SCOPE like everything personal —
 * ORGANIZATION for HR and Admin, SELF for everybody else. A document outside
 * scope is not found, never forbidden, so an id cannot be probed.
 */

type Db = ScopedDb | TxDb

/**
 * Whose documents a caller reaches. The built-in roles give documents only
 * "the whole company" or "their own"; since Day 21 a role can be given a team
 * or a department here as well, so the shared definition is used.
 */
function ownerWhere(scope: ScopeContext): Prisma.EmployeeDocumentWhereInput {
  return ownedRowsInScope(scope)
}

/** The same scope on employees — people still on the books. */
function employeeWhere(scope: ScopeContext): Prisma.EmployeeWhereInput {
  return { AND: [employeesInScope(scope), { archivedAt: null }] }
}

// ── The checklist ───────────────────────────────────────────────────────────

const typeSelect = { id: true, code: true, label: true, required: true, displayOrder: true, archivedAt: true } as const
export type DocumentTypeRow = Prisma.DocumentTypeGetPayload<{ select: typeof typeSelect }>

export async function listTypes(db: Db, includeArchived = false): Promise<DocumentTypeRow[]> {
  return db.documentType.findMany({
    where: includeArchived ? {} : { archivedAt: null },
    orderBy: [{ displayOrder: 'asc' }, { label: 'asc' }],
    select: typeSelect,
  })
}

export async function findType(db: Db, id: string): Promise<DocumentTypeRow | null> {
  return db.documentType.findFirst({ where: { id }, select: typeSelect })
}

export async function typeCodesLike(db: Db, prefix: string): Promise<string[]> {
  const rows = await db.documentType.findMany({ where: { code: { startsWith: prefix } }, select: { code: true } })
  return rows.map((r) => r.code)
}

export async function typeLabelTaken(db: Db, label: string, exceptId?: string): Promise<boolean> {
  const row = await db.documentType.findFirst({
    where: { label: { equals: label, mode: 'insensitive' }, archivedAt: null, ...(exceptId ? { id: { not: exceptId } } : {}) },
    select: { id: true },
  })
  return row !== null
}

export async function nextDisplayOrder(db: Db): Promise<number> {
  const top = await db.documentType.aggregate({ _max: { displayOrder: true } })
  return (top._max.displayOrder ?? 0) + 1
}

export async function createType(
  tx: TxDb,
  values: { organizationId: string; code: string; label: string; required: boolean; displayOrder: number },
): Promise<DocumentTypeRow> {
  return tx.documentType.create({ data: values, select: typeSelect })
}

export async function updateType(
  tx: TxDb,
  id: string,
  values: { label?: string; required?: boolean; displayOrder?: number; archivedAt?: Date | null },
): Promise<DocumentTypeRow> {
  return tx.documentType.update({ where: { id }, data: values, select: typeSelect })
}

// ── Employees' files ────────────────────────────────────────────────────────

export async function findEmployee(db: Db, scope: ScopeContext, employeeId: string) {
  return db.employee.findFirst({
    where: { AND: [employeeWhere(scope), { id: employeeId }] },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      status: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
    },
  })
}

const documentSelect = {
  id: true,
  employeeId: true,
  documentTypeId: true,
  fileName: true,
  contentType: true,
  bytes: true,
  sha256: true,
  storageKey: true,
  status: true,
  remarks: true,
  decidedByUserId: true,
  decidedAt: true,
  uploadedByUserId: true,
  uploadedAt: true,
  supersededAt: true,
  removedAt: true,
  documentType: { select: { code: true, label: true, required: true } },
  employee: { select: { employeeCode: true, fullName: true } },
} as const

export type DocumentRow = Prisma.EmployeeDocumentGetPayload<{ select: typeof documentSelect }>

/** Current files — not replaced by a newer upload, not taken off the list. */
export async function currentDocumentsOf(db: Db, employeeId: string): Promise<DocumentRow[]> {
  return db.employeeDocument.findMany({
    where: { employeeId, supersededAt: null, removedAt: null },
    orderBy: { uploadedAt: 'desc' },
    select: documentSelect,
  })
}

/** Files that were replaced — kept, and still readable by whoever may read the current one. */
export async function earlierDocumentsOf(db: Db, employeeId: string): Promise<DocumentRow[]> {
  return db.employeeDocument.findMany({
    where: { employeeId, supersededAt: { not: null }, removedAt: null },
    orderBy: { uploadedAt: 'desc' },
    take: 100,
    select: documentSelect,
  })
}

export async function findDocument(db: Db, scope: ScopeContext, id: string): Promise<DocumentRow | null> {
  return db.employeeDocument.findFirst({
    where: { AND: [ownerWhere(scope), { id, removedAt: null }] },
    select: documentSelect,
  })
}

export async function supersedeCurrent(tx: TxDb, employeeId: string, documentTypeId: string, at: Date): Promise<number> {
  const result = await tx.employeeDocument.updateMany({
    where: { employeeId, documentTypeId, supersededAt: null, removedAt: null },
    data: { supersededAt: at },
  })
  return result.count
}

export interface DocumentValues {
  id: string
  organizationId: string
  employeeId: string
  documentTypeId: string
  fileName: string
  contentType: string
  bytes: number
  sha256: string
  storageKey: string
  uploadedByUserId: string
  status: DocumentStatus
  remarks: string | null
  decidedByUserId: string | null
  decidedAt: Date | null
}

export async function createDocument(tx: TxDb, values: DocumentValues): Promise<{ id: string }> {
  return tx.employeeDocument.create({ data: values, select: { id: true } })
}

/** A decision on a file still waiting for one — compared and changed in one statement. */
export async function decideIfPending(
  tx: TxDb,
  id: string,
  values: { status: DocumentStatus; remarks: string | null; decidedByUserId: string; decidedAt: Date },
): Promise<number> {
  const result = await tx.employeeDocument.updateMany({
    where: { id, status: 'pending', supersededAt: null, removedAt: null },
    data: values,
  })
  return result.count
}

/**
 * Takes a document off the list. `onlyIfUnchecked` is for the owner: it
 * removes the row only while it is still the current, undecided upload — so a
 * decision that lands a moment earlier wins, instead of being withdrawn.
 */
export async function removeDocument(tx: TxDb, id: string, userId: string, onlyIfUnchecked: boolean): Promise<number> {
  const result = await tx.employeeDocument.updateMany({
    where: { id, removedAt: null, ...(onlyIfUnchecked ? { status: 'pending' as const, supersededAt: null } : {}) },
    data: { removedAt: new Date(), removedByUserId: userId },
  })
  return result.count
}

/**
 * When the current upload is taken off, the one it replaced is current again
 * — a verified PAN is not lost because a second copy was sent by mistake.
 * Returns the id brought back, if any.
 */
export async function restorePrevious(tx: TxDb, employeeId: string, documentTypeId: string): Promise<string | null> {
  const previous = await tx.employeeDocument.findFirst({
    where: { employeeId, documentTypeId, removedAt: null, supersededAt: { not: null } },
    orderBy: { uploadedAt: 'desc' },
    select: { id: true },
  })
  if (!previous) return null
  await tx.employeeDocument.update({ where: { id: previous.id }, data: { supersededAt: null } })
  return previous.id
}

/** Everybody who is on the books, for the compliance list. */
export async function activeEmployees(db: Db, scope: ScopeContext) {
  return db.employee.findMany({
    where: { AND: [employeesInScope(scope), { archivedAt: null, status: 'active' }] },
    orderBy: { fullName: 'asc' },
    select: { id: true, employeeCode: true, fullName: true, department: { select: { name: true } } },
  })
}

/** Current files by person, type and status — counted in Postgres. */
export async function currentStatusCounts(db: Db, scope: ScopeContext) {
  return db.employeeDocument.groupBy({
    by: ['employeeId', 'documentTypeId', 'status'],
    where: { AND: [ownerWhere(scope), { supersededAt: null, removedAt: null }] },
    _count: { _all: true },
  })
}

/** What is waiting for somebody to look at it, oldest first. */
export async function waitingForDecision(db: Db, scope: ScopeContext): Promise<DocumentRow[]> {
  return db.employeeDocument.findMany({
    where: { AND: [ownerWhere(scope), { status: 'pending', supersededAt: null, removedAt: null, employee: { archivedAt: null } }] },
    orderBy: { uploadedAt: 'asc' },
    take: 250,
    select: documentSelect,
  })
}

// ── The company's documents ─────────────────────────────────────────────────

const companySelect = {
  id: true,
  title: true,
  category: true,
  description: true,
  fileName: true,
  contentType: true,
  bytes: true,
  sha256: true,
  storageKey: true,
  uploadedByUserId: true,
  uploadedAt: true,
} as const

export type CompanyDocumentRow = Prisma.CompanyDocumentGetPayload<{ select: typeof companySelect }>

export async function listCompanyDocuments(db: Db): Promise<CompanyDocumentRow[]> {
  return db.companyDocument.findMany({ where: { removedAt: null }, orderBy: { uploadedAt: 'desc' }, select: companySelect })
}

export async function findCompanyDocument(db: Db, id: string): Promise<CompanyDocumentRow | null> {
  return db.companyDocument.findFirst({ where: { id, removedAt: null }, select: companySelect })
}

export async function createCompanyDocument(
  tx: TxDb,
  values: {
    id: string
    organizationId: string
    title: string
    category: CompanyDocumentCategory
    description: string | null
    fileName: string
    contentType: string
    bytes: number
    sha256: string
    storageKey: string
    uploadedByUserId: string
  },
): Promise<{ id: string }> {
  return tx.companyDocument.create({ data: values, select: { id: true } })
}

export async function removeCompanyDocument(tx: TxDb, id: string, userId: string): Promise<number> {
  const result = await tx.companyDocument.updateMany({ where: { id, removedAt: null }, data: { removedAt: new Date(), removedByUserId: userId } })
  return result.count
}

/** Who uploaded or decided, by name, for the screens. */
export async function namesOfUsers(db: Db, userIds: readonly string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter(Boolean)
  if (ids.length === 0) return new Map()
  const rows = await db.membership.findMany({
    where: { userId: { in: ids } },
    select: { userId: true, employee: { select: { fullName: true } }, user: { select: { email: true } } },
  })
  return new Map(rows.map((r) => [r.userId, r.employee?.fullName ?? r.user.email]))
}
