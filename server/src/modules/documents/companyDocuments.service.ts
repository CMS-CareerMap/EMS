import type { CompanyDocumentCategory } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { AppError, BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { logger } from '../../platform/logger'
import { discardUpload, storeUpload, type IncomingFile } from '../../platform/storage/files'
import { readStored } from '../files/readStored'
import { FILE_KINDS, kindForContentType } from '../../domain/files/fileRules'
import { audit, recordSecurityEvent } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { uploadLimitMb } from '../organization/organization.service'
import * as repo from './documents.repository'

/**
 * The company's own documents — the handbook, the leave policy, a form.
 *
 * Everybody reads them (§5 of the client's document: "All"). HR and Admin
 * publish and withdraw them. The old page listed four documents that did not
 * exist, "uploaded by Anita Rao", and its Download button was an alert().
 */

export async function list(ctx: AppContext) {
  const rows = await repo.listCompanyDocuments(ctx.db)
  const names = await repo.namesOfUsers(ctx.db, rows.map((r) => r.uploadedByUserId).filter((v): v is string => Boolean(v)))
  return { rows, names }
}

export interface PublishInput {
  title: string
  category: CompanyDocumentCategory
  description?: string | null | undefined
}

export async function publish(ctx: AppContext, input: PublishInput, file: IncomingFile | null) {
  if (!file) throw BadRequest('Choose a file to publish.')
  const title = input.title.trim()
  if (!title) throw BadRequest('Give the document a title.')

  const stored = await storeUpload(
    file,
    { organizationId: ctx.organizationId, kind: 'company-document', ownerId: ctx.organizationId },
    await uploadLimitMb(ctx),
  )

  try {
    await withTransaction(ctx.db, async (tx) => {
      await repo.createCompanyDocument(tx, {
        id: stored.id,
        organizationId: ctx.organizationId,
        title,
        category: input.category,
        description: input.description?.trim() || null,
        fileName: stored.fileName,
        contentType: stored.contentType,
        bytes: stored.bytes,
        sha256: stored.sha256,
        storageKey: stored.key,
        uploadedByUserId: ctx.userId,
      })
      await audit(ctx, {
        action: 'company_document.published',
        entityType: 'company_document',
        entityId: stored.id,
        details: { title, category: input.category, bytes: stored.bytes },
      }, tx)
      await notify(ctx, tx, {
        event: 'company_document.published',
        to: { everybody: true },
        title: 'New company document',
        message: `${title} has been published.`,
        link: '/documents?tab=company',
        entity: { type: 'company_document', id: stored.id },
      })
    })
  } catch (err) {
    // Only when the upload was surely rolled back — our own refusal. Any other
    // failure may have come after the commit; the nightly sweep handles those.
    if (err instanceof AppError) await discardUpload(stored.key)
    throw err
  }

  logger.info('Company document published', { by: ctx.userId, id: stored.id })
  const row = await repo.findCompanyDocument(ctx.db, stored.id)
  if (!row) throw NotFound('Document was stored but could not be read back')
  return row
}

export async function download(ctx: AppContext, id: string) {
  const doc = await repo.findCompanyDocument(ctx.db, id)
  if (!doc) throw NotFound('Document not found')

  const kind = kindForContentType(doc.contentType)
  if (!kind) throw Conflict('This file is of a type the system no longer serves.')
  const bytes = await readStored(ctx, { key: doc.storageKey, sha256: doc.sha256 }, { type: 'company_document', id: doc.id })

  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    requestId: ctx.requestId,
    action: 'company_document.downloaded',
    entityType: 'company_document',
    entityId: doc.id,
    details: { title: doc.title },
  })

  const base = doc.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'document'
  return { filename: `${base}.${FILE_KINDS[kind].extensions[0]}`, bytes, contentType: FILE_KINDS[kind].contentType }
}

export async function remove(ctx: AppContext, id: string) {
  const doc = await repo.findCompanyDocument(ctx.db, id)
  if (!doc) throw NotFound('Document not found')

  await withTransaction(ctx.db, async (tx) => {
    const changed = await repo.removeCompanyDocument(tx, id, ctx.userId)
    if (changed === 0) throw Conflict('That document was removed a moment ago.')
    await audit(ctx, { action: 'company_document.removed', entityType: 'company_document', entityId: id, details: { title: doc.title } }, tx)
  })
}
