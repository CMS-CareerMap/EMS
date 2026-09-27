import type { AppContext } from '../../platform/context'
import { BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { audit } from '../audit/audit.service'
import * as repo from './bankAccount.repository'

/**
 * Bank accounts for salary, kept by the people who pay it.
 *
 * Here for Day 18 because the bank transfer file cannot exist without them.
 * The employee's own submission, with the cancelled cheque attached, arrives
 * with documents on Day 19; until then Accounts enters the account from the
 * cheque and checks it.
 *
 * Two rules the old screens broke:
 *
 *   · Nobody verifies their own account. An accountant who can mark their own
 *     account verified can redirect their own salary with no second pair of
 *     eyes, which is the one thing verification exists to stop.
 *   · Changing the account number or IFSC un-verifies it. A checked account
 *     that is then edited is no longer the account that was checked.
 *
 * The audit trail carries the last four digits, never the whole number.
 */

const lastFour = (accountNumber: string) => accountNumber.slice(-4)

export async function listBankAccounts(ctx: AppContext) {
  return repo.bankRoster(ctx.db)
}

/** Where the signed-in person's own salary goes; null with no account, or no employee record. */
export async function myBankAccount(ctx: AppContext) {
  if (!ctx.employeeId) return null
  const employee = await repo.findEmployeeWithAccount(ctx.db, ctx.employeeId)
  return employee?.bankAccount ?? null
}

export interface BankAccountInput {
  bankName: string
  accountHolderName: string
  accountNumber: string
  ifsc: string
  branch?: string | null | undefined
  accountType?: string | null | undefined
  /** "I have checked this against a cancelled cheque or passbook." */
  markVerified?: boolean | undefined
}

function refuseOwn(ctx: AppContext, employeeId: string, what: string): void {
  if (ctx.employeeId && ctx.employeeId === employeeId) {
    throw Conflict(`You cannot ${what} your own bank account — ask someone else in Accounts, or the Super Admin.`)
  }
}

export async function saveBankAccount(ctx: AppContext, employeeId: string, input: BankAccountInput) {
  const employee = await repo.findEmployeeWithAccount(ctx.db, employeeId)
  if (!employee) throw NotFound('Employee not found')

  if (input.markVerified) refuseOwn(ctx, employeeId, 'verify')

  const accountNumber = input.accountNumber.trim()
  const ifsc = input.ifsc.trim().toUpperCase()
  const previous = employee.bankAccount
  const sameAccount = previous !== null && previous.accountNumber === accountNumber && previous.ifsc === ifsc

  // Verified stays verified only if the account itself did not change.
  const keepVerified = sameAccount && previous?.verificationStatus === 'verified'
  const verified = input.markVerified === true || keepVerified

  const values: repo.AccountValues = {
    bankName: input.bankName.trim(),
    accountHolderName: input.accountHolderName.trim(),
    accountNumber,
    ifsc,
    branch: input.branch?.trim() || null,
    accountType: input.accountType?.trim() || null,
    verificationStatus: verified ? 'verified' : 'pending',
    verificationRemarks: input.markVerified ? 'Checked against a cancelled cheque or passbook' : keepVerified ? (previous?.verificationRemarks ?? null) : null,
    verifiedAt: input.markVerified ? new Date() : keepVerified ? (previous?.verifiedAt ?? null) : null,
    verifiedByUserId: input.markVerified ? ctx.userId : keepVerified ? (previous?.verifiedByUserId ?? null) : null,
  }

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `bank-account:${employeeId}`)
    await repo.saveAccount(tx, ctx.organizationId, employeeId, values)
    await audit(ctx, {
      action: 'bank_account.saved',
      entityType: 'employee',
      entityId: employeeId,
      details: {
        accountEnding: lastFour(accountNumber),
        ifsc,
        accountChanged: !sameAccount,
        previousEnding: previous ? lastFour(previous.accountNumber) : null,
        status: values.verificationStatus,
      },
    }, tx)
  })

  logger.info('Bank account saved', { by: ctx.userId, employeeId, status: values.verificationStatus })
  return repo.findEmployeeWithAccount(ctx.db, employeeId)
}

export interface VerifyInput {
  decision: 'verified' | 'rejected'
  remarks?: string | null | undefined
}

export async function verifyBankAccount(ctx: AppContext, employeeId: string, input: VerifyInput) {
  const employee = await repo.findEmployeeWithAccount(ctx.db, employeeId)
  if (!employee) throw NotFound('Employee not found')
  if (!employee.bankAccount) throw Conflict(`${employee.fullName} has no bank account recorded yet.`)

  refuseOwn(ctx, employeeId, input.decision === 'verified' ? 'verify' : 'reject')

  const remarks = input.remarks?.trim() || null
  if (input.decision === 'rejected' && !remarks) {
    throw BadRequest('Say why the account was rejected, so it can be put right.')
  }

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, `bank-account:${employeeId}`)
    await repo.setVerification(tx, employeeId, {
      verificationStatus: input.decision,
      verificationRemarks: remarks,
      verifiedAt: new Date(),
      verifiedByUserId: ctx.userId,
    })
    await audit(ctx, {
      action: input.decision === 'verified' ? 'bank_account.verified' : 'bank_account.rejected',
      entityType: 'employee',
      entityId: employeeId,
      details: { accountEnding: lastFour(employee.bankAccount!.accountNumber), remarks },
    }, tx)
  })

  logger.info('Bank account decided', { by: ctx.userId, employeeId, decision: input.decision })
  return repo.findEmployeeWithAccount(ctx.db, employeeId)
}
