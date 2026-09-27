import type { RequestHandler } from 'express'
import * as payslips from '../../modules/payroll/payslip.service'
import { fromDateColumn } from '../../domain/shared/dates'
import { payslipIdParamSchema } from '../validators/payroll.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { sendPdf } from '../pdf'

/**
 * Payslips for the people they belong to. Only paid months appear: a draft is
 * working figures, and an approved run has not yet paid anybody.
 */

const reply = (res: Parameters<RequestHandler>[1], status: number, data: unknown) =>
  res.status(status).json({ data, meta: { requestId: res.locals.requestId } })

/** GET /api/payslips/me */
export const getMyPayslips: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const rows = await payslips.listMyPayslips(ctx)

  reply(
    res,
    200,
    rows.map((slip) => ({
      id: slip.id,
      year: slip.year,
      month: slip.month,
      currency: slip.currency,
      gross_earnings: Number(slip.grossEarnings),
      total_deductions: Number(slip.totalDeductions),
      net_payable: Number(slip.netPayable),
      paid_on: fromDateColumn(slip.run.paidOn),
      // The download route, rather than a storage URL that would outlive the
      // session or be shareable.
      pdf_url: `/api/payslips/${slip.id}/pdf`,
    })),
  )
}

/** GET /api/payslips/:id/pdf — the stored document, for whoever may see it. */
export const getPayslipPdf: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payslipIdParamSchema, req.params)
  sendPdf(res, await payslips.paidPayslipPdf(ctx, id))
}
