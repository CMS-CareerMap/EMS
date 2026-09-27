import type { RequestHandler } from 'express'
import * as payslips from '../../modules/payroll/payslip.service'
import { myBankAccount } from '../../modules/payroll/bankAccount.service'
import { fromDateColumn, isoInstant } from '../../domain/shared/dates'
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

/**
 * GET /api/payslips/me/bank-account — where my salary is paid.
 *
 * The last four digits only: the person knows their own number, and a screen
 * that shows it whole is one over-the-shoulder glance from being somebody
 * else's. Changing it goes through Accounts, from a cancelled cheque.
 */
export const getMyBankAccount: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const a = await myBankAccount(ctx)
  reply(
    res,
    200,
    a
      ? {
          bank_name: a.bankName,
          account_holder_name: a.accountHolderName,
          account_ending: a.accountNumber.slice(-4),
          ifsc: a.ifsc,
          branch: a.branch,
          account_type: a.accountType,
          verification_status: a.verificationStatus,
          verification_remarks: a.verificationRemarks,
          verified_at: isoInstant(a.verifiedAt),
        }
      : null,
  )
}

/** GET /api/payslips/:id/pdf — the stored document, for whoever may see it. */
export const getPayslipPdf: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payslipIdParamSchema, req.params)
  sendPdf(res, await payslips.paidPayslipPdf(ctx, id))
}
