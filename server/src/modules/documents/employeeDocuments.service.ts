import type { AppContext } from '../../platform/context'
import { AppError, BadRequest, Conflict, Forbidden, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { discardUpload, storeUpload, type IncomingFile } from '../../platform/storage/files'
import { readStored } from '../files/readStored'
import { kindForContentType, FILE_KINDS } from '../../domain/files/fileRules'
import { audit, recordSecurityEvent } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { uploadLimitMb } from '../organization/organization.service'
import * as repo from './documents.repository'
import { assertWorkGoesUp, checkWork, loadWork } from '../organization/workRules.service'

/**
 * Each employee's documents — Aadhaar, PAN, the offer letter — and their
 * verification.
 *
 * The rules the old screens broke:
 *   · Nobody verifies their own document. The old table let an employee mark
 *     their own Aadhaar verified; so could HR, for HR's own.
 *   · A file is what the server says it is. The type comes from the bytes, the
 *     name never reaches a path, and it is served as an attachment only.
 *   · Uploading again REPLACES the current file but does not destroy it. The
 *     earlier one stays readable, because "which PAN did we hold in March?" is
 *     a question HR gets asked.
 */

function ownOf(ctx: AppContext, employeeId: string) {
  return ctx.employeeId !== null && ctx.employeeId === employeeId
}

async function employeeInScope(ctx: AppContext, employeeId: string) {
  const employee = await repo.findEmployee(ctx.db, ctx.scopeFor('document'), employeeId)
  if (!employee) throw NotFound('Employee not found')
  return employee
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** One person's checklist: every type the company asks for, with the file on hand for each. */
export async function checklist(ctx: AppContext, employeeId?: string) {
  const target = employeeId ?? ctx.employeeId
  if (!target) throw NotFound('This login has no employee record, so it has no documents.')

  const employee = await employeeInScope(ctx, target)
  const [types, current, earlier] = await Promise.all([
    repo.listTypes(ctx.db),
    repo.currentDocumentsOf(ctx.db, target),
    repo.earlierDocumentsOf(ctx.db, target),
  ])

  const names = await repo.namesOfUsers(
    ctx.db,
    [...current, ...earlier].flatMap((d) => [d.uploadedByUserId, d.decidedByUserId]).filter((v): v is string => Boolean(v)),
  )

  const activeTypeIds = new Set(types.map((t) => t.id))
  // Whether the caller may check these documents (Day 22: own work goes up the
  // tree), and if not, whom to ask.
  const check = ctx.can('document:verify') ? checkWork(ctx, await loadWork(ctx.db, ctx.organizationId, 'documents'), target) : null
  return {
    employee,
    own: ownOf(ctx, target),
    mayCheck: Boolean(check?.allowed),
    checkGoesTo: check && !check.allowed ? check.ask : null,
    names,
    items: types.map((type) => ({
      type,
      current: current.find((d) => d.documentTypeId === type.id) ?? null,
      earlier: earlier.filter((d) => d.documentTypeId === type.id),
    })),
    // Files kept under a type the company has since stopped asking for.
    other: current.filter((d) => !activeTypeIds.has(d.documentTypeId)),
  }
}

/**
 * Where everybody stands: required documents verified, waiting, rejected and
 * missing, per person — and the queue of files waiting to be checked.
 */
export async function compliance(ctx: AppContext) {
  // An overview of other people. Somebody who reaches only their own documents
  // has their checklist instead; anybody wider sees the people their role
  // reaches — the whole company, or since Day 21 a team or a department.
  const scope = ctx.scopeFor('document')
  if (scope.scope === 'SELF') throw Forbidden('Not permitted')

  const [employees, types, counts, waiting] = await Promise.all([
    repo.activeEmployees(ctx.db, scope),
    repo.listTypes(ctx.db),
    repo.currentStatusCounts(ctx.db, scope),
    repo.waitingForDecision(ctx.db, scope),
  ])

  const required = types.filter((t) => t.required)
  const requiredIds = new Set(required.map((t) => t.id))
  const statusOf = new Map<string, string>()
  for (const row of counts) statusOf.set(`${row.employeeId}:${row.documentTypeId}`, row.status)

  return {
    requiredTypes: required,
    employees: employees.map((e) => {
      let verified = 0
      let pending = 0
      let rejected = 0
      for (const typeId of requiredIds) {
        const status = statusOf.get(`${e.id}:${typeId}`)
        if (status === 'verified') verified++
        else if (status === 'pending') pending++
        else if (status === 'rejected') rejected++
      }
      // Everything waiting for HR — optional documents too, as the waiting list shows them.
      const waiting = types.filter((t) => statusOf.get(`${e.id}:${t.id}`) === 'pending').length
      return {
        employee: e,
        required: required.length,
        verified,
        pending,
        rejected,
        missing: required.length - verified - pending - rejected,
        waiting,
      }
    }),
    waiting,
  }
}

// ── Uploading ───────────────────────────────────────────────────────────────

export interface UploadInput {
  /** Whose document. Left out, it is the caller's own. */
  employeeId?: string | undefined
  documentTypeId: string
  /** "I have checked this against the original" — HR filing somebody else's. */
  markVerified?: boolean | undefined
}

export async function upload(ctx: AppContext, input: UploadInput, file: IncomingFile | null) {
  if (!file) throw BadRequest('Choose a file to upload.')

  const target = input.employeeId ?? ctx.employeeId
  if (!target) throw BadRequest('Choose whose document this is.')
  const employee = await employeeInScope(ctx, target)
  const own = ownOf(ctx, target)

  const type = await repo.findType(ctx.db, input.documentTypeId)
  if (!type || type.archivedAt) throw BadRequest('Choose one of the document types the company asks for.')

  if (input.markVerified) {
    if (!ctx.can('document:verify')) throw Forbidden('You cannot verify documents.')
    // Your own documents — or those of somebody who checks documents too — are
    // checked by the people above them in the company tree (Day 22).
    await assertWorkGoesUp(ctx, ctx.db, 'documents', target)
  }

  const stored = await storeUpload(
    file,
    { organizationId: ctx.organizationId, kind: 'employee-document', ownerId: target },
    await uploadLimitMb(ctx),
  )

  try {
    await withTransaction(ctx.db, async (tx) => {
      // One upload per person and type at a time, so two tabs cannot both
      // become "the current file".
      await lockFor(tx, `document:${target}:${type.id}`)
      const now = new Date()
      await repo.supersedeCurrent(tx, target, type.id, now)
      await repo.createDocument(tx, {
        id: stored.id,
        organizationId: ctx.organizationId,
        employeeId: target,
        documentTypeId: type.id,
        fileName: stored.fileName,
        contentType: stored.contentType,
        bytes: stored.bytes,
        sha256: stored.sha256,
        storageKey: stored.key,
        uploadedByUserId: ctx.userId,
        status: input.markVerified ? 'verified' : 'pending',
        remarks: input.markVerified ? 'Checked against the original when filed' : null,
        decidedByUserId: input.markVerified ? ctx.userId : null,
        decidedAt: input.markVerified ? now : null,
      })
      await audit(ctx, {
        action: 'document.uploaded',
        entityType: 'employee_document',
        entityId: stored.id,
        details: { employeeId: target, type: type.code, bytes: stored.bytes, contentType: stored.contentType, verified: Boolean(input.markVerified) },
      }, tx)

      // An employee's own upload waits for HR; HR's filing does not ask itself.
      if (own && !input.markVerified) {
        await notify(ctx, tx, {
          event: 'document.submitted',
          // Only checkers whose document scope reaches this person (Day 21),
          // and who may check theirs (Day 22: a checker's own go up the tree).
          to: { reaching: { permission: 'document:verify', resource: 'document', employeeId: target, work: 'documents' } },
          title: 'A document to check',
          message: `${employee.fullName} uploaded their ${type.label}.`,
          link: `/documents?tab=employees&employee=${target}`,
          entity: { type: 'employee_document', id: stored.id },
        })
      }
    })
  } catch (err) {
    // Only when the upload was surely rolled back — our own refusal. Any other
    // failure may have come after the commit; the nightly sweep handles those.
    if (err instanceof AppError) await discardUpload(stored.key)
    throw err
  }

  logger.info('Document uploaded', { by: ctx.userId, employeeId: target, type: type.code, bytes: stored.bytes })
  const row = await repo.findDocument(ctx.db, ctx.scopeFor('document'), stored.id)
  if (!row) throw NotFound('Document was stored but could not be read back')
  return row
}

// ── Reading the file ────────────────────────────────────────────────────────

export async function download(ctx: AppContext, id: string) {
  const doc = await repo.findDocument(ctx.db, ctx.scopeFor('document'), id)
  if (!doc) throw NotFound('Document not found')

  const kind = kindForContentType(doc.contentType)
  // A stored type outside today's allow-list is never served, whatever it was.
  if (!kind) throw Conflict('This file is of a type the system no longer serves.')

  const bytes = await readStored(ctx, { key: doc.storageKey, sha256: doc.sha256 }, { type: 'employee_document', id: doc.id })

  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    requestId: ctx.requestId,
    action: 'document.downloaded',
    entityType: 'employee_document',
    entityId: doc.id,
    details: { employeeId: doc.employeeId, type: doc.documentType.code, own: ownOf(ctx, doc.employeeId) },
  })

  const code = doc.employee.employeeCode.replace(/[^A-Za-z0-9_-]/g, '') || 'employee'
  return {
    filename: `${code}-${doc.documentType.code}.${FILE_KINDS[kind].extensions[0]}`,
    bytes,
    contentType: FILE_KINDS[kind].contentType,
  }
}

