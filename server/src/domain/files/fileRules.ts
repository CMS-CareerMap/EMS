/**
 * Which files may be uploaded, decided from the file's own bytes.
 *
 * Three things are checked and all three must agree:
 *   · the extension on the name     — "aadhaar.pdf"
 *   · the type the browser declared  — "application/pdf"
 *   · the first bytes of the file    — "%PDF-"
 *
 * The bytes are what decide. A browser reports whatever the operating system
 * guesses from the name, so an HTML page renamed "cv.pdf" arrives declared as
 * a PDF — and served back from our own domain it would run as a page (stored
 * XSS). Its bytes are "<!DOCTYPE", which is not a PDF, so it never gets in.
 *
 * Pure: no storage, no request, no clock.
 */

export type FileKind = 'pdf' | 'jpeg' | 'png' | 'webp'

interface KindRule {
  /** What the file is served as — from this table, never from what was stored. */
  contentType: string
  extensions: readonly string[]
  /** Types a browser may declare for it. */
  declared: readonly string[]
  label: string
}

export const FILE_KINDS: Record<FileKind, KindRule> = {
  pdf: { contentType: 'application/pdf', extensions: ['pdf'], declared: ['application/pdf'], label: 'PDF' },
  jpeg: { contentType: 'image/jpeg', extensions: ['jpg', 'jpeg'], declared: ['image/jpeg', 'image/jpg', 'image/pjpeg'], label: 'JPG' },
  png: { contentType: 'image/png', extensions: ['png'], declared: ['image/png'], label: 'PNG' },
  webp: { contentType: 'image/webp', extensions: ['webp'], declared: ['image/webp'], label: 'WEBP' },
}

/** Every upload's absolute ceiling, whatever the company setting says. */
export const MAX_UPLOAD_MB_CEILING = 10
export const MIN_UPLOAD_MB = 1

const MB = 1024 * 1024

/** The kind a file really is, from its first bytes. Null when it is none we accept. */
export function detectKind(bytes: Uint8Array): FileKind | null {
  const starts = (...signature: number[]) => signature.every((b, i) => bytes[i] === b)

  // "%PDF-"
  if (starts(0x25, 0x50, 0x44, 0x46, 0x2d)) return 'pdf'
  // JPEG: FF D8 FF
  if (starts(0xff, 0xd8, 0xff)) return 'jpeg'
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'png'
  // WEBP: "RIFF" .... "WEBP"
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return 'webp'
  }
  return null
}

export function extensionOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

/**
 * The name as shown on screen: no folders, no control characters, not
 * endless. It is never used in a storage key or a header.
 */
export function displayName(fileName: string): string {
  const base = (fileName.split(/[\\/]/).pop() ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
  if (!base) return 'file'
  if (base.length <= 120) return base
  const ext = extensionOf(base)
  return ext ? `${base.slice(0, 110)}….${ext}` : `${base.slice(0, 118)}…`
}

export function formatMb(bytes: number): string {
  const mb = bytes / MB
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)} MB`
}

export interface UploadCandidate {
  fileName: string
  declaredType: string
  bytes: Uint8Array
  size: number
}

export type UploadVerdict =
  | { ok: true; kind: FileKind; contentType: string; extension: string }
  | { ok: false; reason: 'empty' | 'too_large' | 'type'; message: string }

/**
 * Whether a file may be stored, and as what.
 *
 * `allowed` narrows the kinds for a particular use — a cancelled cheque may
 * be a photo or a PDF; nothing here needs anything else.
 */
export function checkUpload(
  file: UploadCandidate,
  maxMb: number,
  allowed: readonly FileKind[] = ['pdf', 'jpeg', 'png', 'webp'],
): UploadVerdict {
  const accepted = allowed.map((k) => FILE_KINDS[k].label).join(', ')

  if (file.size === 0 || file.bytes.length === 0) {
    return { ok: false, reason: 'empty', message: 'That file is empty.' }
  }

  // What the file really is, read from its first bytes — also so that a file
  // over the limit is told what fits IT: a photo is not told to save a PDF.
  const kind = detectKind(file.bytes)
  const limit = Math.min(Math.max(maxMb, MIN_UPLOAD_MB), MAX_UPLOAD_MB_CEILING)
  if (file.size > limit * MB) {
    const size = `${formatMb(file.size)}; the most this company accepts is ${limit} MB.`
    return {
      ok: false,
      reason: 'too_large',
      message:
        kind === 'pdf'
          ? `That PDF is ${size} Save it smaller (most scanner apps have a "reduce size" option), or upload a photo of the page instead.`
          : kind
            ? `That photo is ${size} Take it again at a lower resolution, or upload it from the app, which makes photos smaller before sending them.`
            : `That file is ${size}`,
    }
  }

  if (!kind || !allowed.includes(kind)) {
    return { ok: false, reason: 'type', message: `Only ${accepted} files can be uploaded, and this one is not one of those.` }
  }

  const rule = FILE_KINDS[kind]
  const extension = extensionOf(file.fileName)
  if (!rule.extensions.includes(extension)) {
    return {
      ok: false,
      reason: 'type',
      message: `The file is a ${rule.label}, but its name ends in ".${extension || '(nothing)'}". Rename it to .${rule.extensions[0]} and upload it again.`,
    }
  }

  // A browser that says nothing is not lying; one that names another type is.
  const declared = file.declaredType.toLowerCase().split(';')[0]?.trim() ?? ''
  if (declared && declared !== 'application/octet-stream' && !rule.declared.includes(declared)) {
    return { ok: false, reason: 'type', message: `The file says it is ${declared}, but its contents are a ${rule.label}. Upload the original file.` }
  }

  return { ok: true, kind, contentType: rule.contentType, extension: rule.extensions[0]! }
}

/** The kind a stored content type belongs to — null when it is not on the allow-list. */
export function kindForContentType(contentType: string): FileKind | null {
  const entry = (Object.entries(FILE_KINDS) as [FileKind, KindRule][]).find(([, rule]) => rule.contentType === contentType)
  return entry ? entry[0] : null
}
