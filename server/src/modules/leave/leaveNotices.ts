import type { AppContext } from '../../platform/context'
import type { TxDb } from '../../platform/db/transaction'
import { dayLabel, fromDateColumn } from '../../domain/shared/dates'
import { notify } from '../notifications/notify.service'
import * as repo from './leave.repository'

/**
 * What leave tells whom — written inside each decision's own transaction.
 *
 * Settings → Notifications promised these before they existed: a request goes
 * to whoever can approve it, a decision to the person who asked, and a
 * withdrawal to whoever was asked.
 */

function rangeOf(from: Date, to: Date): string {
  const a = fromDateColumn(from)
  const b = fromDateColumn(to)
  return a === b ? dayLabel(a) : `${dayLabel(a)} to ${dayLabel(b)}`
}

function daysOf(days: unknown): string {
  const n = Number(days)
  return `${n} ${n === 1 ? 'day' : 'days'}`
}

export async function tellApprovers(ctx: AppContext, tx: TxDb, requestId: string, event: 'leave.submitted' | 'leave.withdrawn') {
  const r = await repo.requestFacts(tx, requestId)
  if (!r) return
  const range = rangeOf(r.fromDate, r.toDate)
  // HR may file or withdraw a request for somebody else; the notice says who did.
  const onBehalf = ctx.employeeId !== r.employeeId
  const actor = onBehalf ? ((await repo.employeeName(tx, ctx.employeeId)) ?? 'An administrator') : null
  await notify(ctx, tx, {
    event,
    to: { leaveApproversOf: r.employeeId },
    title: event === 'leave.submitted' ? 'Leave request to approve' : 'Leave request withdrawn',
    message:
      event === 'leave.submitted'
        ? onBehalf
          ? `${actor} asked for ${daysOf(r.days)} of ${r.leaveType.name} for ${r.employee.fullName}: ${range}.`
          : `${r.employee.fullName} asked for ${daysOf(r.days)} of ${r.leaveType.name}: ${range}.`
        : onBehalf
          ? `${actor} withdrew ${r.employee.fullName}'s request for ${r.leaveType.name}: ${range}.`
          : `${r.employee.fullName} withdrew their request for ${r.leaveType.name}: ${range}.`,
    link: '/leave',
    entity: { type: 'leave_request', id: r.id },
  })
  // Withdrawn by somebody else, the person it was for is told — it was their request.
  if (event === 'leave.withdrawn' && onBehalf) {
    await notify(ctx, tx, {
      event: 'leave.decided',
      to: { employee: r.employeeId },
      title: 'Leave request withdrawn',
      message: `${actor} withdrew your request for ${r.leaveType.name}: ${range}.`,
      link: '/leave',
      entity: { type: 'leave_request', id: r.id },
    })
  }
}

export async function tellApplicant(
  ctx: AppContext,
  tx: TxDb,
  requestId: string,
  outcome: 'approved' | 'rejected' | 'reversed',
  note?: string | null,
) {
  const r = await repo.requestFacts(tx, requestId)
  if (!r) return
  const range = rangeOf(r.fromDate, r.toDate)
  const why = note?.trim() ? `: ${note.trim()}` : ''
  await notify(ctx, tx, {
    event: outcome === 'reversed' ? 'leave.reversed' : 'leave.decided',
    to: { employee: r.employeeId },
    title: outcome === 'approved' ? 'Leave approved' : outcome === 'rejected' ? 'Leave rejected' : 'Leave reversed',
    message:
      outcome === 'approved'
        ? `Your ${r.leaveType.name} for ${range} was approved${why}.`
        : outcome === 'rejected'
          ? `Your ${r.leaveType.name} for ${range} was rejected${why}.`
          : `Your approved ${r.leaveType.name} for ${range} was reversed${why}.`,
    link: '/leave',
    entity: { type: 'leave_request', id: r.id },
  })
}
