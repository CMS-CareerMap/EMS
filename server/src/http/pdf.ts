import type { Response } from 'express'
import type { PdfFile } from '../modules/payroll/payslip.service'

/**
 * Sends a PDF the way a document containing somebody's pay should go out.
 *
 *   Content-Disposition: attachment  — saved, not rendered inside the app
 *   X-Content-Type-Options: nosniff  — the browser may not second-guess the type
 *   Cache-Control: private, no-store — no proxy and no shared disk keeps a copy
 *
 * The file name is built by the server from the payslip, never taken from
 * input, so it cannot smuggle a header or a path.
 */
export function sendPdf(res: Response, file: PdfFile): void {
  const safeName = file.filename.replace(/[^A-Za-z0-9._-]/g, '') || 'payslip.pdf'
  res.status(200)
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`)
  res.setHeader('Content-Length', String(file.bytes.length))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'private, no-store')
  res.end(file.bytes)
}
