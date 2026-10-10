import type { RequestHandler } from 'express'
import { adjustBalance, grantLeaveYear, grantPreview, teamBalances } from '../../modules/leave/leaveBalances.service'
import { leaveReminder, personLeave, personStatement, setEntitlement, setLeaveReminder } from '../../modules/leave/leaveEntitlement.service'
import { adjustSchema, balancesQuerySchema, entitlementSchema, grantSchema, personSchema, personStatementSchema, reminderSchema } from '../validators/leaveBalances.validator'
import { statementPayload } from '../serializers/leaveStatement.serializer'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * GET  /api/leave-balances                        everybody in scope, with each type's balance
 * GET  /api/leave-balances/grant-preview          what "Grant leave" would do
 * POST /api/leave-balances/grant                  grant the year to whoever has not had it
 * POST /api/leave-balances/adjustments            one correction, with its reason
 * GET  /api/leave-balances/people/:id             one person's days a year and this year's leave (the profile)
 * PUT  /api/leave-balances/people/:id/entitlement their own days a year of one type, or the company's again
 */

export const getTeamBalances: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const q = parseBody(balancesQuerySchema, req.query)
  const r = await teamBalances(ctx, q.year)
  res.status(200).json({
    data: {
      leave_year: r.leaveYear,
      label: r.label,
      years: r.years.map((y) => ({ leave_year: y.leaveYear, label: y.label })),
      // `unlimited`: unpaid with no days a year (Loss of Pay) — shown as days taken, never corrected.
      types: r.types.map((t) => ({ id: t.id, code: t.code, name: t.name, annual_quota: t.annualQuota, is_paid: t.isPaid, unlimited: t.unlimited })),
      people: r.people.map((p) => ({
        employee_id: p.employeeId,
        employee_code: p.employeeCode,
        full_name: p.fullName,
        department: p.department,
        date_of_joining: p.dateOfJoining,
        own: p.own,
        // Whether the caller may correct this balance, and if not, whom to ask (Day 22).
        may_correct: p.mayCorrect,
        correction_goes_to: p.correctionGoesTo,
        balances: p.balances.map((b) => ({ leave_type_id: b.leaveTypeId, balance: b.balance, pending: b.pending, available: b.available, taken: b.taken, unlimited: b.unlimited })),
      })),
      waiting: r.waiting ? { entries: r.waiting.entries, people: r.waiting.people, days: r.waiting.days } : null,
    },
    meta: { requestId: res.locals.requestId },
  })
}

export const getGrantPreview: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const q = parseBody(balancesQuerySchema, req.query)
  const r = await grantPreview(ctx, q.year)
  const line = (l: (typeof r.proRated)[number]) => ({
    employee_id: l.employeeId, employee_code: l.employeeCode, full_name: l.fullName, leave_type: l.leaveType, days: l.days, note: l.note,
  })
  res.status(200).json({
    data: {
      leave_year: r.leaveYear,
      label: r.label,
      entries: r.entries,
      people: r.people,
      days: r.days,
      pro_rated: r.proRated.map(line),
      carried: r.carried.map(line),
      no_joining_date: r.noJoiningDate.map((n) => ({ employee_id: n.employeeId, employee_code: n.employeeCode, full_name: n.fullName })),
      carry_later: r.carryLater,
    },
    meta: { requestId: res.locals.requestId },
  })
}

export const postGrant: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const body = parseBody(grantSchema, req.body ?? {})
  const r = await grantLeaveYear(ctx, body.leaveYear)
  res.status(201).json({
    data: { leave_year: r.leaveYear, label: r.label, entries: r.entries, people: r.people, days: r.days },
    meta: { requestId: res.locals.requestId },
  })
}

export const postAdjustment: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const body = parseBody(adjustSchema, req.body)
  const r = await adjustBalance(ctx, body)
  res.status(201).json({
    data: { employee_id: r.employeeId, leave_type_id: r.leaveTypeId, leave_year: r.leaveYear, balance: r.balance },
    meta: { requestId: res.locals.requestId },
  })
}

/** One person's leave, for the profile's Leave tab (client, 9 Oct 2026). */
export const getPersonLeave: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(personSchema, req.params)
  const r = await personLeave(ctx, id)
  res.status(200).json({
    data: {
      employee_id: r.employeeId,
      full_name: r.fullName,
      leave_year: r.leaveYear,
      label: r.label,
      // Whether the caller may change their days a year — never one's own, never a senior's — and if not, whom to ask.
      may_change: r.mayChange,
      change_goes_to: r.changeGoesTo,
      types: r.types.map((t) => ({
        leave_type_id: t.leaveTypeId,
        code: t.code,
        name: t.name,
        is_paid: t.isPaid,
        company_days: t.companyDays,
        own_days: t.ownDays,
        own_note: t.ownNote,
        unlimited: t.unlimited,
        granted: t.granted,
        taken: t.taken,
        pending: t.pending,
        available: t.available,
      })),
    },
    meta: { requestId: res.locals.requestId },
  })
}

/** GET/PUT /api/leave-balances/reminder — days before the year ends that people are told of leave about to lapse. */
export const getReminder: RequestHandler = async (_req, res) => {
  const ctx = appContext(res)
  const r = await leaveReminder(ctx)
  res.status(200).json({ data: { days: r.days }, meta: { requestId: res.locals.requestId } })
}

export const putReminder: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const body = parseBody(reminderSchema, req.body)
  const r = await setLeaveReminder(ctx, body.days)
  res.status(200).json({ data: { days: r.days }, meta: { requestId: res.locals.requestId } })
}

/** One person's statement of one type — the passbook they see — for HR on their profile. */
export const getPersonStatement: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(personSchema, req.params)
  const q = parseBody(personStatementSchema, req.query)
  const statement = await personStatement(ctx, id, q.leaveTypeId, q.leaveYear)
  res.status(200).json({ data: statementPayload(statement), meta: { requestId: res.locals.requestId } })
}

/** Their own days a year of one type — `days: null` for the company's again — applied to the years granted. */
export const putEntitlement: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(personSchema, req.params)
  const body = parseBody(entitlementSchema, req.body)
  const r = await setEntitlement(ctx, { employeeId: id, leaveTypeId: body.leaveTypeId, days: body.days, note: body.note })
  res.status(200).json({
    // What the change did to the balances already granted: days added (or taken), and any a cut could not take back.
    data: { employee_id: r.employeeId, leave_type_id: r.leaveTypeId, own_days: r.ownDays, balance_change: r.balanceChange, not_taken_back: r.notTakenBack },
    meta: { requestId: res.locals.requestId },
  })
}
