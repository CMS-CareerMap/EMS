import type { RequestHandler } from 'express'
import * as bank from '../../modules/payroll/bankAccount.service'
import * as bankFile from '../../modules/payroll/bankFile.service'
import type { BankRosterRow } from '../../modules/payroll/bankAccount.repository'
import { BANK_FILE_DATE_FORMATS, BANK_FILE_FIELDS } from '../../domain/payroll/bankFile'
import { isoInstant } from '../../domain/shared/dates'
import {
  bankAccountSchema,
  bankFileQuerySchema,
  bankFileTemplateSchema,
  bankVerifySchema,
  payrollEmployeeParamSchema,
  payrollRunParamSchema,
} from '../validators/payroll.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { sendFile } from '../download'
import { uploadedFile } from '../upload'
import { uploadLimitMb } from '../../modules/organization/organization.service'

/**
 * Bank accounts, the bank file's layout, and the bank file itself.
 */

const reply = (res: Parameters<RequestHandler>[1], status: number, data: unknown) =>
  res.status(status).json({ data, meta: { requestId: res.locals.requestId } })

function accountPayload(row: BankRosterRow) {
  const a = row.bankAccount
  return {
    employee_id: row.id,
    employee_code: row.employeeCode,
    full_name: row.fullName,
    department: row.department?.name ?? null,
    status: row.status,
    bank_account: a
      ? {
          bank_name: a.bankName,
          account_holder_name: a.accountHolderName,
          account_number: a.accountNumber,
          ifsc: a.ifsc,
          branch: a.branch,
          account_type: a.accountType,
          verification_status: a.verificationStatus,
          verification_remarks: a.verificationRemarks,
          verified_at: isoInstant(a.verifiedAt),
          verified_by_user_id: a.verifiedByUserId,
          updated_at: isoInstant(a.updatedAt),
          // Sent in by the employee themselves, rather than entered by Accounts.
          submitted_by_employee: a.submittedByUserId !== null && row.memberships.some((m) => m.userId === a.submittedByUserId),
          proof: a.proofKey
            ? { file_name: a.proofFileName, content_type: a.proofContentType, bytes: a.proofBytes, uploaded_at: isoInstant(a.proofUploadedAt) }
            : null,
        }
      : null,
  }
}

/** GET /api/payroll/bank-accounts */
export const getBankAccounts: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const [rows, maxUploadMb] = await Promise.all([bank.listBankAccounts(ctx), uploadLimitMb(ctx)])
  res.status(200).json({
    data: rows.map(({ row, check }) => ({
      ...accountPayload(row),
      // Whether the caller may check this account (Day 22: own work goes up
      // the tree), and if not, whom to ask — so the screen says it instead of
      // offering a button the server would refuse.
      may_check: check.allowed,
      own: check.own,
      check_goes_to: check.allowed ? null : check.ask,
    })),
    meta: { requestId: res.locals.requestId, max_upload_mb: maxUploadMb },
  })
}

/** PUT /api/payroll/employees/:id/bank-account */
export const putBankAccount: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollEmployeeParamSchema, req.params)
  const input = parseBody(bankAccountSchema, req.body ?? {})
  const saved = await bank.saveBankAccount(ctx, id, input, uploadedFile(req.file))
  reply(res, 200, saved ? accountPayload(saved) : null)
}

/** GET /api/payroll/employees/:id/bank-account/proof — the cheque or passbook page on file. */
export const getBankAccountProof: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollEmployeeParamSchema, req.params)
  sendFile(res, await bank.proofFile(ctx, id))
}

/** POST /api/payroll/employees/:id/bank-account/verify  { decision, remarks? } */
export const postVerifyBankAccount: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollEmployeeParamSchema, req.params)
  const input = parseBody(bankVerifySchema, req.body)
  const saved = await bank.verifyBankAccount(ctx, id, input)
  reply(res, 200, saved ? accountPayload(saved) : null)
}

type Template = Awaited<ReturnType<typeof bankFile.getTemplate>>

function templatePayload(t: Template) {
  return {
    columns: t.columns.map((c) => ({ header: c.header, field: c.field, text: c.text ?? null })),
    include_header: t.includeHeader,
    date_format: t.dateFormat,
    narration: t.narration,
    only_verified: t.onlyVerified,
    // False: the built-in layout, not yet set up for this company's bank.
    saved: t.saved,
    // What a column can hold and the date styles, for the editor to offer.
    fields: Object.entries(BANK_FILE_FIELDS).map(([field, label]) => ({ field, label })),
    date_formats: BANK_FILE_DATE_FORMATS,
  }
}

/** GET /api/payroll/bank-file-template */
export const getBankFileTemplate: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  reply(res, 200, templatePayload(await bankFile.getTemplate(ctx)))
}

/** PUT /api/payroll/bank-file-template */
export const putBankFileTemplate: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(bankFileTemplateSchema, req.body)
  reply(res, 200, templatePayload(await bankFile.saveTemplate(ctx, input)))
}

/**
 * GET /api/payroll-runs/:id/bank-file/preview?payDate=
 *
 * Who the file pays and who it leaves out, before anybody uploads it.
 * Account numbers show their last four digits here; the file has them whole.
 */
export const getBankFilePreview: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  const { payDate } = parseBody(bankFileQuerySchema, req.query)
  const plan = await bankFile.bankFilePreview(ctx, id, payDate)

  reply(res, 200, {
    run: plan.run,
    pay_date: plan.payDate,
    total: plan.total,
    count: plan.payments.length,
    payments: plan.payments.map((p) => ({
      payslip_id: p.payslipId,
      employee_id: p.employeeId,
      employee_code: p.employeeCode,
      full_name: p.employeeName,
      beneficiary_name: p.beneficiaryName,
      bank_name: p.bankName,
      account_ending: p.accountNumber.slice(-4),
      ifsc: p.ifsc,
      amount: p.amount,
    })),
    excluded: plan.excluded.map((x) => ({
      payslip_id: x.payslipId,
      employee_id: x.employeeId,
      employee_code: x.employeeCode,
      full_name: x.fullName,
      net_payable: x.netPayable,
      reason: x.reason,
    })),
    // False while the built-in layout is in use — the bank's own format not yet set up.
    template_saved: plan.template.saved,
  })
}

/** GET /api/payroll-runs/:id/bank-file?payDate= — the CSV itself. */
export const getBankFile: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(payrollRunParamSchema, req.params)
  const { payDate } = parseBody(bankFileQuerySchema, req.query)
  const file = await bankFile.bankFileCsv(ctx, id, payDate)
  sendFile(res, { filename: file.filename, bytes: file.bytes, contentType: 'text/csv; charset=utf-8' })
}
