import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { audit } from '../audit/audit.service'
import * as repo from './documents.repository'

/**
 * The checklist: which documents the company asks every employee for, and
 * which of them it cannot do without.
 *
 * Seeded with the usual Indian set (bootstrap and the Day 19 migration) and
 * editable, so a company that also wants an address proof adds one here. A
 * type is archived, never deleted — documents filed under it keep their name.
 */

export async function listTypes(ctx: AppContext, includeArchived = false) {
  return repo.listTypes(ctx.db, includeArchived)
}

/** "Address Proof" → address_proof, made unique within the company. */
async function codeFor(ctx: AppContext, label: string): Promise<string> {
  const base =
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'document'
  const taken = new Set(await repo.typeCodesLike(ctx.db, base))
  if (!taken.has(base)) return base
  for (let n = 2; n < 1000; n++) {
    if (!taken.has(`${base}_${n}`)) return `${base}_${n}`
  }
  throw Conflict('Too many document types with that name.')
}

export interface TypeInput {
  label: string
  required: boolean
}

export async function createType(ctx: AppContext, input: TypeInput) {
  const label = input.label.trim()
  if (await repo.typeLabelTaken(ctx.db, label)) throw Conflict(`There is already a document type called "${label}".`)

  const code = await codeFor(ctx, label)
  const displayOrder = await repo.nextDisplayOrder(ctx.db)

  return withTransaction(ctx.db, async (tx) => {
    const row = await repo.createType(tx, { organizationId: ctx.organizationId, code, label, required: input.required, displayOrder })
    await audit(ctx, { action: 'document_type.created', entityType: 'document_type', entityId: row.id, details: { code, label, required: input.required } }, tx)
    return row
  })
}

export interface TypeChange {
  label?: string | undefined
  required?: boolean | undefined
  displayOrder?: number | undefined
}

export async function updateType(ctx: AppContext, id: string, change: TypeChange) {
  const current = await repo.findType(ctx.db, id)
  if (!current) throw NotFound('Document type not found')

  const values: { label?: string; required?: boolean; displayOrder?: number } = {}
  if (change.label !== undefined) {
    const label = change.label.trim()
    if (!label) throw BadRequest('Give the document type a name.')
    if (await repo.typeLabelTaken(ctx.db, label, id)) throw Conflict(`There is already a document type called "${label}".`)
    values.label = label
  }
  if (change.required !== undefined) values.required = change.required
  if (change.displayOrder !== undefined) values.displayOrder = change.displayOrder
  if (Object.keys(values).length === 0) throw BadRequest('Nothing to change')

  return withTransaction(ctx.db, async (tx) => {
    const row = await repo.updateType(tx, id, values)
    await audit(ctx, {
      action: 'document_type.updated',
      entityType: 'document_type',
      entityId: id,
      details: { code: current.code, before: { label: current.label, required: current.required }, after: values },
    }, tx)
    return row
  })
}

export async function setArchived(ctx: AppContext, id: string, archived: boolean) {
  const current = await repo.findType(ctx.db, id)
  if (!current) throw NotFound('Document type not found')
  if (archived === (current.archivedAt !== null)) return current

  if (!archived && (await repo.typeLabelTaken(ctx.db, current.label, id))) {
    throw Conflict(`Another document type is now called "${current.label}". Rename one of them first.`)
  }

  return withTransaction(ctx.db, async (tx) => {
    const row = await repo.updateType(tx, id, { archivedAt: archived ? new Date() : null })
    await audit(ctx, {
      action: archived ? 'document_type.archived' : 'document_type.restored',
      entityType: 'document_type',
      entityId: id,
      details: { code: current.code, label: current.label },
    }, tx)
    return row
  })
}
