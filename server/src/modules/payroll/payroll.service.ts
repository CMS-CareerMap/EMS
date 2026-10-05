import type { AppContext } from '../../platform/context'
import { NotFound, BadRequest, Conflict } from '../../platform/errors/AppError'
import {
  computeSalary,
  daysInMonth,
  employmentWindow,
  withWagesShare,
  type SalaryResult,
  type SalaryComponentValue,
  type SalaryInput,
} from '../../domain/payroll/salary'
import { minutesLabel } from '../../domain/attendance/shiftRules'
import { requestNumber } from '../../domain/requests/requests'
import { arrearsFor, monthCalendar, proration, type LopBasis } from '../../domain/payroll/payDays'
import { money as rupees } from '../../domain/audit/catalogue'
import { EPS_AGE_LIMIT, epsAgeInMonth, isEpsMember, type Gender, type PtSlabRule } from '../../domain/payroll/statutory'
import type { Weekday } from '../../domain/leave/leaveDays'
import { toDateColumn, fromDateColumn, dayLabel, addCalendarDays, type CalendarDate } from '../../domain/shared/dates'
import { listDaysOff } from '../holidays/holidays.repository'
import { coverageFor, type Coverage } from './esiCoverage.service'
import * as repo from './payroll.repository'

/**
 * One employee's salary for one month, calculated from what is on record.
 *
 * This is the seam between the pure engine in `domain/payroll` and the
 * database. It gathers every input the engine needs — the salary in force that
 * month, the company's rates that month, the PT slabs for where the person
 * works, their locked ESI coverage — and hands them over. It does no
 * arithmetic of its own. If a number on a payslip is wrong, it is wrong in the
 * domain, or it was wrong in the data; it is never wrong HERE, because nothing
 * here computes anything.
 *
 * WHAT ARRIVES AS AN INPUT, and why:
 *
 *   · Loss of pay. `lopDays` is a number here. Deciding it needs attendance,
 *     approved leave and the sandwich rule — the payroll run works it out
 *     (payrollRun.service), and the preview takes whatever it is given.
 *   · TDS. The accountant's directive for the month, looked up by the run.
 *   · Monthly entries such as Incentive, recorded per employee per month and
 *     handed over by the run as `monthlyAmounts`.
 *
 * The one thing it does decide is how a day is counted — the company's LOP
 * basis — so the preview and the run can never prorate differently.
 *
 * It persists nothing but the ESI decision. The payroll RUN is what snapshots a
 * payslip, and a preview must never masquerade as one.
 */

export interface CalculationOptions {
  /** Unpaid days, from attendance. Day 16 supplies this. */
  lopDays?: number
  /** Income tax for the month, entered by hand in v1. */
  tds?: number
  /**
   * Amounts entered for this month against `monthly` components, keyed by
   * component code — `{ INCENTIVE: 5000 }`. The run supplies these from
   * EmployeeMonthlyEntry. A component with nothing entered has no line at all.
   */
  monthlyAmounts?: Record<string, number>
  /**
   * The month's declared days off, when the caller already has them. A run
   * reads them once for everybody instead of once a person. Only the
   * working-days basis needs them.
   */
  holidays?: readonly CalendarDate[]
}

export interface Calculation {
  employee: {
    id: string
    fullName: string
    employeeCode: string
  }
  year: number
  month: number
  result: SalaryResult

