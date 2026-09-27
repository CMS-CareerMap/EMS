import type { LopBasis } from '@prisma/client'
import type { AppContext } from '../../platform/context'
import { AppError, BadRequest, BusinessRule, Conflict, NotFound } from '../../platform/errors/AppError'
import { withTransaction } from '../../platform/db/transaction'
import { lockFor } from '../../platform/db/locks'
import { logger } from '../../platform/logger'
import { audit } from '../audit/audit.service'
import { companyToday } from '../organization/organization.service'
import { listDaysOff } from '../holidays/holidays.repository'
import { calculate, type Calculation } from './payroll.service'
import { directivesFor, entriesForMonth, type DirectiveRow, type EntryRow } from './payrollInputs.repository'
import * as repo from './payrollRun.repository'
import { daysInMonth, employmentWindow, type EmploymentWindow } from '../../domain/payroll/salary'
import { leaveDaysIn, lossOfPay, monthCalendar, type LossOfPay } from '../../domain/payroll/payDays'
import { directiveFor, financialYearLabel, financialYearOf } from '../../domain/payroll/tds'
import { runTotals } from '../../domain/payroll/run'
import { transition, type RunAction, type RunStatus } from '../../domain/payroll/runStatus'
import type { Weekday } from '../../domain/leave/leaveDays'
import { fromDateColumn, toDateColumn, monthKey, monthName, type CalendarDate } from '../../domain/shared/dates'

/**
 * The payroll run: a month of calculations turned into payslips, in one
 * transaction (guide, Day 16).
 *
 * THREE STEPS, in this order, and only the last one writes:
 *
 *   1. PLAN — who is paid this month, and for how many days. Everybody
 *      employed at some point in the month; their loss of pay from attendance
 *      and approved leave; their TDS directive; their monthly entries. What is
 *      missing is collected, not thrown one at a time — an accountant fixing a
 *      run wants the whole list, not a new error after each fix.
 *
 *   2. CALCULATE — each person through the same calculate() the preview uses.
 *      There is one salary calculation in this system, and a run is not a
 *      second one.
 *
 *   3. WRITE — the run, every payslip, every line and the audit row, together.
 *      A run that is half written does not exist.
 *
 * A draft can be recalculated — attendance gets corrected, a leave gets
 * decided — or discarded. Approving and paying are Day 17.
 */

/** People calculated at once. Enough to overlap the round trips, few enough to leave the pool for everyone else. */
const CONCURRENCY = 4

export type BlockerCode = 'no_policy' | 'no_salary' | 'no_tds_directive' | 'cannot_calculate'

export interface Blocker {
  code: BlockerCode
  message: string
  employee: { id: string; employeeCode: string; fullName: string }
}

type DatedDirective = Omit<DirectiveRow, 'effectiveFrom'> & { effectiveFrom: CalendarDate }

export interface Person {
  employee: repo.MonthEmployee
  window: EmploymentWindow
  /** Null when no policy was in force — the run is blocked, and there is nothing to count days by. */
  lop: LossOfPay | null
  sandwichRule: boolean | null
  directive: DatedDirective | null
  entries: EntryRow[]
  warnings: string[]
}

export interface MonthPlan {
  year: number
  month: number
  /** The rules the run is labelled with — those in force on the earliest day anybody in it was employed. */
  rules: { lopBasis: LopBasis; sandwichRule: boolean } | null
  holidays: CalendarDate[]
  people: Person[]
  blockers: Blocker[]
  warnings: string[]
}

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const row of rows) {
    const k = key(row)
    const list = out.get(k)
    if (list) list.push(row)
    else out.set(k, [row])
  }
  return out
}

async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))))
  }
  return out
}

/** "2, 3 and 4 September 2026" — days of one month, as people read them. */
function dayList(days: readonly CalendarDate[], year: number, month: number): string {
  const numbers = days.map((day) => String(Number(day.slice(8, 10))))
  const joined =
    numbers.length > 1 ? `${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}` : (numbers[0] ?? '')
  return `${joined} ${monthName(year, month)}`
}

