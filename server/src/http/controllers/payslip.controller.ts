import type { RequestHandler } from 'express'
import * as payslips from '../../modules/payroll/payslip.service'
import { myBankAccount, submitOwnBankAccount } from '../../modules/payroll/bankAccount.service'
import { ownBankAccountSchema } from '../validators/payroll.validator'
import { uploadedFile } from '../upload'
import { uploadLimitMb } from '../../modules/organization/organization.service'
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
  const [account, maxUploadMb] = await Promise.all([myBankAccount(ctx), uploadLimitMb(ctx)])
  // The upload limit travels with it: the page makes a proof photo fit before sending.
  res.status(200).json({ data: ownAccountPayload(account), meta: { requestId: res.locals.requestId, max_upload_mb: maxUploadMb } })
}

/**
 * PUT /api/payslips/me/bank-account — multipart: the details, and "proof", a
 * photo or PDF of a cancelled cheque or passbook page. It waits for Accounts.
 */
export const putMyBankAccount: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(ownBankAccountSchema, req.body ?? {})
  const saved = await submitOwnBankAccount(ctx, input, uploadedFile(req.file))
  reply(res, 200, ownAccountPayload(saved?.bankAccount ?? null))
}

function ownAccountPayload(a: Awaited<ReturnType<typeof myBankAccount>>) {
  return a
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
          has_proof: a.proofKey !== null,
          updated_at: isoInstant(a.updatedAt),
        }
      : null
}

/** GET /api/payslips/:id/pdf — the stored document, for whoever may see it. */
export const getPayslipPdf: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payslipIdParamSchema, req.params)
  sendPdf(res, await payslips.paidPayslipPdf(ctx, id))
}
