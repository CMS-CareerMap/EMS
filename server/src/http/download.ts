import type { Response } from 'express'

/**
 * Sends a file the way a document containing somebody's pay should go out.
 *
 *   Content-Disposition: attachment  — saved, not rendered inside the app
 *   X-Content-Type-Options: nosniff  — the browser may not second-guess the type
 *   Cache-Control: private, no-store — no proxy and no shared disk keeps a copy
 *
 * The file name is built by the server, never taken from input, so it cannot
 * smuggle a header or a path.
 */
export function sendFile(res: Response, file: { filename: string; bytes: Buffer; contentType: string }): void {
  const safeName = file.filename.replace(/[^A-Za-z0-9._-]/g, '') || 'download'
  res.status(200)
  res.setHeader('Content-Type', file.contentType)
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
  res.setHeader('Content-Length', String(file.bytes.length))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(file.bytes)
}