export const who = (employee: repo.MonthEmployee) => ({
  id: employee.id,
  employeeCode: employee.employeeCode,
  fullName: employee.fullName,
})

export const runLock = (ctx: AppContext, year: number, month: number) =>
  `payroll-run:${ctx.organizationId}:${monthKey(year, month)}`

// ── 1. Plan ─────────────────────────────────────────────────────────────────

export async function planMonth(ctx: AppContext, year: number, month: number): Promise<MonthPlan> {
  const key = monthKey(year, month)
  const monthStart = `${key}-01`
  const monthEnd = `${key}-${String(daysInMonth(year, month)).padStart(2, '0')}`
  const today = await companyToday(ctx)

  if (monthStart > today) {
    // Nothing has been worked, and every day would be paid as "not yet".
    throw BadRequest(`${monthName(year, month)} has not started yet, so there is nothing to pay.`)
  }

  const from = toDateColumn(monthStart)
  const to = toDateColumn(monthEnd)

  const everyone = await repo.employeesForMonth(ctx.db, from, to)

  // Inactive with no last working day: they left, and nobody recorded when.
  // Paying them the whole month would be a guess, and so would paying nothing.
  const onPayroll = everyone.filter((e) => e.status === 'active' || e.lastWorkingDate !== null)
  const unrecorded = everyone.filter((e) => e.status !== 'active' && e.lastWorkingDate === null)

  const ids = onPayroll.map((e) => e.id)
  const financialYear = financialYearOf(year, month)

  const [policies, dayOffRows, attendance, leave, directives, entries, salaries] = await Promise.all([
    repo.policiesForMonth(ctx.db, from, to),
    listDaysOff(ctx.db, from, to),
    repo.attendanceForMonth(ctx.db, ids, from, to),
    repo.leaveForMonth(ctx.db, ids, from, to),
    directivesFor(ctx.db, ids, financialYear),
    entriesForMonth(ctx.db, year, month),
    repo.salariesForMonth(ctx.db, ids, from, to),
  ])

  const holidays = dayOffRows.map((row) => fromDateColumn(row.date))
  const attendanceOf = groupBy(attendance, (row) => row.employeeId)
  const leaveOf = groupBy(leave, (row) => row.employeeId)
  const directivesOf = groupBy(
    directives.map((row) => ({ ...row, effectiveFrom: fromDateColumn(row.effectiveFrom) })),
    (row) => row.employeeId,
  )
  const entriesOf = groupBy(entries, (row) => row.employeeId)
  const salariesOf = groupBy(salaries, (row) => row.employeeId)

  /** The period in force on a day — the same rule calculate() applies. */
  const inForceOn = <T extends { effectiveFrom: Date; effectiveTo: Date | null }>(rows: readonly T[], day: CalendarDate) =>
    rows.find((row) => fromDateColumn(row.effectiveFrom) <= day && (row.effectiveTo === null || fromDateColumn(row.effectiveTo) >= day)) ??
    null

  const people: Person[] = []
  const blockers: Blocker[] = []
  let rules: MonthPlan['rules'] = null
  let earliest: CalendarDate | null = null

  for (const employee of onPayroll) {
    const window = employmentWindow({
      year,
      month,
      dateOfJoining: fromDateColumn(employee.dateOfJoining),
      lastWorkingDate: fromDateColumn(employee.lastWorkingDate),
    })
    if (!window) continue

    const warnings: string[] = []

    // The rules of the first day they were employed this month, as for the
    // salary itself: one date for the whole month.
    const policy = inForceOn(policies, window.from)
    let lop: LossOfPay | null = null

    if (!policy) {
      blockers.push({
        code: 'no_policy',
        employee: who(employee),
        message: `No payroll policy was in force on ${window.from}, the first day ${employee.fullName} is paid for. Set the rates in Settings first.`,
      })
    } else {
      if (earliest === null || window.from < earliest) {
        earliest = window.from
        rules = { lopBasis: policy.lopBasis, sandwichRule: policy.sandwichRule }
      }

      const weeklyOffDays = policy.weeklyOffDays as Weekday[]
      const calendar = monthCalendar({ year, month, weeklyOffDays, holidays })
      const theirLeave = leaveOf.get(employee.id) ?? []

      const approved = theirLeave
        .filter((row) => row.status === 'approved')
        .map((row) => ({
          from: fromDateColumn(row.fromDate),
          to: fromDateColumn(row.toDate),
          halfDays: row.halfDayDates,
          paid: row.leaveType.isPaid,
        }))

      lop = lossOfPay({
        calendar,
        window,
        attendance: (attendanceOf.get(employee.id) ?? []).map((row) => ({
          date: fromDateColumn(row.date),
          status: row.status,
        })),
        leave: leaveDaysIn(approved, calendar, weeklyOffDays),
        sandwichRule: policy.sandwichRule,
        today,
      })

      if (lop.unmarked.length > 0) {
        warnings.push(
          `No attendance on ${lop.unmarked.length === 1 ? 'one working day' : `${lop.unmarked.length} working days`}: ${dayList(lop.unmarked, year, month)}. Counted as paid — mark them if they were not worked.`,
        )
      }
      if (lop.markedLeave.length > 0) {
        warnings.push(
          `Marked on leave with no approved leave behind it: ${dayList(lop.markedLeave, year, month)}. Counted as paid.`,
        )
      }
      for (const pending of theirLeave.filter((row) => row.status === 'pending')) {
        warnings.push(
          `${pending.leaveType.name} from ${fromDateColumn(pending.fromDate)} to ${fromDateColumn(pending.toDate)} is waiting for a decision. Pay counts only approved leave — decide it, then recalculate.`,
        )
      }
    }

    if (!inForceOn(salariesOf.get(employee.id) ?? [], window.from)) {
      blockers.push({
        code: 'no_salary',
        employee: who(employee),
        message: `No salary is on record for ${employee.fullName} on ${window.from}. Enter it under Payroll → Salaries.`,
      })
    }

    const directive = directiveFor(directivesOf.get(employee.id) ?? [], year, month)
    if (!directive) {
      blockers.push({
        code: 'no_tds_directive',
        employee: who(employee),
        message: `No TDS directive for ${employee.fullName} for ${monthName(year, month)} (financial year ${financialYearLabel(financialYear)}). Enter the monthly amount — ₹0 with a reason if no tax is due.`,
      })
    }

    people.push({
      employee,
      window,
      lop,
      sandwichRule: policy?.sandwichRule ?? null,
      directive,
      entries: entriesOf.get(employee.id) ?? [],
      warnings,
    })
  }

  const warnings: string[] = []
  if (unrecorded.length > 0) {
    warnings.push(
      `Left out — inactive, with no last working day recorded: ${unrecorded.map((e) => `${e.fullName} (${e.employeeCode})`).join(', ')}. Record the day they left to pay their final month.`,
    )
  }
  if (today <= monthEnd) {
    warnings.push(
      `${monthName(year, month)} is not over. Days from ${today} with nothing recorded yet are counted as worked — recalculate once the month has closed.`,
    )
  }

  return { year, month, rules, holidays, people, blockers, warnings }
}

