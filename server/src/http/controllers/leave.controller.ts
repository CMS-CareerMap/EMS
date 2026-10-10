import type { RequestHandler } from 'express'
import type { Prisma } from '@prisma/client'
import {
  previewLeave,
  applyForLeave,
  listLeave,
  teamLeave,
  myBalances,
  cancelLeave,
  partsOf,
  myStatement,
  type LeaveList,
} from '../../modules/leave/leave.service'
import { statementPayload } from '../serializers/leaveStatement.serializer'
import type { AppContext } from '../../platform/context'
import { asApplications } from '../../domain/leave/applications'
import {
  leavePreviewSchema,
  leaveApplySchema,
  leaveQuerySchema,
  teamLeaveQuerySchema,
  balanceQuerySchema,
  statementQuerySchema,
  leaveIdSchema,
  leaveDecisionSchema,
} from '../validators/leave.validator'
import { approveLeave, rejectLeave, reverseLeave } from '../../modules/leave/leaveApproval.service'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import type { LeaveRequestRow } from '../../modules/leave/leave.repository'
import { fromDateColumn, isoInstant } from '../../domain/shared/dates'

const num = (value: Prisma.Decimal | null) => (value == null ? null : Number(value))

/**
 * One application as one line — snake_case out, matching the names the Leave
 * page already reads. A list says, for each, what the caller may do with it
 * and who decides it (Day 22: the company tree) — so a screen draws Approve
 * only where the server would take it.
 *
 * An application in parts (client, 9 Oct 2026) — the days a paid balance
 * covers, and the rest unpaid — reads as its first part, whose id every act on
 * it takes, with the dates and days of the whole, and each part in `parts`.
 * One of one type has `parts: null`.
 */
function application(parts: readonly LeaveRequestRow[], list?: LeaveList) {
  const row = parts[0]!
  const last = parts[parts.length - 1]!
  const whole = parts.length > 1
  const rights = list?.rights.get(row.id)
  return {
    ...(rights
      ? {
          can_decide: rights.canDecide,
          can_reverse: rights.canReverse,
          as_backup: rights.asBackup,
          decided_by: list?.approvers.get(row.employeeId) ?? null,
        }
      : {}),
    id: row.id,
    employee_id: row.employeeId,
    employee_code: row.employee.employeeCode,
    full_name: row.employee.fullName,
    department: row.employee.department?.name ?? null,

    leave_type: row.leaveType.code,
    leave_type_id: row.leaveTypeId,
    leave_type_name: row.leaveType.name,
    is_paid: row.leaveType.isPaid,

    from_date: fromDateColumn(row.fromDate),
    to_date: fromDateColumn(last.toDate),
    half_day_dates: parts.flatMap((p) => p.halfDayDates),
    half_day_sessions: whole ? Object.assign({}, ...parts.map((p) => p.halfDaySessions as Record<string, string>)) : row.halfDaySessions,
    days: whole ? Math.round(parts.reduce((a, p) => a + Number(p.days), 0) * 2) / 2 : num(row.days),
    leave_year: row.leaveYear,

    reason: row.reason,
    status: row.status,

    applied_on: isoInstant(row.appliedAt),
    reviewed_at: isoInstant(row.reviewedAt),
    review_note: row.reviewNote,

    group_id: row.groupId,
    // Who else of their team is away on these days — on the lists of those who decide; null
    // elsewhere, and for somebody with nobody above them: no team was looked at.
    team_away: list?.away?.has(row.id) && row.status === 'pending'
      ? list.away.get(row.id)!.map((a) => ({ employee_id: a.employeeId, full_name: a.fullName, leave_type_name: a.typeName, status: a.status, from_date: a.from, to_date: a.to }))
      : null,
    parts: whole
      ? parts.map((p) => ({
          id: p.id,
          leave_type: p.leaveType.code,
          leave_type_id: p.leaveTypeId,
          leave_type_name: p.leaveType.name,
          is_paid: p.leaveType.isPaid,
          from_date: fromDateColumn(p.fromDate),
          to_date: fromDateColumn(p.toDate),
          days: num(p.days),
        }))
      : null,
  }
}

/** A list as applications, in the order it came. */
function applications(rows: readonly LeaveRequestRow[], list?: LeaveList) {
  return asApplications(rows, (r) => fromDateColumn(r.fromDate)!).map((a) => application(a.parts, list))
}

/** The answer to an act on a request: its whole application, as it now stands. */
async function answerFor(ctx: AppContext, row: LeaveRequestRow) {
  return application((await partsOf(ctx, row)).filter((p) => p.status === row.status))
}

/**
 * POST /api/leave-requests/preview
 *
 * Its own endpoint because the answer is not obvious. Five calendar days can be
 * three working days, and somebody about to spend three of their four remaining
 * days should see that before they commit.
 */
