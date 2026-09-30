import type { AppContext } from '../../platform/context'
import { AppError, BadRequest, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { discardUpload, storeUpload, type IncomingFile, type StoredFile } from '../../platform/storage/files'
import { readStored } from '../files/readStored'
import { FILE_KINDS, kindForContentType } from '../../domain/files/fileRules'
import { audit, recordSecurityEvent } from '../audit/audit.service'
import { notify } from '../notifications/notify.service'
import { uploadLimitMb } from '../organization/organization.service'
import * as repo from './bankAccount.repository'

/**
 * Bank accounts for salary.
 *
 * Two ways in:
 *   · Accounts enters an account from the cheque handed in, and may mark it
 *     checked there and then (Day 18).
 *   · The employee sends in their own, WITH a photo or PDF of a cancelled
 *     cheque or passbook page (Day 19). It always waits for Accounts to check
 *     it against that proof.
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

/** A cheque or passbook page: a photo or a PDF. */
const PROOF_KINDS = ['pdf', 'jpeg', 'png', 'webp'] as const

export async function listBankAccounts(ctx: AppContext) {
  return repo.bankRoster(ctx.db)
}

/** Where the signed-in person's own salary goes; null with no account, or no employee record. */
export async function myBankAccount(ctx: AppContext) {
  if (!ctx.employeeId) return null
  const employee = await repo.findEmployeeWithAccount(ctx.db, ctx.employeeId)
  return employee?.bankAccount ?? null
}

/** Two moments are the same version of an account. */
const sameVersion = (a: Date | null | undefined, b: Date | null | undefined) => (a?.getTime() ?? null) === (b?.getTime() ?? null)

const CHANGED_MEANWHILE = 'This account was changed a moment ago. Open it again to see the latest before saving.'

export interface BankAccountInput {
  bankName: string
  accountHolderName: string
  accountNumber: string
  ifsc: string
  branch?: string | null | undefined
  accountType?: string | null | undefined
  /** "I have checked this against a cancelled cheque or passbook." */
  markVerified?: boolean | undefined
  /** The version the person had open (`updated_at`), when changing an account that exists. */
  accountUpdatedAt?: string | undefined
}

function refuseOwn(ctx: AppContext, employeeId: string, what: string): void {
  if (ctx.employeeId && ctx.employeeId === employeeId) {
    throw Conflict(`You cannot ${what} your own bank account — ask someone else in Accounts, or the Super Admin.`)
  }
}

function proofValues(stored: StoredFile | null) {
  return stored
    ? {
        proofKey: stored.key,
        proofFileName: stored.fileName,
        proofContentType: stored.contentType,
        proofBytes: stored.bytes,
        proofSha256: stored.sha256,
        proofUploadedAt: new Date(),
      }
    : {}
}

const NO_PROOF = {
  proofKey: null,
  proofFileName: null,
  proofContentType: null,
  proofBytes: null,
  proofSha256: null,
  proofUploadedAt: null,
}

async function storeProof(ctx: AppContext, employeeId: string, proof: IncomingFile | null): Promise<StoredFile | null> {
  if (!proof) return null
  return storeUpload(proof, { organizationId: ctx.organizationId, kind: 'bank-proof', ownerId: employeeId }, await uploadLimitMb(ctx), PROOF_KINDS)
}

export async function saveBankAccount(ctx: AppContext, employeeId: string, input: BankAccountInput, proof: IncomingFile | null = null) {
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

  const stored = await storeProof(ctx, employeeId, proof)

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
    submittedByUserId: ctx.userId,
    // A new proof replaces the old; a changed account with no new proof keeps
    // none — a cheque for the old account proves nothing about the new one.
    ...(stored ? proofValues(stored) : sameAccount ? {} : NO_PROOF),
  }

  try {
    await withTransaction(ctx.db, async (tx) => {
      await lockFor(tx, `bank-account:${employeeId}`)
      // Everything above was worked out from the account as it was read. If
      // the employee sent in new details meanwhile — or since the form was
      // opened — saving would overwrite them unseen.
      const current = await repo.accountNow(tx, employeeId)
      if (!sameVersion(current?.updatedAt, previous?.updatedAt)) throw Conflict(CHANGED_MEANWHILE)
      if (input.accountUpdatedAt && !sameVersion(current?.updatedAt, new Date(input.accountUpdatedAt))) {
        throw Conflict(`This account was changed since you opened it${current ? ` — it now ends ${lastFour(current.accountNumber)}` : ''}. Open it again before saving.`)
      }
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
          proofAttached: Boolean(stored),
        },
      }, tx)
    })
  } catch (err) {
    // Only when the save was surely rolled back — our own refusal. Any other
    // failure may have come after the commit; the nightly sweep handles those.
    if (stored && err instanceof AppError) await discardUpload(stored.key)
    throw err
  }

  logger.info('Bank account saved', { by: ctx.userId, employeeId, status: values.verificationStatus })
  return repo.findEmployeeWithAccount(ctx.db, employeeId)
}

/**
 * An employee sending in their own account.
 *
 * Always PENDING afterwards, whatever it was: Accounts checks it against the
 * proof. A new account, or a new number or IFSC, must come with a proof; a
 * correction to the bank's name alone may reuse the one on file.
 */