function blocked(year: number, month: number, blockers: readonly Blocker[]) {
  return BusinessRule(
    `The payroll run for ${monthName(year, month)} cannot go ahead until ${blockers.length === 1 ? 'one thing is' : `${blockers.length} things are`} fixed.`,
    {
      blockers: blockers.map((b) => ({
        code: b.code,
        message: b.message,
        employee_id: b.employee.id,
        employee_code: b.employee.employeeCode,
        full_name: b.employee.fullName,
      })),
    },
  )
}

// ── 2. Calculate ────────────────────────────────────────────────────────────

function toPayslip(person: Person, lop: LossOfPay, directive: DatedDirective, calc: Calculation): repo.NewPayslip {
  const r = calc.result
  const b = calc.basis

  const lines: repo.NewPayslipLine[] = [
    ...r.earnings.map((line, i) => ({
      kind: 'earning' as const,
      code: line.code,
      label: line.label,
      rate: b.fixedRates[line.code] ?? null,
      amount: line.amount,
      displayOrder: i,
    })),
    ...r.deductions.map((line, i) => ({
      kind: 'deduction' as const,
      code: line.code,
      label: line.label,
      rate: b.fixedRates[line.code] ?? null,
      amount: line.amount,
      displayOrder: i,
    })),
  ]

  return {
    employeeId: person.employee.id,
    year: calc.year,
    month: calc.month,
    employeeCode: person.employee.employeeCode,
    employeeName: person.employee.fullName,
    designation: person.employee.designation?.name ?? null,
    department: person.employee.department?.name ?? null,
    dateOfJoining: person.employee.dateOfJoining,
    country: person.employee.country,
    currency: person.employee.currency,

    daysInMonth: r.daysInMonth,
    employmentDays: b.employmentDays,
    lopDays: b.lopDays,
    paidDays: b.paidDays,
    // Days of their employment this month with no wages paid — which is
    // exactly the loss of pay. Days before joining or after leaving are not
    // non-contributing days; they are days they were not a member at all.
    ncpDays: lop.lopDays,
    lopBasis: b.lopBasis,
    payBasisDays: b.payBasisDays,
    payableDays: b.payableDays,

    grossEarnings: r.grossEarnings,
    pfWages: r.pfWages,
    employeePf: r.employeePf,
    employeeEsi: r.employeeEsi,
    professionalTax: r.professionalTax,
    tds: r.tds,
    otherDeductions: r.otherDeductions,
    totalDeductions: r.totalDeductions,
    netPayable: r.netPayable,

    employerPf: r.employer.pfTotal,
    employerEps: r.employer.eps,
    employerEpf: r.employer.epf,
    employerEsi: r.employer.esi,

    basis: {
      salaryEffectiveFrom: b.salaryEffectiveFrom,
      policyEffectiveFrom: b.policyEffectiveFrom,
      rates: { ...b.rates },
      sandwichRule: person.sandwichRule,
      esi: { ...b.esi },
      epsMember: b.epsMember,
      ptState: b.ptState,
      ptGender: b.ptGender,
      tdsDirective: {
        id: directive.id,
        financialYear: directive.financialYear,
        effectiveFrom: directive.effectiveFrom,
        monthlyAmount: Number(directive.monthlyAmount),
        reason: directive.reason,
      },
      monthlyEntries: person.entries.map((entry) => ({
        id: entry.id,
        code: entry.component.code,
        amount: Number(entry.amount),
        note: entry.note,
      })),
      // Only the days that cost something, each with why.
      lossOfPay: lop.days.filter((day) => day.lop > 0).map((day) => ({ ...day })),
      // The days counted as paid on no record at all — what approval asks about.
      unmarkedDays: lop.unmarked,
      daysNotYetHappened: lop.notYet,
      markedLeaveWithoutRequest: lop.markedLeave,
    },
    warnings: [...b.warnings, ...person.warnings],
    lines,
  }
}