// ── Deciding ────────────────────────────────────────────────────────────────

export interface DecisionInput {
  decision: 'verified' | 'rejected'
  remarks?: string | null | undefined
}

export async function decide(ctx: AppContext, id: string, input: DecisionInput) {
  const doc = await repo.findDocument(ctx.db, ctx.scopeFor('document'), id)
  if (!doc) throw NotFound('Document not found')

  await assertWorkGoesUp(ctx, ctx.db, 'documents', doc.employeeId)

  const remarks = input.remarks?.trim() || null
  if (input.decision === 'rejected' && !remarks) {
    throw BadRequest('Say why the document was rejected, so it can be put right.')
  }

  // Verifying says "I compared this file with the original" — impossible when
  // the stored file is gone or altered. Refused (and the attempt recorded, by
  // readStored); rejecting it, so that it is sent again, still works.
  if (input.decision === 'verified') {
    try {
      await readStored(ctx, { key: doc.storageKey, sha256: doc.sha256 }, { type: 'employee_document', id: doc.id })
    } catch (err) {
      if (err instanceof AppError && err.code === 'FILE_UNAVAILABLE') {
        throw Conflict('This file could not be read — it is missing from storage or has been altered — so it cannot be verified. Reject it and ask for it to be uploaded again.')
      }
      throw err
    }
  }

  await withTransaction(ctx.db, async (tx) => {
    const changed = await repo.decideIfPending(tx, id, {
      status: input.decision,
      remarks,
      decidedByUserId: ctx.userId,
      decidedAt: new Date(),
    })
    if (changed === 0) throw Conflict('That document has already been decided, or a newer one replaced it. Refresh to see it.')

    await audit(ctx, {
      action: input.decision === 'verified' ? 'document.verified' : 'document.rejected',
      entityType: 'employee_document',
      entityId: id,
      details: { employeeId: doc.employeeId, type: doc.documentType.code, remarks },
    }, tx)

    await notify(ctx, tx, {
      event: 'document.decided',
      to: { employee: doc.employeeId },
      title: input.decision === 'verified' ? 'Document verified' : 'Document rejected',
      message:
        input.decision === 'verified'
          ? `Your ${doc.documentType.label} was verified.`
          : `Your ${doc.documentType.label} was rejected: ${remarks}. Upload a corrected copy.`,
      link: '/documents?tab=mine',
      entity: { type: 'employee_document', id },
    })
  })

  logger.info('Document decided', { by: ctx.userId, documentId: id, decision: input.decision })
  const row = await repo.findDocument(ctx.db, ctx.scopeFor('document'), id)
  if (!row) throw NotFound('Document not found')
  return row
}