  /**
   * Every fact the calculation rested on, alongside the answer.
   *
   * Kept because "why is my PF ₹1,800?" has to be answerable months later, and
   * the answer is these values rather than whatever the rates happen to be on
   * the day somebody asks. Day 16 writes this onto the payslip verbatim.
   */
  basis: {
    salaryEffectiveFrom: string
    policyEffectiveFrom: string
    employmentDays: number
    lopDays: number
    /** employmentDays − lopDays: what the payslip says was paid for. */
    paidDays: number
    /** How the pay was prorated: payableDays out of payBasisDays. */
    lopBasis: LopBasis
    payBasisDays: number
    payableDays: number
    /** The rates in force, as they were — a payslip must say what it used. */
    rates: {
      pfEmployeeRate: number
      pfEmployerRate: number
      pfRestrictToCeiling: boolean
      pfWageCeiling: number
      epsWageCeiling: number
      /** The Labour Codes' wages rule: on or off, and the share. */
      wagesShareEnabled: boolean
      wagesSharePercent: number
      esiEmployeeRate: number
      esiEmployerRate: number
      esiThreshold: number
    }
    /** Each fixed component's full-month amount, by code — a payslip's "rate" column. */
    fixedRates: Record<string, number>
    esi: Coverage
    epsMember: boolean
    ptState: string | null
    ptGender: Gender
    /** Approved overtime paid this month (client §35), and how. */
    overtime: { minutes: number; rate: number; basis: 'gross' | 'basic'; amount: number; requests: string[] } | null
    /** Leave encashed and paid this month (client §36). */
    encashment: { days: number; basis: 'gross' | 'basic'; dayPay: number; amount: number; requests: string[] } | null
    /** Loans and advances recovered this month (client §40), and what is left of each after. */
    loans: { loanId: string; kind: 'loan' | 'advance'; amount: number; leftAfter: number }[]
    /** Set when something was missing and the calculation had to assume. */
    warnings: string[]
  }
  /** What this month recovers of each loan — written beside the payslip, so a draft discarded takes it back. */
  recoveries: { loanId: string; amount: number }[]
}

/**
 * The PT table uses 'any' for a slab that applies to everybody. An employee
 * recorded as 'other', or not recorded at all, is matched against that — the
 * only honest reading of a table the state wrote with two columns.
 */
/** "10 Oct 2026 and 20 Oct 2026"; three or more with commas. */
function listOfDays(days: string[]): string {
  return days.length > 1 ? `${days.slice(0, -1).join(', ')} and ${days[days.length - 1]}` : (days[0] ?? '')
}

function ptGenderOf(gender: 'male' | 'female' | 'other' | null): Gender {
  return gender === 'male' || gender === 'female' ? gender : 'any'
}

/**
 * PF wages at joining: the fixed earnings the accountant marked as counting.
 * Fixed only — a monthly entry is not part of what somebody was hired at.
 */
function pfWagesOf(
  financial: Awaited<ReturnType<typeof repo.findFirstFinancial>>,
): number {
  if (!financial) return 0
  return financial.components
    .filter(
      (row) =>
        row.component.type === 'earning' &&
        row.component.entry === 'fixed' &&
        row.component.countsForPf,
    )
    .reduce((sum, row) => sum + Number(row.amount), 0)
}

/**
 * The PF wages somebody joined on, for EPS membership — with the Labour Codes'
 * wages rule applied when it was on the day they joined. The policy of the
 * joining day, not this month's: a later switch never moves a member out.
 */
function wagesAtJoining(
  financial: Awaited<ReturnType<typeof repo.findFirstFinancial>>,
  policyAtJoining: { wagesShareEnabled: boolean; wagesSharePercent: unknown } | null,
): number {
  const wages = pfWagesOf(financial)
  if (!financial || !policyAtJoining?.wagesShareEnabled) return wages
  const gross = financial.components
    .filter((row) => row.component.type === 'earning' && row.component.entry === 'fixed')
    .reduce((sum, row) => sum + Number(row.amount), 0)
  return withWagesShare(wages, gross, Number(policyAtJoining.wagesSharePercent))
}

