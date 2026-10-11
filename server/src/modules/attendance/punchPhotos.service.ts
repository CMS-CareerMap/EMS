import type { AppContext } from '../../platform/context'
import type { ScopedDb } from '../../platform/db/scoped'
import { NotFound } from '../../platform/errors/AppError'
import { discardUpload, storeUpload } from '../../platform/storage/files'
import { readStored } from '../files/readStored'
import { attendanceSecurityOf } from '../settings/settings.repository'
import * as repo from './attendance.repository'
import { notOwn } from './punchDevices.service'

/**
 * A punch's selfie (client, 11 Oct 2026), when the company asks for one: a
 * live photo from the front camera, made small in the browser, kept privately
 * and shown to HR and the person's manager on the day — then deleted by the
 * nightly job once the company's days for keeping it are up. A refused punch
 * keeps its photo too: the room behind somebody punching from home is the
 * evidence.
 */

/** The largest a selfie may be: the browser sends about 50 KB. */
const SELFIE_MAX_MB = 1

export interface IncomingPhoto {
  bytes: Buffer
  declaredType: string
}

export interface StoredPhoto {
  key: string
  sha256: string
  bytes: number
}

/** Stored before the punch is written; the caller discards it if the punch is not. */
export async function storePunchPhoto(ctx: AppContext, employeeId: string, photo: IncomingPhoto): Promise<StoredPhoto> {
  const stored = await storeUpload(
    { fileName: 'selfie.jpg', declaredType: photo.declaredType, bytes: photo.bytes, size: photo.bytes.length },
    { organizationId: ctx.organizationId, kind: 'attendance-photo', ownerId: employeeId },
    SELFIE_MAX_MB,
    ['jpeg', 'png', 'webp'],
  )
  return { key: stored.key, sha256: stored.sha256, bytes: stored.bytes }
}

export const dropPunchPhoto = (photo: StoredPhoto | null) => (photo ? discardUpload(photo.key) : Promise.resolve())

/** A punch's selfie, for somebody whose reach covers its person — never their own, but for the Super Admin — checked against its hash. */
export async function readPunchPhoto(ctx: AppContext, id: string): Promise<{ bytes: Buffer; type: string }> {
  const photo = await repo.punchPhoto(ctx.db, ctx.scopeFor('attendance'), id, notOwn(ctx))
  if (!photo?.photoKey || !photo.photoSha) throw NotFound('That photo is not kept any more, or is not one you can see.')
  const bytes = await readStored(ctx, { key: photo.photoKey, sha256: photo.photoSha }, { type: 'punch_photo', id })
  const ext = photo.photoKey.split('.').pop()
  return { bytes, type: ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg' }
}

/**
 * The nightly job: selfies older than the company's days for keeping them are
 * deleted, and the punches say so (their photo fields cleared). A dry run
 * counts. Never throws for one file that will not go: the sweeper is the
 * backstop.
 */
export async function purgeOldPunchPhotos(db: ScopedDb, organizationId: string, options: { apply: boolean }) {
  const security = await attendanceSecurityOf(db, organizationId)
  const keepDays = security?.punchSelfieKeepDays ?? null
  if (keepDays === null) return { found: 0, deleted: 0 }
  const before = new Date(Date.now() - keepDays * 86_400_000)
  const old = await repo.photosBefore(db, before)
  if (!options.apply) return { found: old.length, deleted: 0 }
  for (const p of old) {
    // The punch first: a file that will not go is then nobody's, and the
    // sweeper takes it — never a punch pointing at a file that is gone.
    await repo.forgetPhoto(db, p.id)
    if (p.photoKey) await discardUpload(p.photoKey)
  }
  return { found: old.length, deleted: old.length }
}
