import type { AppContext } from '../../platform/context'
import { NotFound } from '../../platform/errors/AppError'
import { renderPayslipPdf } from '../../platform/pdf/payslipPdf'
import { recordSecurityEvent } from '../audit/audit.service'
import { payslipView, addressOf, type PayslipViewInput } from '../../domain/payroll/payslipView'
import { templateFor } from '../../domain/payroll/payslipTemplates'
import { fromDateColumn, type CalendarDate } from '../../domain/shared/dates'
import * as repo from './payrollRun.repository'

/**
 * Payslips as documents: the PDF of each, and the list a person sees of their
 * own.
 *
 * A PAID payslip's PDF is written once, when the run is marked paid, and from
 * then on it is served from storage exactly as it was — never regenerated,
 * checked against its SHA-256 every time it is read (guide §A12). Anything not
 * yet paid is drawn fresh on request, stamped as not being a payslip, and never
 * stored.
 */

// One hash function for every stored file (platform/storage/files.ts).
export { sha256 } from '../../platform/storage/files'
import { readVerified } from '../../platform/storage/files'

export interface PdfFile {
  filename: string
  bytes: Buffer
}

type Identifiers = PayslipViewInput['identifiers']

const NO_IDENTIFIERS: Identifiers = { uan: null, pfMemberId: null, esicNumber: null, pan: null }

/** What the renderer needs, from a stored payslip and the facts around it. */
export function viewInputOf(
  slip: repo.PayslipWithLines,
  context: {
    status: 'draft' | 'approved' | 'paid'
    payDate: CalendarDate | null
    employer: { name: string; address: string | null }
    identifiers: Identifiers
  },
): PayslipViewInput {
  return {
    country: slip.country,
    currency: slip.currency,
    status: context.status,
    employer: context.employer,
    year: slip.year,
    month: slip.month,
    payDate: context.payDate,
    employee: {
      name: slip.employeeName,
      code: slip.employeeCode,
      designation: slip.designation,
      department: slip.department,
      dateOfJoining: fromDateColumn(slip.dateOfJoining),
    },
    identifiers: context.identifiers,
    days: {
      daysInMonth: slip.daysInMonth,
      paidDays: Number(slip.paidDays),
      lopDays: Number(slip.lopDays),
    },
    earnings: slip.lines
      .filter((line) => line.kind === 'earning')
      .map((line) => ({ label: line.label, rate: line.rate === null ? null : Number(line.rate), amount: Number(line.amount) })),
    deductions: slip.lines
      .filter((line) => line.kind === 'deduction')
      .map((line) => ({ label: line.label, amount: Number(line.amount) })),
    totals: {
      gross: Number(slip.grossEarnings),
      deductions: Number(slip.totalDeductions),
      net: Number(slip.netPayable),
    },
    employerContributions: {
      eps: Number(slip.employerEps),
      epf: Number(slip.employerEpf),
      esi: Number(slip.employerEsi),
    },
  }
}

/** A payslip drawn as a PDF, with the file name it should be saved under. */
export async function renderSlip(input: PayslipViewInput, createdAt: Date): Promise<PdfFile> {
  const view = payslipView(input, templateFor(input.country))
  return { filename: view.filename, bytes: await renderPayslipPdf(view, { createdAt }) }
}

/** The stored PDF, refused if it is not the file that was written. */
async function storedPdf(slip: { id: string; pdfKey: string | null; pdfSha256: string | null }): Promise<Buffer> {
  if (!slip.pdfKey || !slip.pdfSha256) {
    // Paid with no file is a broken record, not a missing payslip.
    throw new Error(`Paid payslip ${slip.id} has no stored PDF`)
  }
  return readVerified(slip.pdfKey, slip.pdfSha256, `payslip ${slip.id}`)
}

const filenameOf = (slip: { year: number; month: number; employeeCode: string }) =>
  `payslip-${slip.year}-${String(slip.month).padStart(2, '0')}-${slip.employeeCode.replace(/[^A-Za-z0-9_-]/g, '') || 'employee'}.pdf`

// ── Self-service ────────────────────────────────────────────────────────────

/** The caller's own payslips, paid ones only. An operator with no employee record has none. */
export async function listMyPayslips(ctx: AppContext) {
  if (!ctx.employeeId) return []
  return repo.paidPayslipsOf(ctx.db, ctx.employeeId)
}

/**
 * A paid payslip's PDF, for anybody whose scope includes it — themselves, or
 * payroll staff for the whole company. Out of scope is 404, like everywhere.
 */
export async function paidPayslipPdf(ctx: AppContext, id: string): Promise<PdfFile> {
  const slip = await repo.findPaidPayslip(ctx.db, ctx.scopeFor('payslip'), id)
  if (!slip) throw NotFound('Payslip not found')

  const bytes = await storedPdf(slip)

  // Who opened whose payslip. Best effort: a download never fails for want of
  // an audit row.
  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    requestId: ctx.requestId,
    action: 'payslip.downloaded',
    entityType: 'payslip',
    entityId: slip.id,
    details: { employeeId: slip.employeeId, year: slip.year, month: slip.month, own: slip.employeeId === ctx.employeeId },
  })

  return { filename: filenameOf(slip), bytes }
}

// ── For payroll staff, inside a run ─────────────────────────────────────────

/**
 * Any payslip of a run as a PDF. Paid: the stored file. Otherwise drawn now,
 * stamped DRAFT or NOT YET PAID — with the approval's copies of the employer
 * and the statutory numbers once approved, and today's before that.
 */
export async function runPayslipPdf(ctx: AppContext, runId: string, payslipId: string): Promise<PdfFile> {
  const run = await repo.findRun(ctx.db, runId)
  const slip = run ? await repo.findPayslip(ctx.db, runId, payslipId) : null
  if (!run || !slip) throw NotFound('Payslip not found')

  if (run.status === 'paid') {
    return { filename: filenameOf(slip), bytes: await storedPdf(slip) }
  }

  let employer: { name: string; address: string | null }
  let identifiers: Identifiers

  if (run.status === 'approved' && run.employerName) {
    employer = { name: run.employerName, address: run.employerAddress }
    identifiers = { uan: slip.uan, pfMemberId: slip.pfMemberId, esicNumber: slip.esicNumber, pan: slip.pan }
  } else {
    const org = await repo.findEmployer(ctx.db, ctx.organizationId)
    employer = { name: org?.legalName || org?.name || '', address: org ? addressOf(org) : null }
    const [identity] = await repo.identitiesOf(ctx.db, [slip.employeeId])
    identifiers = identity
      ? { uan: identity.uan, pfMemberId: identity.pfAccountNumber, esicNumber: identity.esiNumber, pan: identity.pan }
      : NO_IDENTIFIERS
  }

  return renderSlip(
    viewInputOf(slip, { status: run.status, payDate: null, employer, identifiers }),
    run.calculatedAt,
  )
}
