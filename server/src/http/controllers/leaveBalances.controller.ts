import type { RequestHandler } from 'express'
import { adjustBalance, grantLeaveYear, grantPreview, teamBalances } from '../../modules/leave/leaveBalances.service'
import { adjustSchema, balancesQuerySchema, grantSchema } from '../validators/leaveBalances.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'

/**
 * GET  /api/leave-balances                everybody in scope, with each type's balance
 * GET  /api/leave-balances/grant-preview  what "Grant leave" would do
 * POST /api/leave-balances/grant          grant the year to whoever has not had it
 * POST /api/leave-balances/adjustments    one correction, with its reason
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
      types: r.types.map((t) => ({ id: t.id, code: t.code, name: t.name, annual_quota: t.annualQuota })),
      people: r.people.map((p) => ({
        employee_id: p.employeeId,
        employee_code: p.employeeCode,
        full_name: p.fullName,
        department: p.department,
        date_of_joining: p.dateOfJoining,
        own: p.own,
        balances: p.balances.map((b) => ({ leave_type_id: b.leaveTypeId, balance: b.balance, pending: b.pending, available: b.available })),
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
