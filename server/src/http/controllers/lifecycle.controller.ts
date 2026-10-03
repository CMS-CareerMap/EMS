import type { RequestHandler } from 'express'
import * as lifecycle from '../../modules/lifecycle/lifecycle.service'
import {
  acceptSchema,
  cancelSchema,
  confirmSchema,
  exitSchema,
  idParamSchema,
  onboardingSchema,
  probationSchema,
  promoteSchema,
  recordResignationSchema,
  resignSchema,
  settingsSchema,
  transferSchema,
} from '../validators/lifecycle.validator'
import { parseBody } from '../validators/parse'
import { appContext } from '../context'
import { isoInstant } from '../../domain/shared/dates'

/**
 * The employee lifecycle (client §43).
 *
 * GET  /api/lifecycle/me                              the caller's own
 * GET  /api/lifecycle/summary                         who needs HR's attention
 * GET  /api/lifecycle/employees/:id                   somebody's lifecycle and history
 * POST /api/lifecycle/employees/:id/onboarding        onboarding complete
 * POST /api/lifecycle/employees/:id/probation         a new end of probation
 * POST /api/lifecycle/employees/:id/confirm
 * POST /api/lifecycle/employees/:id/transfer
 * POST /api/lifecycle/employees/:id/promote
 * POST /api/lifecycle/employees/:id/resignation       recorded for them by HR
 * POST /api/lifecycle/employees/:id/exit
 * POST /api/lifecycle/resignations                    the caller's own
 * GET  /api/lifecycle/resignations/waiting            waiting for the caller to accept
 * POST /api/lifecycle/resignations/:id/accept | withdraw | cancel
 * GET|PUT /api/lifecycle/settings                     probation months, notice days
 */

const meta = (res: Parameters<RequestHandler>[1]) => ({ requestId: res.locals.requestId })

function serializeView(v: lifecycle.LifecycleView) {
  const r = v.resignation
  return {
    employee_id: v.employeeId,
    full_name: v.fullName,
    stage: v.stage,
    date_of_joining: v.dateOfJoining,
    onboarded_on: v.onboardedOn,
    probation_end_date: v.probationEndDate,
    confirmed_on: v.confirmedOn,
    last_working_date: v.lastWorkingDate,
    exit_reason: v.exitReason,
    department_id: v.departmentId,
    designation_id: v.designationId,
    reporting_manager_id: v.reportingManagerId,
    resignation: r
      ? {
          id: r.id,
          status: r.status,
          reason: r.reason,
          submitted_on: r.submittedOn,
          requested_last_day: r.requestedLastDay,
          last_working_day: r.lastWorkingDay,
          submitted_by: r.submittedBy,
          on_behalf: r.onBehalf,
          decided_by: r.decidedBy,
          decided_at: isoInstant(r.decidedAt),
          decision_note: r.decisionNote,
          closed_by: r.closedBy,
          closed_at: isoInstant(r.closedAt),
          close_note: r.closeNote,
          decided_by_whom: r.decidedByWhom,
        }
      : null,
    onboarding: v.onboarding
      ? {
          login_active: v.onboarding.loginActive,
          login_invited: v.onboarding.loginInvited,
          required_documents: v.onboarding.requiredDocuments,
          verified_documents: v.onboarding.verifiedDocuments,
          bank_status: v.onboarding.bankStatus,
          has_manager: v.onboarding.hasManager,
          pan_recorded: v.onboarding.panRecorded,
        }
      : null,
    history: v.history.map((e) => ({
      id: e.id,
      kind: e.kind,
      effective_date: e.effectiveDate,
      details: e.details,
      note: e.note,
      by: e.by,
      at: isoInstant(e.at),
    })),
    settings: { probation_months: v.settings.probationMonths, notice_period_days: v.settings.noticePeriodDays },
    may: {
      complete_onboarding: v.may.completeOnboarding,
      extend_probation: v.may.extendProbation,
      confirm: v.may.confirm,
      transfer: v.may.transfer,
      promote: v.may.promote,
      record_resignation: v.may.recordResignation,
      exit: v.may.exit,
      exit_from: v.may.exitFrom,
      accept_resignation: v.may.acceptResignation,
      accept_as_backup: v.may.acceptAsBackup,
      cancel_resignation: v.may.cancelResignation,
      resign: v.may.resign,
      withdraw: v.may.withdraw,
    },
    goes_to: v.goesTo,
    detailed: v.detailed,
  }
}

const serializeItems = (items: lifecycle.SummaryItem[]) =>
  items.map((i) => ({ employee_id: i.employeeId, full_name: i.fullName, employee_code: i.employeeCode, department: i.department, date: i.date }))