export async function submitOwnBankAccount(ctx: AppContext, input: Omit<BankAccountInput, 'markVerified'>, proof: IncomingFile | null) {
  const employeeId = ctx.employeeId
  if (!employeeId) throw BadRequest('This login has no employee record, so it has no salary account.')

  const employee = await repo.findEmployeeWithAccount(ctx.db, employeeId)
  if (!employee) throw NotFound('Employee not found')

  const accountNumber = input.accountNumber.trim()
  const ifsc = input.ifsc.trim().toUpperCase()
  const previous = employee.bankAccount
  const sameAccount = previous !== null && previous.accountNumber === accountNumber && previous.ifsc === ifsc

  if (!proof && (!sameAccount || !previous?.proofKey)) {
    throw BadRequest('Attach a photo or PDF of a cancelled cheque or a passbook page showing this account.')
  }

  const stored = await storeProof(ctx, employeeId, proof)

  const values: repo.AccountValues = {
    bankName: input.bankName.trim(),
    accountHolderName: input.accountHolderName.trim(),
    accountNumber,
    ifsc,
    branch: input.branch?.trim() || null,
    accountType: input.accountType?.trim() || null,
    verificationStatus: 'pending',
    verificationRemarks: null,
    verifiedAt: null,
    verifiedByUserId: null,
    submittedByUserId: ctx.userId,
    ...proofValues(stored),
  }

  try {
    await withTransaction(ctx.db, async (tx) => {
      await lockFor(tx, `bank-account:${employeeId}`)
      const current = await repo.accountNow(tx, employeeId)
      if (!sameVersion(current?.updatedAt, previous?.updatedAt)) throw Conflict('Your account was changed a moment ago. Open it again to see the latest.')
      await repo.saveAccount(tx, ctx.organizationId, employeeId, values)
      await audit(ctx, {
        action: 'bank_account.submitted',
        entityType: 'employee',
        entityId: employeeId,
        details: {
          accountEnding: lastFour(accountNumber),
          ifsc,
          accountChanged: !sameAccount,
          previousEnding: previous ? lastFour(previous.accountNumber) : null,
          proofAttached: Boolean(stored),
        },
      }, tx)
      await notify(ctx, tx, {
        event: 'bank.submitted',
        to: { holding: 'employee:bank:manage' },
        title: 'Bank details to check',
        message: `${employee.fullName} sent in bank details (account ending ${lastFour(accountNumber)}). Check them against the proof attached.`,
        link: '/payroll?tab=bank',
        entity: { type: 'employee', id: employeeId },
      })
    })
  } catch (err) {
    // Only when the save was surely rolled back — our own refusal. Any other
    // failure may have come after the commit; the nightly sweep handles those.
    if (stored && err instanceof AppError) await discardUpload(stored.key)
    throw err
  }

  logger.info('Bank account submitted by its owner', { by: ctx.userId, employeeId })
  return repo.findEmployeeWithAccount(ctx.db, employeeId)
}

/** The cheque or passbook page on file, for whoever checks accounts. */
export async function proofFile(ctx: AppContext, employeeId: string) {
  const employee = await repo.findEmployeeWithAccount(ctx.db, employeeId)
  const account = employee?.bankAccount
  if (!employee || !account?.proofKey || !account.proofSha256 || !account.proofContentType) throw NotFound('No proof is on file for this account')

  const kind = kindForContentType(account.proofContentType)
  if (!kind) throw Conflict('This file is of a type the system no longer serves.')
  const bytes = await readStored(ctx, { key: account.proofKey, sha256: account.proofSha256 }, { type: 'bank_proof', id: employeeId })

  await recordSecurityEvent({
    organizationId: ctx.organizationId,
    actorUserId: ctx.userId,
    actorRole: ctx.role,
    requestId: ctx.requestId,
    action: 'bank_account.proof_downloaded',
    entityType: 'employee',
    entityId: employeeId,
    details: { accountEnding: lastFour(account.accountNumber) },
  })

  const code = employee.employeeCode.replace(/[^A-Za-z0-9_-]/g, '') || 'employee'
  return { filename: `${code}-bank-proof.${FILE_KINDS[kind].extensions[0]}`, bytes, contentType: FILE_KINDS[kind].contentType }
}

export interface VerifyInput {
  decision: 'verified' | 'rejected'
  remarks?: string | null | undefined
  /** The version that was checked (`updated_at`): a decision is about that account, not whatever is there now. */
  accountUpdatedAt: string
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
    // The account may have been sent in again while it was being checked. A
    // decision stands only for the version the checker was looking at.
    const current = await repo.accountNow(tx, employeeId)
    if (!current) throw Conflict(`${employee.fullName} has no bank account recorded yet.`)
    if (!sameVersion(current.updatedAt, new Date(input.accountUpdatedAt))) {
      throw Conflict(`This account was changed while you were checking it — it now ends ${lastFour(current.accountNumber)}. Look at it again before deciding.`)
    }
    const ending = lastFour(current.accountNumber)
    const decided = await repo.setVerification(tx, employeeId, current.updatedAt, {
      verificationStatus: input.decision,
      verificationRemarks: remarks,
      verifiedAt: new Date(),
      verifiedByUserId: ctx.userId,
    })
    if (decided === 0) throw Conflict('This account was changed while you were checking it. Look at it again before deciding.')
    await audit(ctx, {
      action: input.decision === 'verified' ? 'bank_account.verified' : 'bank_account.rejected',
      entityType: 'employee',
      entityId: employeeId,
      details: { accountEnding: ending, remarks },
    }, tx)
    await notify(ctx, tx, {
      event: 'bank.decided',
      to: { employee: employeeId },
      title: input.decision === 'verified' ? 'Bank account verified' : 'Bank account rejected',
      message:
        input.decision === 'verified'
          ? `Your salary account ending ${ending} was verified.`
          : `Your salary account ending ${ending} was rejected: ${remarks}. Send corrected details from your profile.`,
      link: null,
      entity: { type: 'employee', id: employeeId },
    })
  })

  logger.info('Bank account decided', { by: ctx.userId, employeeId, decision: input.decision })
  return repo.findEmployeeWithAccount(ctx.db, employeeId)
}
