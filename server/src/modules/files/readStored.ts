import type { AppContext } from '../../platform/context'
import { AppError } from '../../platform/errors/AppError'
import { readVerified } from '../../platform/storage/files'
import { recordSecurityEvent } from '../audit/audit.service'

/**
 * A stored file for somebody to open — checked against its hash as always.
 *
 * When it is missing or no longer the file that was written, that is recorded
 * in the audit trail as well as the log: an Aadhaar scan changed in storage is
 * a security matter, not only an error, and whoever looks later should find
 * who tried to open it and when.
 */
export async function readStored(ctx: AppContext, file: { key: string; sha256: string }, entity: { type: string; id: string }): Promise<Buffer> {
  try {
    return await readVerified(file.key, file.sha256, `${entity.type} ${entity.id}`)
  } catch (err) {
    if (err instanceof AppError && err.code === 'FILE_UNAVAILABLE') {
      await recordSecurityEvent({
        organizationId: ctx.organizationId,
        actorUserId: ctx.userId,
        requestId: ctx.requestId,
        action: 'file.unreadable',
        entityType: entity.type,
        entityId: entity.id,
        details: {},
      })
    }
    throw err
  }
}