export const postPreview: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(leavePreviewSchema, req.body)

  const preview = await previewLeave(ctx, input)

  res.status(200).json({
    data: {
      days: preview.days,
      leave_year: preview.leaveYear,
      // Every day and why it did or did not count. This is what lets somebody
      // see WHY five days is three, without reconstructing the rules.
      breakdown: preview.breakdown.map((d) => ({
        date: d.date,
        counted: d.counted,
        reason: d.reason,
      })),
      balance: {
        balance: preview.balance.balance,
        pending: preview.balance.pending,
        available: preview.balance.available,
        annual_quota: preview.balance.annualQuota,
      },
      // Unpaid with no days a year: no balance is counted (client, 9 Oct 2026).
      unlimited: preview.unlimited,
      // Null means it would be accepted. The page can show the problem without
      // the request having to fail first.
      problem: preview.problem,
      // Where the balance runs out: the application in parts, the rest unpaid —
      // sent back as `restLeaveTypeId` to apply like this. Null when not offered.
      offer: preview.offer
        ? {
            rest_leave_type_id: preview.offer.restLeaveTypeId,
            message: preview.offer.message,
            parts: preview.offer.parts.map((p) => ({
              leave_type_id: p.leaveTypeId,
              leave_type: p.code,
              leave_type_name: p.name,
              is_paid: p.isPaid,
              from_date: p.fromDate,
              to_date: p.toDate,
              days: p.days,
            })),
          }
        : null,
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** POST /api/leave-requests */
export const postLeave: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(leaveApplySchema, req.body)

  const created = await applyForLeave(ctx, input)

  res.status(201).json({ data: await answerFor(ctx, created), meta: { requestId: res.locals.requestId } })
}

/** GET /api/leave-requests — one line an application: its parts, when in parts, beneath. */
export const getLeave: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const filters = parseBody(leaveQuerySchema, req.query)

  const list = await listLeave(ctx, filters)
  const data = applications(list.rows, list)

  res.status(200).json({
    data,
    meta: { requestId: res.locals.requestId, total: data.length },
  })
}

/**
 * GET /api/leave-requests/team — the leave of the people whose leave the
 * caller decides in the company tree, whatever their role; and, apart, the
 * waiting requests they may decide only as the backup.
 */
export const getTeamLeave: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { status } = parseBody(teamLeaveQuerySchema, req.query)

  const team = await teamLeave(ctx, status)

  res.status(200).json({
    data: {
      requests: applications(team.rows, team),
      backup: applications(team.backup, team),
    },
    // How many people's leave they decide: none, and the screen offers no Team tab.
    meta: { requestId: res.locals.requestId, decides_for: team.decidesFor },
  })
}

/** GET /api/leave-requests/balances */
export const getBalances: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { employeeId } = parseBody(balanceQuerySchema, req.query)

  const { leaveYear, balances } = await myBalances(ctx, employeeId)

  res.status(200).json({
    data: {
      leave_year: leaveYear,
      balances: balances.map((b) => ({
        leave_type_id: b.leaveTypeId,
        code: b.code,
        name: b.name,
        annual_quota: b.annualQuota,
        balance: b.balance,
        // Sent separately so the page can show "4 days, 2 awaiting approval"
        // rather than one number that means neither.
        pending: b.pending,
        available: b.available,
        is_paid: b.isPaid,
        // Unpaid with no days a year: no balance — what matters is what was taken.
        unlimited: b.unlimited,
        taken: b.taken,
        accrual: b.accrual,
        unearned: b.unearned,
        encashable: b.encashable,
        half_day_allowed: b.halfDayAllowed,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET /api/leave-requests/statement — one type's passbook for a leave year: every movement, the balance after each. */
export const getStatement: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const input = parseBody(statementQuerySchema, req.query)
  const statement = await myStatement(ctx, input)
  res.status(200).json({ data: statementPayload(statement), meta: { requestId: res.locals.requestId } })
}

/** DELETE /api/leave-requests/:id — withdraw, while still pending. */
export const deleteLeave: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(leaveIdSchema, req.params)

  const cancelled = await cancelLeave(ctx, id)

  res.status(200).json({ data: await answerFor(ctx, cancelled), meta: { requestId: res.locals.requestId } })
}

/**
 * POST /api/leave-requests/:id/approve
 *
 * The balance moves here, in the same transaction as the status change — so
 * there is no moment where the request says approved and the ledger disagrees.
 */
export const postApprove: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(leaveIdSchema, req.params)
  const { note } = parseBody(leaveDecisionSchema, req.body ?? {})

  const decided = await approveLeave(ctx, id, note ?? undefined)

  res.status(200).json({ data: await answerFor(ctx, decided), meta: { requestId: res.locals.requestId } })
}

/** POST /api/leave-requests/:id/reject */
export const postReject: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(leaveIdSchema, req.params)
  const { note } = parseBody(leaveDecisionSchema, req.body ?? {})

  const decided = await rejectLeave(ctx, id, note ?? undefined)

  res.status(200).json({ data: await answerFor(ctx, decided), meta: { requestId: res.locals.requestId } })
}

/**
 * POST /api/leave-requests/:id/reverse
 *
 * Undoing an approval. The days come back through a reversing entry rather
 * than by deleting the one that took them, so both facts survive.
 */
export const postReverse: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(leaveIdSchema, req.params)
  const { note } = parseBody(leaveDecisionSchema, req.body ?? {})

  const reversed = await reverseLeave(ctx, id, note ?? undefined)

  res.status(200).json({ data: await answerFor(ctx, reversed), meta: { requestId: res.locals.requestId } })
}