export async function buildPayslips(ctx: AppContext, plan: MonthPlan): Promise<repo.NewPayslip[]> {
  if (plan.blockers.length > 0) throw blocked(plan.year, plan.month, plan.blockers)

  const results = await inBatches(plan.people, CONCURRENCY, async (person) => {
    const { lop, directive } = person
    // Both are there whenever nothing blocked the run; checked rather than
    // asserted, so a mistake above is a loud error and not a wrong payslip.
    if (!lop || !directive) throw new Error(`Planned without loss of pay or TDS: ${person.employee.id}`)

    try {
      const calc = await calculate(ctx, person.employee.id, plan.year, plan.month, {
        lopDays: lop.lopDays,
        tds: Number(directive.monthlyAmount),
        monthlyAmounts: Object.fromEntries(person.entries.map((entry) => [entry.component.code, Number(entry.amount)])),
        holidays: plan.holidays,
      })
      return { ok: true as const, payslip: toPayslip(person, lop, directive, calc) }
    } catch (err) {
      // A problem with this person's records — a monthly component left on a
      // salary, an archived component with an entry. Collected with the rest.
      if (!(err instanceof AppError)) throw err
      const blocker: Blocker = { code: 'cannot_calculate', employee: who(person.employee), message: err.message }
      return { ok: false as const, blocker }
    }
  })

  const failures = results.flatMap((r) => (r.ok ? [] : [r.blocker]))
  if (failures.length > 0) throw blocked(plan.year, plan.month, failures)

  return results.flatMap((r) => (r.ok ? [r.payslip] : []))
}