export async function calculate(
  ctx: AppContext,
  employeeId: string,
  year: number,
  month: number,
  options: CalculationOptions = {},
): Promise<Calculation> {
  if (month < 1 || month > 12) throw BadRequest('Month must be between 1 and 12')

  const employee = await repo.findEmployee(ctx.db, employeeId)
  // 404, not 403. Out-of-organization rows do not exist as far as the caller
  // can tell, and the scoped client has already made sure of that.
  if (!employee) throw NotFound('Employee not found')

  const warnings: string[] = []
  const label = `${year}-${String(month).padStart(2, '0')}`

  const dateOfJoining = employee.dateOfJoining ? fromDateColumn(employee.dateOfJoining) : null
  const lastWorkingDate = employee.lastWorkingDate ? fromDateColumn(employee.lastWorkingDate) : null

  const total = daysInMonth(year, month)
  const window = employmentWindow({ year, month, dateOfJoining, lastWorkingDate })

  if (!window) {
    // Joined after the month, or left before it. Not a zero payslip — there is
    // no payslip, and a figure of zero would look like one.
    throw BadRequest(`${employee.fullName} was not employed in ${label}`)
  }

  if (!dateOfJoining) {
    warnings.push('No joining date is recorded, so the whole month was treated as employed.')
  }

  // The date "in force" is judged on: the first day of the month they were
  // actually employed. Usually the 1st. For somebody who joined on the 16th it
  // is the 16th, because their first salary record starts on the day they
  // joined — asking what was in force on the 1st finds nothing and reports a
  // new joiner as having no salary at all.
  //
  // One date for the whole month. A raise that starts on the 15th is next
  // month's salary; splitting a month across two salary records is a policy
  // nobody has decided, and guessing at one would give a figure no accountant
  // could reproduce.
  const monthStart = `${label}-01`
  const monthEnd = `${label}-${String(total).padStart(2, '0')}`
  const firstEmployedDay = toDateColumn(
    dateOfJoining && dateOfJoining > monthStart ? dateOfJoining : monthStart,
  )

  const financial = await repo.findFinancialOn(ctx.db, employeeId, firstEmployedDay)
  if (!financial) {
    // No salary on record for that month is NOT a zero salary. Returning a
    // payslip of zeros would look like a calculation; this is a missing fact.
    throw NotFound(`No salary is on record for ${employee.fullName} in ${label}`)
  }

  const policy = await repo.findPolicyOn(ctx.db, firstEmployedDay)
  if (!policy) {
    throw NotFound('No payroll policy was in force that month. Set the rates in Settings first.')
  }

  // A salary that starts inside the month is paid from next month, as above —
  // so the days at the new rate this month are not paid by this payslip, and
  // nobody would know. Said below, with the figure, for Accounts to settle as arrears.
  // To their last day this month: a change after it touches none of their days.
  const changes = await repo.financialsStartingBetween(ctx.db, employeeId, firstEmployedDay, toDateColumn(window.to))

  // A monthly component sitting on the salary record would be paid every
  // month at the same figure — a raise called an incentive — and prorated for
  // a short month. Neither reading is what anybody decided, so this refuses
  // rather than picking one.
  const misplaced = financial.components.filter((row) => row.component.entry === 'monthly')
  if (misplaced.length > 0) {
    throw Conflict(
      `${misplaced.map((row) => row.component.label).join(', ')} is entered each month, not on the salary record. Remove it from ${employee.fullName}'s salary and enter it for the month instead.`,
    )
  }

  const components: SalaryComponentValue[] = financial.components.map((row) => ({
    code: row.component.code,
    label: row.component.label,
    amount: Number(row.amount),
    type: row.component.type,
    countsForPf: row.component.countsForPf,
    countsForEsi: row.component.countsForEsi,
    countsForPt: row.component.countsForPt,
    entry: 'fixed',
  }))

  if (components.length === 0) {
    warnings.push('The salary record has no components, so every figure is zero.')
  }

  const fixedRates = Object.fromEntries(components.map((c) => [c.code, c.amount]))

  const entered = Object.entries(options.monthlyAmounts ?? {})
  if (entered.length > 0) {
    const catalogue = new Map(
      (await repo.listSalaryComponents(ctx.db)).map((component) => [component.code, component]),
    )

    for (const [code, amount] of entered) {
      const component = catalogue.get(code)
      if (!component) {
        throw BadRequest(`${code} is not a salary component this company uses`)
      }
      if (component.entry !== 'monthly') {
        // A fixed component comes from the salary record. Accepting an amount
        // for it here would let one month's calculation quietly override the
        // record, and the payslip would not match anything stored.
        throw BadRequest(`${component.label} comes from the salary record and cannot be entered for a month`)
      }
      // Nothing entered means no line, not a line reading zero.
      if (amount === 0) continue

      components.push({
        code: component.code,
        label: component.label,
        amount,
        type: component.type,
        countsForPf: component.countsForPf,
        countsForEsi: component.countsForEsi,
        countsForPt: component.countsForPt,
        entry: 'monthly',
      })
    }
  }

  // The working-days basis needs the calendar's holidays; the other two only
  // need to know how long the month is and which of it they were employed.
  const holidays =
    policy.lopBasis === 'working_days'
      ? (options.holidays ??
        (await listDaysOff(ctx.db, toDateColumn(monthStart), toDateColumn(monthEnd))).map((h) =>
          fromDateColumn(h.date),
        ))
      : []
  const calendar = monthCalendar({
    year,
    month,
    weeklyOffDays: policy.weeklyOffDays as Weekday[],
    holidays,
  })

  const lopDays = options.lopDays ?? 0
  const days = proration({ lopBasis: policy.lopBasis, calendar, window, lopDays })
  const employmentDays = days.employmentDays

  if (lopDays < 0) throw BadRequest('Loss-of-pay days cannot be negative')
  if (lopDays > employmentDays) {
    throw BadRequest(`Loss-of-pay days (${lopDays}) exceed the ${employmentDays} days employed`)
  }

  if (days.fellBackToCalendar) {
    warnings.push('The calendar has no working days this month, so pay was divided by calendar days instead.')
  }

  // Each new salary's own days — from its start to the next one's, or their
  // last day — on the same basis as the month, against the salary this month
  // pays: Accounts enters a figure rather than working one out (or starts
  // changes on the 1st, which avoids it). Nothing said when none of their
  // days are at a new rate.
  if (changes.length > 0) {
    const grossOf = (rows: { amount: unknown; component: { type: string; entry: string } }[]) =>
      rows.filter((row) => row.component.type === 'earning' && row.component.entry === 'fixed').reduce((sum, row) => sum + Number(row.amount), 0)
    const paidGross = grossOf(financial.components)
    const pieces = changes.map((change, i) => {
      const from = fromDateColumn(change.effectiveFrom)!
      const next = changes[i + 1]
      const to = next ? addCalendarDays(fromDateColumn(next.effectiveFrom)!, -1) : window.to
      const difference = grossOf(change.components) - paidGross
      return { from, difference, ...arrearsFor({ lopBasis: days.lopBasis, calendar, window: { from: window.from, to }, changeFrom: from, monthlyDifference: difference }) }
    })
    // Added before rounding, so two changes give the paisa one would.
    const total = Math.round(pieces.reduce((sum, p) => sum + (p.payBasisDays > 0 ? (p.difference * p.payableDays) / p.payBasisDays : 0), 0) * 100) / 100
    const daysAtNewRate = pieces.reduce((sum, p) => sum + p.payableDays, 0)
    const single = pieces.length === 1 ? pieces[0]! : null
    const starts = single
      ? `A new${total < 0 ? ', lower' : ''} salary starts on ${dayLabel(single.from)}`
      : `New salaries start on ${listOfDays(pieces.map((p) => dayLabel(p.from)))}`
    const how = single
      ? `${rupees(Math.abs(single.difference))} a month × ${single.payableDays} of ${single.payBasisDays} days`
      : 'each for its own days'
    // Already entered: said, so it is not entered twice.
    const arrearsEntered = Number(options.monthlyAmounts?.ARREARS ?? 0)
    if (daysAtNewRate > 0 && total > 0) {
      warnings.push(
        `${starts}. This month is paid on the earlier one: the days from then are short by ${rupees(total)} (${how}, before any loss of pay on those days). ` +
          (arrearsEntered > 0 ? `${rupees(arrearsEntered)} is entered as Arrears this month.` : 'Enter it as Arrears for this month, or start salary changes on the 1st.'),
      )
    } else if (daysAtNewRate > 0 && total < 0) {
      warnings.push(
        `${starts}. This month is paid on the earlier one: the days from then are overpaid by ${rupees(-total)} (${how}). ` +
          'Recover it next month with a monthly deduction (add one under Payroll → Components if there is none), or start salary changes on the 1st.',
      )
    } else if (daysAtNewRate > 0) {
      warnings.push(`${starts}, with the same gross. This month is paid on the earlier one; how it is split may differ from the new one.`)
    }
  }

  // Approved overtime and leave encashment (client §35–36), paid as entered
  // lines: a day's pay is the month's fixed earnings on the company's basis —
  // all of them, or those that count for PF — over the month's pay days, as
  // for loss of pay; an hour's is that over the day's expected hours.
  const fullMonth = (basis: 'gross' | 'basic') =>
    financial.components
      .filter((row) => row.component.type === 'earning' && row.component.entry === 'fixed' && (basis === 'gross' || row.component.countsForPf))
      .reduce((sum, row) => sum + Number(row.amount), 0)
  const dayPay = (basis: 'gross' | 'basic') => (days.payBasisDays > 0 ? fullMonth(basis) / days.payBasisDays : 0)
  const overtime = await overtimePay(ctx, employeeId, year, month, policy, dayPay(policy.overtimeBasis), warnings)
  if (overtime && overtime.amount > 0) {
    components.push({ code: 'OT', label: 'Overtime', amount: overtime.amount, type: 'earning', countsForPf: false, countsForEsi: true, countsForPt: true, entry: 'monthly' })
  }
  const encashed = await repo.encashmentsPaidIn(ctx.db, employeeId, year, month)
  const encashedDays = encashed.reduce((sum, r) => sum + Number((r.details as { days?: number }).days ?? 0), 0)
  if (encashedDays > 0 && !(dayPay(policy.encashmentBasis) > 0)) {
    warnings.push(`${encashedDays} day${encashedDays === 1 ? '' : 's'} of leave were encashed, but the salary has no ${policy.encashmentBasis === 'basic' ? 'Basic or DA' : 'fixed earnings'} to work a day's pay out from, so nothing was paid. Check Settings → Payroll Config.`)
  }
  const encashment = encashedDays > 0
    ? { days: encashedDays, basis: policy.encashmentBasis, dayPay: paise(dayPay(policy.encashmentBasis)), amount: paise(encashedDays * dayPay(policy.encashmentBasis)), requests: encashed.map((r) => requestNumber(r.number)) }
    : null
  if (encashment && encashment.amount > 0) {
    // Outside ESI wages, as the ESIC reads leave encashment; inside the PT gross.
    components.push({ code: 'LEAVE_ENC', label: 'Leave encashment', amount: encashment.amount, type: 'earning', countsForPf: false, countsForEsi: false, countsForPt: true, entry: 'monthly' })
  }

  const identity = employee.statutoryIdentity
  const ptState = identity?.ptState ?? null
  const ptGender = ptGenderOf(employee.gender)

  if (!ptState) {
    warnings.push('No PT state is recorded, so no professional tax was deducted.')
  }

  const slabs: PtSlabRule[] = ptState
    ? (await repo.findPtSlabsOn(ctx.db, ptState, firstEmployedDay)).map((slab) => ({
        state: slab.state,
        gender: slab.gender,
        wageFrom: Number(slab.minGross),
        wageTo: slab.maxGross == null ? null : Number(slab.maxGross),
        amount: Number(slab.amount),
        februaryAmount: slab.februaryAmount == null ? null : Number(slab.februaryAmount),
      }))
    : []

  if (ptState && slabs.length === 0) {
    // Zero PT, and said out loud. An unconfigured state is a setup gap, not a
    // tax holiday, and it has to be closed before the first real payslip.
    warnings.push(`No PT slabs are configured for ${ptState}, so no professional tax was deducted.`)
  }

  if (ptState && ptGender === 'any' && slabs.length > 0 && !slabs.some((s) => s.gender === 'any')) {
    warnings.push(
      `${ptState} has gendered PT slabs and no gender is recorded for this employee, so no professional tax was deducted.`,
    )
  }

  const pfApplicable = identity?.pfApplicable ?? true

  const [first, policyAtJoining] = await Promise.all([
    repo.findFirstFinancial(ctx.db, employeeId),
    employee.dateOfJoining ? repo.findPolicyOn(ctx.db, employee.dateOfJoining) : Promise.resolve(null),
  ])
  // Recorded on their record from their PF record, it stands — whatever
  // later changes what counts as PF wages or the pension ceiling. Left blank,
  // payroll works it out from what they joined on.
  const recorded = identity?.epsMember ?? null
  const member = recorded ?? isEpsMember({
    dateOfJoining: employee.dateOfJoining ? fromDateColumn(employee.dateOfJoining) : null,
    pfWagesAtJoining: wagesAtJoining(first, policyAtJoining),
    hasPriorMembership: identity?.hasPriorPfMembership ?? false,
    epsWageCeiling: Number(policy.epsWageCeiling),
  })
  // A member stops contributing to the pension at 58, whatever they were.
  const age = epsAgeInMonth(employee.dateOfBirth ? fromDateColumn(employee.dateOfBirth) : null, year, month)
  const epsMember = member && age !== 'over'
  // Without a date of birth the age is unknown, and is read as under 58: the
  // pension would go on being paid past it, with nothing to say so.
  if (pfApplicable && member && !employee.dateOfBirth) {
    warnings.push(`No date of birth is recorded, so the pension (EPS) cannot be stopped at ${EPS_AGE_LIMIT}. Record it in the employee's personal details.`)
  }
  if (pfApplicable && member && age === 'turns_this_month') {
    warnings.push(
      `Turns ${EPS_AGE_LIMIT} this month: pension (EPS) stops from the birthday, and the PF return splits this month's employer share by the days on each side. ` +
        'From next month the whole employer share goes to EPF.',
    )
  }

  if (pfApplicable && recorded === null && !member) {
    warnings.push(
      'Excluded from EPS: worked out as a new PF member above the pension ceiling when they joined. ' +
        (identity?.hasPriorPfMembership == null ? 'Confirm they were never a member before — if they were, they belong in EPS. ' : '') +
        'If their PF record says they are an EPS member, record it on their record under Statutory Details.',
    )
  }

  const esi = await coverageFor(ctx, employeeId, year, month)

  const input: SalaryInput = {
    components,
    paidDays: days.paidDays,
    daysInMonth: total,
    proration: { payable: days.payableDays, basis: days.payBasisDays },
    year,
    month,
    pf: {
      applicable: pfApplicable,
      employeeRate: Number(policy.pfEmployeeRate),
      employerRate: Number(policy.pfEmployerRate),
      restrictToCeiling: policy.pfRestrictToCeiling,
      wageCeiling: Number(policy.pfWageCeiling),
      epsWageCeiling: Number(policy.epsWageCeiling),
      epsMember,
      wagesShare: policy.wagesShareEnabled ? Number(policy.wagesSharePercent) : null,
    },
    esi: {
      covered: esi.covered,
      employeeRate: Number(policy.esiEmployeeRate),
      employerRate: Number(policy.esiEmployerRate),
    },
    pt: { state: ptState, gender: ptGender, slabs },
    tds: options.tds ?? 0,
  }

  // Loans and advances (client §40): this month's installment of each, taken
  // only from what the month pays — never into a negative salary.
  const beforeLoans = computeSalary(input)
  const loans = await loanRecoveries(ctx, employeeId, year, month, beforeLoans.netPayable, warnings)
  for (const kind of ['loan', 'advance'] as const) {
    const amount = paise(loans.filter((l) => l.kind === kind).reduce((sum, l) => sum + l.amount, 0))
    if (amount > 0) {
      components.push({ code: kind === 'loan' ? 'LOAN' : 'ADVANCE', label: kind === 'loan' ? 'Loan recovery' : 'Salary advance recovery', amount, type: 'deduction', countsForPf: false, entry: 'monthly' })
    }
  }
  const result = loans.length > 0 ? computeSalary(input) : beforeLoans

  if (result.netPayable < 0) {
    warnings.push('Deductions exceed earnings this month, so net pay is negative.')
  }

  return {
    employee: {
      id: employee.id,
      fullName: employee.fullName,
      employeeCode: employee.employeeCode,
    },
    year,
    month,
    result,
    basis: {
      salaryEffectiveFrom: fromDateColumn(financial.effectiveFrom),
      policyEffectiveFrom: fromDateColumn(policy.effectiveFrom),
      employmentDays,
      lopDays,
      paidDays: days.paidDays,
      lopBasis: days.lopBasis,
      payBasisDays: days.payBasisDays,
      payableDays: days.payableDays,
      rates: {
        pfEmployeeRate: Number(policy.pfEmployeeRate),
        pfEmployerRate: Number(policy.pfEmployerRate),
        pfRestrictToCeiling: policy.pfRestrictToCeiling,
        pfWageCeiling: Number(policy.pfWageCeiling),
        epsWageCeiling: Number(policy.epsWageCeiling),
        wagesShareEnabled: policy.wagesShareEnabled,
        wagesSharePercent: Number(policy.wagesSharePercent),
        esiEmployeeRate: Number(policy.esiEmployeeRate),
        esiEmployerRate: Number(policy.esiEmployerRate),
        esiThreshold: Number(policy.esiThreshold),
      },
      fixedRates,
      esi,
      epsMember,
      ptState,
      ptGender,
      overtime,
      encashment,
      loans: loans.map((l) => ({ loanId: l.loanId, kind: l.kind, amount: l.amount, leftAfter: l.leftAfter })),
      warnings,
    },
    recoveries: loans.map((l) => ({ loanId: l.loanId, amount: l.amount })),
  }
}

