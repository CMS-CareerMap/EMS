import type { Response } from 'express'
import type { PdfFile } from '../modules/payroll/payslip.service'
import { sendFile } from './download'

/** A payslip PDF, with the headers every download of pay gets (download.ts). */
export function sendPdf(res: Response, file: PdfFile): void {
  sendFile(res, { ...file, contentType: 'application/pdf' })
}