function runValues(plan: MonthPlan, payslips: readonly repo.NewPayslip[]): repo.RunValues {
  // Never null once payslips exist: somebody in them had a policy.
  if (!plan.rules) throw new Error('A run with payslips but no rules')
  const totals = runTotals(payslips)

  return {
    lopBasis: plan.rules.lopBasis,
    sandwichRule: plan.rules.sandwichRule,
    ...totals,
    warnings: plan.warnings,
    calculatedAt: new Date(),
  }
}

// ── 3. Write ────────────────────────────────────────────────────────────────

/** Refuses an action the run's status does not allow, in the state machine's words. */
export function assertCan(run: { year: number; month: number; status: RunStatus }, action: RunAction): void {
  const t = transition(run.status, action)
  if (!t.ok) throw Conflict(`The ${monthName(run.year, run.month)} payroll: ${t.reason}`)
}

function alreadyExists(run: { status: string }, year: number, month: number) {
  return Conflict(
    `There is already a ${run.status} payroll run for ${monthName(year, month)}. Recalculate it, or discard the draft and start again.`,
  )
}

export async function createRun(ctx: AppContext, year: number, month: number) {
  // Checked before the work as well as after it: a month already run should
  // not cost a hundred calculations to find out.
  const existing = await repo.findRunForMonth(ctx.db, year, month)
  if (existing) throw alreadyExists(existing, year, month)

  const plan = await planMonth(ctx, year, month)
  if (plan.people.length === 0) {
    throw BusinessRule(`Nobody was employed in ${monthName(year, month)}, so there is no payroll to run.`)
  }

  const payslips = await buildPayslips(ctx, plan)
  const values = runValues(plan, payslips)

  const runId = await withTransaction(ctx.db, async (tx) => {
    // Two accountants pressing Run together: the second waits here, then
    // finds the first one's run.
    await lockFor(tx, runLock(ctx, year, month))
    const raced = await repo.findRunForMonth(tx, year, month)
    if (raced) throw alreadyExists(raced, year, month)

    const run = await repo.createRun(tx, ctx.organizationId, {
      year,
      month,
      createdByUserId: ctx.userId,
      ...values,
    })
    await repo.insertPayslips(tx, ctx.organizationId, run.id, payslips)

    await audit(ctx, {
      action: 'payroll.run_created',
      entityType: 'payroll_run',
      entityId: run.id,
      details: {
        year,
        month,
        employees: values.employeeCount,
        grossEarnings: values.grossEarnings,
        netPayable: values.netPayable,
      },
    }, tx)

    return run.id
  })

  logger.info('Payroll run created', { by: ctx.userId, runId, month: monthKey(year, month), employees: values.employeeCount })
  return getRun(ctx, runId)
}

/**
 * Works a draft out again from the records as they stand now — after
 * attendance is corrected, a leave decided, a TDS directive entered. The run
 * keeps its id; its payslips are replaced.
 */
export async function recalculateRun(ctx: AppContext, id: string) {
  const run = await repo.findRun(ctx.db, id)
  if (!run) throw NotFound('Payroll run not found')
  assertCan(run, 'recalculate')

  const plan = await planMonth(ctx, run.year, run.month)
  if (plan.people.length === 0) {
    throw BusinessRule(`Nobody was employed in ${monthName(run.year, run.month)}, so there is no payroll to run.`)
  }
  const payslips = await buildPayslips(ctx, plan)
  const values = runValues(plan, payslips)

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, runLock(ctx, run.year, run.month))
    const current = await repo.findRunForMonth(tx, run.year, run.month)
    if (!current || current.id !== id) throw NotFound('Payroll run not found')
    assertCan(current, 'recalculate')

    await repo.deletePayslipsOf(tx, id)
    await repo.updateRun(tx, id, values)
    await repo.insertPayslips(tx, ctx.organizationId, id, payslips)

    await audit(ctx, {
      action: 'payroll.run_recalculated',
      entityType: 'payroll_run',
      entityId: id,
      details: {
        year: run.year,
        month: run.month,
        employees: values.employeeCount,
        grossEarnings: values.grossEarnings,
        netPayable: values.netPayable,
        previous: {
          employees: current.employeeCount,
          grossEarnings: Number(current.grossEarnings),
          netPayable: Number(current.netPayable),
        },
      },
    }, tx)
  })

  logger.info('Payroll run recalculated', { by: ctx.userId, runId: id, employees: values.employeeCount })
  return getRun(ctx, id)
}

