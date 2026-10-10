import type { AppContext } from '../../platform/context'
import type { TxDb } from '../../platform/db/transaction'
import { dayLabel, fromDateColumn } from '../../domain/shared/dates'
import { notify } from '../notifications/notify.service'
import * as repo from './leave.repository'
import { approverUsers } from './leaveApprover.service'
import * as lifecycleRepo from '../lifecycle/lifecycle.repository'

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

/**
 * What a notice says of a request: whose, which type, which days. For an
 * application in parts (client, 9 Oct 2026), the whole of it — "1 day of
 * Casual Leave + 2 days of Loss of Pay", 12 to 14 Oct — unless `onlyThisPart`:
 * a part settled on its own (after a last working day) is told as itself.
 */
async function describe(tx: TxDb, requestId: string, onlyThisPart = false) {
  const r = await repo.requestFacts(tx, requestId)
  if (!r) return null
  const parts = r.groupId && !onlyThisPart ? await repo.groupFacts(tx, r.groupId) : [r]
  const from = parts.map((p) => p.fromDate).reduce((a, b) => (a < b ? a : b))
  const to = parts.map((p) => p.toDate).reduce((a, b) => (a > b ? a : b))
  return {
    id: r.id,
    employeeId: r.employeeId,
    fullName: r.employee.fullName,
    /** "2 days of Casual Leave", or each part's, joined. */
    what: parts.map((p) => `${daysOf(p.days)} of ${p.leaveType.name}`).join(' + '),
    /** "Casual Leave", or each part's type, joined. */
    name: parts.map((p) => p.leaveType.name).join(' + '),
    range: rangeOf(from, to),
  }
}

/**
 * Somebody with requests waiting was moved in the company tree: the person who
 * decides them now is told, as if the requests had just arrived. Without this
 * the only notice went to the old manager, whose Team Requests no longer show them.
 * A resignation waiting for acceptance (client §43) is decided the same way, so
 * its new decider is told too — whichever screen made the move.
 */
export async function tellNewApprovers(ctx: AppContext, tx: TxDb, employeeId: string) {
  const resignation = await lifecycleRepo.submittedResignationOf(tx, employeeId)
  if (resignation) {
    await notify(ctx, tx, {
      event: 'employment.resignation_submitted',
      to: { users: await approverUsers(tx, ctx.organizationId, employeeId) },
      title: 'A resignation',
      message: `After a change in the company tree, ${resignation.employee.fullName}'s resignation is yours to accept.`,
      link: '/dashboard',
      entity: { type: 'employee', id: employeeId },
    })
  }
  // One notice an application: its parts are decided together.
  const told = new Set<string>()
  for (const { id, groupId } of await repo.pendingIdsOf(tx, employeeId)) {
    if (groupId && told.has(groupId)) continue
    if (groupId) told.add(groupId)
    const r = await describe(tx, id)
    if (!r) continue
    await notify(ctx, tx, {
      event: 'leave.submitted',
      to: { users: await approverUsers(tx, ctx.organizationId, r.employeeId) },
      title: 'Leave request to approve',
      message: `After a change in the company tree, ${r.fullName}'s waiting request is yours to decide: ${r.what}, ${r.range}.`,
      link: '/leave?tab=decide',
      entity: { type: 'leave_request', id: r.id },
    })
  }
}

/** A request — the whole application, for one in parts — sent in or withdrawn: its approver is told. */
export async function tellApprovers(ctx: AppContext, tx: TxDb, requestId: string, event: 'leave.submitted' | 'leave.withdrawn') {
  const r = await describe(tx, requestId)
  if (!r) return
  // Their manager may file or withdraw a request for them; the notice says who did.
  const onBehalf = ctx.employeeId !== r.employeeId
  const actor = onBehalf ? ((await repo.employeeName(tx, ctx.employeeId)) ?? 'An administrator') : null
  await notify(ctx, tx, {
    event,
    // Whoever decides it in the company tree (Day 22), not a role.
    to: { users: await approverUsers(tx, ctx.organizationId, r.employeeId) },
    title: event === 'leave.submitted' ? 'Leave request to approve' : 'Leave request withdrawn',
    message:
      event === 'leave.submitted'
        ? onBehalf
          ? `${actor} asked for ${r.what} for ${r.fullName}: ${r.range}.`
          : `${r.fullName} asked for ${r.what}: ${r.range}.`
        : onBehalf
          ? `${actor} withdrew ${r.fullName}'s request for ${r.name}: ${r.range}.`
          : `${r.fullName} withdrew their request for ${r.name}: ${r.range}.`,
    // Straight to Team Requests, where the person who decides it decides it.
    link: '/leave?tab=decide',
    entity: { type: 'leave_request', id: r.id },
  })
  // Withdrawn by somebody else, the person it was for is told — it was their request.
  if (event === 'leave.withdrawn' && onBehalf) {
    await notify(ctx, tx, {
      event: 'leave.decided',
      to: { employee: r.employeeId },
      title: 'Leave request withdrawn',
      message: `${actor} withdrew your request for ${r.name}: ${r.range}.`,
      link: '/leave',
      entity: { type: 'leave_request', id: r.id },
    })
  }
}

/**
 * A decision, told to the person whose leave it is — once for an application
 * in parts. `onlyThisPart` tells of one part alone: one settled after a last
 * working day while the part before it stays.
 */
export async function tellApplicant(
  ctx: AppContext,
  tx: TxDb,
  requestId: string,
  outcome: 'approved' | 'rejected' | 'reversed',
  note?: string | null,
  onlyThisPart = false,
) {
  const r = await describe(tx, requestId, onlyThisPart)
  if (!r) return
  const why = note?.trim() ? `: ${note.trim()}` : ''
  await notify(ctx, tx, {
    event: outcome === 'reversed' ? 'leave.reversed' : 'leave.decided',
    to: { employee: r.employeeId },
    title: outcome === 'approved' ? 'Leave approved' : outcome === 'rejected' ? 'Leave rejected' : 'Leave reversed',
    message:
      outcome === 'approved'
        ? `Your ${r.name} for ${r.range} was approved${why}.`
        : outcome === 'rejected'
          ? `Your ${r.name} for ${r.range} was rejected${why}.`
          : `Your approved ${r.name} for ${r.range} was reversed${why}.`,
    link: '/leave',
    entity: { type: 'leave_request', id: r.id },
  })
}
