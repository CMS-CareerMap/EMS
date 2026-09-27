/**
 * The life of a payroll run, as rules rather than as if-statements scattered
 * across a service.
 *
 *   draft ──approve──▶ approved ──mark paid──▶ paid
 *     ▲                    │
 *     └──────reopen────────┘
 *
 * A draft is working figures: recalculated whenever the records change, thrown
 * away if they are wrong. Approval is somebody signing that the figures are
 * right. Paid means the money has left the bank — from then on the payslips are
 * statutory records, and nothing moves them.
 *
 * Every transition the service performs is asked of this first, and then made
 * conditionally on the status it expected, so two people acting at once cannot
 * both succeed.
 */

export type RunStatus = 'draft' | 'approved' | 'paid'

export type RunAction = 'recalculate' | 'discard' | 'approve' | 'reopen' | 'mark_paid'

/** The status an action starts from, and the one it leaves the run in. */
const MOVES: Record<RunAction, { from: RunStatus; to: RunStatus | null }> = {
  recalculate: { from: 'draft', to: 'draft' },
  // Null: the run no longer exists.
  discard: { from: 'draft', to: null },
  approve: { from: 'draft', to: 'approved' },
  reopen: { from: 'approved', to: 'draft' },
  mark_paid: { from: 'approved', to: 'paid' },
}

const VERB: Record<RunAction, string> = {
  recalculate: 'recalculated',
  discard: 'discarded',
  approve: 'approved',
  reopen: 'reopened',
  mark_paid: 'marked as paid',
}

export type Transition =
  | { ok: true; from: RunStatus; to: RunStatus | null }
  | { ok: false; reason: string }

export function transition(status: RunStatus, action: RunAction): Transition {
  const move = MOVES[action]
  if (status === move.from) return { ok: true, from: move.from, to: move.to }

  return {
    ok: false,
    reason:
      status === 'paid'
        ? `It is paid. A paid payroll is a record and cannot be ${VERB[action]}.`
        : `It is ${status}; only ${move.from === 'draft' ? 'a draft' : 'an approved run'} can be ${VERB[action]}.`,
  }
}

/** Whether a month with a run in this status is closed to changes in what feeds it. */
export function isClosed(status: RunStatus): boolean {
  return status !== 'draft'
}

/**
 * Whether an approved run may still be reopened on `today`.
 *
 * `payslipLockDay` is the company's setting: after that day of the following
 * month an approved payroll stays approved. Null means no automatic lock.
 */
export function reopenAllowed(input: {
  year: number
  month: number
  payslipLockDay: number | null
  today: string
}): boolean {
  if (input.payslipLockDay === null) return true

  const next = input.month === 12 ? { year: input.year + 1, month: 1 } : { year: input.year, month: input.month + 1 }
  const lockDate = `${next.year}-${String(next.month).padStart(2, '0')}-${String(input.payslipLockDay).padStart(2, '0')}`
  return input.today <= lockDate
}
