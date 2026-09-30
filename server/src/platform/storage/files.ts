import { createHash, randomUUID } from 'node:crypto'
import { storage, storageKey } from './index'
import { logger } from '../logger'
import { checkUpload, displayName, type FileKind } from '../../domain/files/fileRules'
import { PayloadTooLarge, BadRequest, FileUnavailable } from '../errors/AppError'

/**
 * Storing and reading uploaded files — the one path every upload takes.
 *
 *   1. checkUpload()  the bytes decide the type; the company's cap decides size
 *   2. hash           SHA-256, kept on the row and checked on every read
 *   3. put            under a key built from ids, never from the file's name
 *
 * The object is written BEFORE its row (guide §A9: file bytes are deliberately
 * not atomic). If the row then fails, the caller deletes the object; if even
 * that fails, the sweeper finds a file no row points at and removes it.
 */

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export interface IncomingFile {
  fileName: string
  declaredType: string
  bytes: Buffer
  size: number
}

export interface StoredFile {
  id: string
  key: string
  fileName: string
  contentType: string
  extension: string
  bytes: number
  sha256: string
}

type Kind = 'employee-document' | 'bank-proof' | 'company-document'

/**
 * Validates and stores an upload. The returned `id` is the row's id to use, so
 * the key and the row carry the same one.
 */
export async function storeUpload(
  file: IncomingFile,
  where: { organizationId: string; kind: Kind; ownerId: string },
  maxMb: number,
  allowed?: readonly FileKind[],
): Promise<StoredFile> {
  const verdict = checkUpload(
    { fileName: file.fileName, declaredType: file.declaredType, bytes: file.bytes, size: file.size },
    maxMb,
    allowed,
  )
  if (!verdict.ok) {
    throw verdict.reason === 'too_large' ? PayloadTooLarge(verdict.message) : BadRequest(verdict.message)
  }

  const id = randomUUID()
  const key = storageKey({ organizationId: where.organizationId, kind: where.kind, ownerId: where.ownerId, fileId: id, extension: verdict.extension })
  const hash = sha256(file.bytes)
  await storage().put(key, file.bytes, verdict.contentType)

  return {
    id,
    key,
    fileName: displayName(file.fileName),
    contentType: verdict.contentType,
    extension: verdict.extension,
    bytes: file.size,
    sha256: hash,
  }
}

/** Removes an object whose row was never written. Never throws: the sweeper is the backstop. */
export async function discardUpload(key: string): Promise<void> {
  try {
    await storage().delete(key)
  } catch (err) {
    logger.warn('Could not remove an orphaned upload; the sweeper will', { key, error: err instanceof Error ? err.message : String(err) })
  }
}

/** Reads a stored file and refuses it if it is not byte-for-byte what was stored. */
export async function readVerified(key: string, expectedSha: string, what: string): Promise<Buffer> {
  let bytes: Buffer
  try {
    bytes = await storage().get(key)
  } catch (err) {
    // Gone from storage — deleted by hand, or a failed copy between buckets.
    logger.error('Stored file could not be read', { key, what, error: err instanceof Error ? err.message : String(err) })
    throw FileUnavailable()
  }
  if (sha256(bytes) !== expectedSha) {
    logger.error('Stored file failed its integrity check', { key, what })
    throw FileUnavailable()
  }
  return bytes
}