/**
 * Taking a file off the list. HR may remove any; an employee only their own,
 * and only while nobody has decided on it yet. The file itself is kept.
 */
export async function remove(ctx: AppContext, id: string) {
  const doc = await repo.findDocument(ctx.db, ctx.scopeFor('document'), id)
  if (!doc) throw NotFound('Document not found')

  const own = ownOf(ctx, doc.employeeId)
  // The document is already known to be within the caller's scope (found
  // above); a reviewer is somebody who checks documents for more than themselves.
  const reviewer = ctx.can('document:verify') && ctx.scopeFor('document').scope !== 'SELF'
  if (!reviewer) {
    if (!own) throw NotFound('Document not found')
    if (doc.status !== 'pending' || doc.supersededAt) {
      throw Conflict('This document has already been checked. Ask HR if it needs to be removed.')
    }
    // One's own upload, still waiting, is one's own to take back — not a file
    // HR filed for them (an offer letter), which is HR's.
    if (doc.uploadedByUserId !== ctx.userId) {
      throw Conflict('HR put this document on your record. Ask HR if it needs to be removed.')
    }
  } else if (!(own && doc.status === 'pending' && !doc.supersededAt)) {
    // Taking a checked file off — or anybody's file but one's own still
    // waiting — is checker's work: for one's own, or a fellow checker's, it
    // goes up the company tree (Day 22). Otherwise a rejection could be made
    // to disappear by the person it was about.
    await assertWorkGoesUp(ctx, ctx.db, 'documents', doc.employeeId)
  }

  await withTransaction(ctx.db, async (tx) => {
    // The same lock an upload takes, so a new upload cannot slip in between.
    await lockFor(tx, `document:${doc.employeeId}:${doc.documentTypeId}`)
    const changed = await repo.removeDocument(tx, id, ctx.userId, !reviewer)
    if (changed === 0) {
      throw Conflict(reviewer ? 'That document was removed a moment ago.' : 'This document was checked or replaced a moment ago. Refresh to see it.')
    }
    // Taking off the current upload brings back the one it replaced.
    const restored = doc.supersededAt ? null : await repo.restorePrevious(tx, doc.employeeId, doc.documentTypeId)
    await audit(ctx, {
      action: 'document.removed',
      entityType: 'employee_document',
      entityId: id,
      details: { employeeId: doc.employeeId, type: doc.documentType.code, status: doc.status, own, restored },
    }, tx)
  })

  logger.info('Document removed', { by: ctx.userId, documentId: id })
}