/** Two decimal places, as every amount on a payslip. */
const paise = (value: number) => Math.round(value * 100) / 100

/**
 * The month's approved overtime, paid at the company's rate (client §35). An
 * approved claim pays no more than the day still records — a day corrected
 * down after approval pays what it now shows, and says so.
 */
async function overtimePay(
  ctx: AppContext,
  employeeId: string,
  year: number,
  month: number,
  policy: { overtimeRate: unknown; overtimeBasis: 'gross' | 'basic' },
  dayPay: number,
  warnings: string[],
) {
  const { requests, days } = await repo.approvedOvertimeIn(ctx.db, employeeId, year, month)
  if (requests.length === 0) return null
  if (!(dayPay > 0)) {
    warnings.push(`Overtime was approved (${requests.map((r) => requestNumber(r.number)).join(', ')}), but the salary has no ${policy.overtimeBasis === 'basic' ? 'Basic or DA' : 'fixed earnings'} to work an hour's pay out from, so none was paid. Check Settings → Payroll Config.`)
    return null
  }
  // An approved claim is paid, at the rate of the month it is paid in — the
  // switch decides whether overtime can be claimed, not whether a claim
  // already approved is honoured.
  const rate = Number(policy.overtimeRate)
  const byDate = new Map(days.map((d) => [fromDateColumn(d.date), d]))
  let minutes = 0
  let amount = 0
  for (const r of requests) {
    const date = fromDateColumn(r.fromDate)
    if (!date) continue
    const day = byDate.get(date)
    const asked = Number((r.details as { minutes?: number }).minutes ?? 0)
    const paid = Math.min(asked, day?.overtimeMinutes ?? 0)
    if (paid < asked) {
      warnings.push(`${requestNumber(r.number)} approved ${minutesLabel(asked)} of overtime on ${dayLabel(date)}, but that day now records ${minutesLabel(day?.overtimeMinutes ?? 0)}; ${minutesLabel(paid)} was paid.`)
    }
    let expected = Number(day?.expectedHours ?? day?.shift?.expectedHours ?? 0)
    if (!(expected > 0)) {
      expected = 8
      warnings.push(`No shift hours are recorded for ${dayLabel(date)}, so an hour of overtime was paid as an eighth of a day.`)
    }
    minutes += paid
    amount += (paid / 60) * (dayPay / expected) * rate
  }
  return { minutes, rate, basis: policy.overtimeBasis, amount: paise(amount), requests: requests.map((r) => requestNumber(r.number)) }
}