export const getMine: RequestHandler = async (_req, res) => {
  const view = await lifecycle.myLifecycle(appContext(res))
  res.status(200).json({ data: serializeView(view), meta: meta(res) })
}

export const getOf: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  const view = await lifecycle.lifecycleOf(appContext(res), id)
  res.status(200).json({ data: serializeView(view), meta: meta(res) })
}

export const getSummary: RequestHandler = async (_req, res) => {
  const s = await lifecycle.summary(appContext(res))
  res.status(200).json({
    data: {
      joining_soon: serializeItems(s.joiningSoon),
      onboarding: serializeItems(s.onboarding),
      probation_ending: serializeItems(s.probationEnding),
      resigned: serializeItems(s.resigned),
      serving_notice: serializeItems(s.servingNotice),
      exit_due: serializeItems(s.exitDue),
    },
    meta: meta(res),
  })
}

/**
 * Runs a step on somebody and answers with their lifecycle as it now stands —
 * or 204, when the step took them out of the caller's sight.
 */
const step = (run: (ctx: ReturnType<typeof appContext>, id: string, body: unknown) => Promise<void>): RequestHandler =>
  async (req, res) => {
    const ctx = appContext(res)
    const { id } = parseBody(idParamSchema, req.params)
    await run(ctx, id, req.body)
    const view = await lifecycle.lifecycleIfSeen(ctx, id)
    if (!view) {
      res.status(204).end()
      return
    }
    res.status(200).json({ data: serializeView(view), meta: meta(res) })
  }

export const postOnboarding = step((ctx, id, body) => lifecycle.completeOnboarding(ctx, id, parseBody(onboardingSchema, body ?? {}).note))
export const postProbation = step((ctx, id, body) => lifecycle.extendProbation(ctx, id, parseBody(probationSchema, body)))
export const postConfirm = step((ctx, id, body) => lifecycle.confirm(ctx, id, parseBody(confirmSchema, body)))
export const postTransfer = step((ctx, id, body) => lifecycle.transfer(ctx, id, parseBody(transferSchema, body)))
export const postPromote = step((ctx, id, body) => lifecycle.promote(ctx, id, parseBody(promoteSchema, body)))
export const postRecordResignation = step((ctx, id, body) => lifecycle.recordResignation(ctx, id, parseBody(recordResignationSchema, body)))

/** The exit closes the person's record to anybody narrower than the company — so it answers 204. */
export const postExit: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  const { id } = parseBody(idParamSchema, req.params)
  await lifecycle.completeExit(ctx, id, parseBody(exitSchema, req.body))
  res.status(204).end()
}

export const postResign: RequestHandler = async (req, res) => {
  const ctx = appContext(res)
  await lifecycle.submitResignation(ctx, parseBody(resignSchema, req.body))
  res.status(201).json({ data: serializeView(await lifecycle.myLifecycle(ctx)), meta: meta(res) })
}

export const getWaiting: RequestHandler = async (_req, res) => {
  const rows = await lifecycle.waitingResignations(appContext(res))
  res.status(200).json({
    data: rows.map((r) => ({
      id: r.id,
      employee_id: r.employeeId,
      full_name: r.fullName,
      employee_code: r.employeeCode,
      department: r.department,
      designation: r.designation,
      reason: r.reason,
      submitted_on: r.submittedOn,
      requested_last_day: r.requestedLastDay,
      as_backup: r.asBackup,
      decided_by: r.decidedBy,
    })),
    meta: meta(res),
  })
}

export const postAccept: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  await lifecycle.acceptResignation(appContext(res), id, parseBody(acceptSchema, req.body))
  res.status(204).end()
}

export const postWithdraw: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  await lifecycle.withdrawResignation(appContext(res), id)
  res.status(204).end()
}

export const postCancel: RequestHandler = async (req, res) => {
  const { id } = parseBody(idParamSchema, req.params)
  await lifecycle.cancelResignation(appContext(res), id, parseBody(cancelSchema, req.body).note)
  res.status(204).end()
}

export const getSettings: RequestHandler = async (_req, res) => {
  const s = await lifecycle.getSettings(appContext(res))
  res.status(200).json({ data: { probation_months: s.probationMonths, notice_period_days: s.noticePeriodDays }, meta: meta(res) })
}

export const putSettings: RequestHandler = async (req, res) => {
  const s = await lifecycle.updateSettings(appContext(res), parseBody(settingsSchema, req.body))
  res.status(200).json({ data: { probation_months: s.probationMonths, notice_period_days: s.noticePeriodDays }, meta: meta(res) })
}