/** Throws a draft away, payslips and all. Anything past draft is a record, and stays. */
export async function discardRun(ctx: AppContext, id: string): Promise<void> {
  const run = await repo.findRun(ctx.db, id)
  if (!run) throw NotFound('Payroll run not found')

  await withTransaction(ctx.db, async (tx) => {
    await lockFor(tx, runLock(ctx, run.year, run.month))
    const current = await repo.findRunForMonth(tx, run.year, run.month)
    if (!current || current.id !== id) throw NotFound('Payroll run not found')
    assertCan(current, 'discard')
    if ((await repo.deleteDraftRun(tx, id)) === 0) {
      throw Conflict('Somebody changed this payroll a moment ago. Refresh to see where it stands.')
    }

    await audit(ctx, {
      action: 'payroll.run_discarded',
      entityType: 'payroll_run',
      entityId: id,
      details: {
        year: run.year,
        month: run.month,
        employees: current.employeeCount,
        grossEarnings: Number(current.grossEarnings),
        netPayable: Number(current.netPayable),
      },
    }, tx)
  })

  logger.info('Payroll run discarded', { by: ctx.userId, runId: id })
}

// ── Reading ─────────────────────────────────────────────────────────────────

export async function listRuns(ctx: AppContext) {
  return repo.listRuns(ctx.db)
}

export async function getRun(ctx: AppContext, id: string) {
  const run = await repo.findRun(ctx.db, id)
  if (!run) throw NotFound('Payroll run not found')
  return { run, payslips: await repo.payslipSummaries(ctx.db, id) }
}

export async function getPayslip(ctx: AppContext, runId: string, payslipId: string) {
  const payslip = await repo.findPayslip(ctx.db, runId, payslipId)
  if (!payslip) throw NotFound('Payslip not found')
  return payslip
}

export interface Readiness {
  year: number
  month: number
  run: { id: string; status: string } | null
  blockers: Blocker[]
  warnings: string[]
  employees: {
    employee: { id: string; employeeCode: string; fullName: string }
    employmentFrom: CalendarDate
    employmentTo: CalendarDate
    /** Null when no policy says how to count them. */
    lopDays: number | null
    unmarkedDays: number
    tds: number | null
    entries: { code: string; label: string; amount: number }[]
    warnings: string[]
  }[]
}

/**
 * What a run for this month would find, without running it: who is in it,
 * their loss of pay, and everything that would stop it. Writes nothing.
 */
export async function readiness(ctx: AppContext, year: number, month: number): Promise<Readiness> {
  const [plan, run] = await Promise.all([planMonth(ctx, year, month), repo.findRunForMonth(ctx.db, year, month)])

  return {
    year,
    month,
    run: run ? { id: run.id, status: run.status } : null,
    blockers: plan.blockers,
    warnings: plan.warnings,
    employees: plan.people.map((person) => ({
      employee: who(person.employee),
      employmentFrom: person.window.from,
      employmentTo: person.window.to,
      lopDays: person.lop ? person.lop.lopDays : null,
      unmarkedDays: person.lop ? person.lop.unmarked.length : 0,
      tds: person.directive ? Number(person.directive.monthlyAmount) : null,
      entries: person.entries.map((entry) => ({
        code: entry.component.code,
        label: entry.component.label,
        amount: Number(entry.amount),
      })),
      warnings: person.warnings,
    })),
  }
}