/**
 * This month's installment of each loan and advance still owed (client §40):
 * the installment, or what is left if less — and no more than the month pays,
 * so a short month recovers less rather than paying a negative salary.
 * What other months' payslips recovered is counted; this month's own draft is
 * not, so recalculating it never recovers twice.
 */
async function loanRecoveries(ctx: AppContext, employeeId: string, year: number, month: number, netBeforeLoans: number, warnings: string[]) {
  const loans = await repo.loansRecoveringIn(ctx.db, employeeId, year, month)
  let room = Math.max(0, netBeforeLoans)
  const out: { loanId: string; kind: 'loan' | 'advance'; amount: number; leftAfter: number }[] = []
  for (const loan of loans) {
    const recovered = loan.recoveries
      .filter((r) => !(r.payslip.year === year && r.payslip.month === month))
      .reduce((sum, r) => sum + Number(r.amount), 0)
    const left = paise(Number(loan.amount) - recovered)
    if (left <= 0) continue
    const due = Math.min(Number(loan.installment), left)
    const take = paise(Math.min(due, room))
    const what = loan.kind === 'loan' ? 'loan' : 'salary advance'
    if (take < due) warnings.push(`Only ₹${take} of this month’s ₹${due} ${what} installment was recovered — the month’s pay does not cover more. The rest stays owed.`)
    if (take <= 0) continue
    room = paise(room - take)
    out.push({ loanId: loan.id, kind: loan.kind, amount: take, leftAfter: paise(left - take) })
  }
  return out
}

export async function listComponents(ctx: AppContext) {
  return repo.listSalaryComponents(ctx.db)
}

/** 404 unless the employee exists inside the caller's organization. */
export async function assertEmployeeVisible(ctx: AppContext, employeeId: string): Promise<void> {
  const employee = await repo.findEmployee(ctx.db, employeeId)
  if (!employee) throw NotFound('Employee not found')
}
