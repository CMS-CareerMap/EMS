import type { ScopedDb } from '../../platform/db/scoped'

/**
 * Every storage key a row still points at — employee documents (replaced and
 * removed ones included: their files are kept), company documents, paid
 * payslips, bank proofs and request attachments.
 */
export async function referencedKeys(db: ScopedDb): Promise<Set<string>> {
  const [documents, company, payslips, proofs, attachments] = await Promise.all([
    db.employeeDocument.findMany({ select: { storageKey: true } }),
    db.companyDocument.findMany({ select: { storageKey: true } }),
    db.payslip.findMany({ where: { pdfKey: { not: null } }, select: { pdfKey: true } }),
    db.employeeBankAccount.findMany({ where: { proofKey: { not: null } }, select: { proofKey: true } }),
    db.employeeRequest.findMany({ where: { attachmentKey: { not: null } }, select: { attachmentKey: true } }),
  ])
  return new Set([
    ...documents.map((d) => d.storageKey),
    ...company.map((d) => d.storageKey),
    ...payslips.flatMap((p) => (p.pdfKey ? [p.pdfKey] : [])),
    ...proofs.flatMap((p) => (p.proofKey ? [p.proofKey] : [])),
    ...attachments.flatMap((r) => (r.attachmentKey ? [r.attachmentKey] : [])),
  ])
}
