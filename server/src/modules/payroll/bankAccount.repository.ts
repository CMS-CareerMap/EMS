import type { Prisma } from '@prisma/client'
import type { ScopedDb } from '../../platform/db/scoped'
import type { TxDb } from '../../platform/db/transaction'

/**
 * Where each person's salary is paid. Reached only with employee:bank:read —
 * a data class of its own, held by the people who move the money.
 */

const accountSelect = {
  bankName: true,
  accountHolderName: true,
  accountNumber: true,
  ifsc: true,
  branch: true,
  accountType: true,
  verificationStatus: true,
  verificationRemarks: true,
  verifiedAt: true,
  verifiedByUserId: true,
  updatedAt: true,
  proofKey: true,
  proofFileName: true,
  proofContentType: true,
  proofBytes: true,
  proofSha256: true,
  proofUploadedAt: true,
  submittedByUserId: true,
} as const

/** Everybody on the books, with their account or none. */
export async function bankRoster(db: ScopedDb) {
  return db.employee.findMany({
    where: { archivedAt: null },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      status: true,
      department: { select: { name: true } },
      // Whose login sent the details in — to tell self-service from Accounts'
      // entry. Either of the person's logins is the person (Day 23).
      memberships: { select: { userId: true } },
      bankAccount: { select: accountSelect },
    },
    orderBy: { employeeCode: 'asc' },
  })
}

export type BankRosterRow = Awaited<ReturnType<typeof bankRoster>>[number]

export async function findEmployeeWithAccount(db: ScopedDb, employeeId: string) {
  return db.employee.findFirst({
    where: { id: employeeId, archivedAt: null },
    select: {
      id: true,
      employeeCode: true,
      fullName: true,
      status: true,
      department: { select: { name: true } },
      // Whose login sent the details in — to tell self-service from Accounts'
      // entry. Either of the person's logins is the person (Day 23).
      memberships: { select: { userId: true } },
      bankAccount: { select: accountSelect },
    },
  })
}

export interface AccountValues {
  bankName: string
  accountHolderName: string
  accountNumber: string
  ifsc: string
  branch: string | null
  accountType: string | null
  verificationStatus: 'pending' | 'verified' | 'rejected' | 'unverified'
  verificationRemarks: string | null
  verifiedAt: Date | null
  verifiedByUserId: string | null
  submittedByUserId: string | null
  // Left out: the proof on file stays. Null: it no longer describes the account.
  proofKey?: string | null
  proofFileName?: string | null
  proofContentType?: string | null
  proofBytes?: number | null
  proofSha256?: string | null
  proofUploadedAt?: Date | null
}

/** Creates or replaces the one account a person has. */
export async function saveAccount(tx: TxDb, organizationId: string, employeeId: string, values: AccountValues) {
  const existing = await tx.employeeBankAccount.findFirst({ where: { employeeId } })
  return existing
    ? tx.employeeBankAccount.update({ where: { id: existing.id }, data: values })
    : tx.employeeBankAccount.create({ data: { organizationId, employeeId, ...values } })
}

/** The account as it stands — read under the lock, to see whether it changed meanwhile. */
export async function accountNow(tx: TxDb, employeeId: string) {
  return tx.employeeBankAccount.findFirst({ where: { employeeId }, select: { updatedAt: true, accountNumber: true } })
}

/** Records a decision on exactly the version that was looked at — no other. */
export async function setVerification(
  tx: TxDb,
  employeeId: string,
  version: Date,
  data: Pick<Prisma.EmployeeBankAccountUncheckedUpdateInput, 'verificationStatus' | 'verificationRemarks' | 'verifiedAt' | 'verifiedByUserId'>,
) {
  return (await tx.employeeBankAccount.updateMany({ where: { employeeId, updatedAt: version }, data })).count
}

/** The accounts of everybody in a run, for its bank file. */
export async function accountsOf(db: ScopedDb, employeeIds: string[]) {
  return db.employeeBankAccount.findMany({
    where: { employeeId: { in: employeeIds } },
    select: { employeeId: true, ...accountSelect },
  })
}

// ── The bank file's layout ──────────────────────────────────────────────────

export async function findTemplate(db: ScopedDb) {
  return db.bankFileTemplate.findFirst()
}

export async function saveTemplate(
  tx: TxDb,
  organizationId: string,
  values: {
    columns: Prisma.InputJsonValue
    includeHeader: boolean
    dateFormat: string
    narration: string
    onlyVerified: boolean
    updatedByUserId: string
  },
) {
  const existing = await tx.bankFileTemplate.findFirst()
  return existing
    ? tx.bankFileTemplate.update({ where: { id: existing.id }, data: values })
    : tx.bankFileTemplate.create({ data: { organizationId, ...values } })
}
