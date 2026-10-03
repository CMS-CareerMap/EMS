import {
  computePf,
  computeEsi,
  computePt,
  type PtSlabRule,
  type Gender,
} from './statutory'

/**
 * One salary calculation, for one employee, for one month.
 *
 * THE ONE COPY. The audit found this arithmetic written out seven times across
 * the codebase — in pages, in modals, in hooks — each with its own rounding and
 * its own idea of which allowances count. Seven copies do not drift apart
 * loudly; they drift by a rupee, in one of them, and nobody finds out until an
 * employee compares two screens.
 *
 * Pure. Every rate, every slab and every policy decision arrives as an
 * argument, so the whole of payroll can be tested without a database — which is
 * what makes a thirty-employee golden test cheap enough to run on every commit.
 */

function paise(value: number): number {
  return Math.round(value * 100) / 100
}

export interface SalaryComponentValue {
  code: string
  label: string
  amount: number
  /** Earnings add to gross; deductions come off it. */
  type: 'earning' | 'deduction'
  /** Whether this counts toward PF wages, decided by the accountant. */
  countsForPf: boolean
  /**
   * `fixed` (the default) is a monthly rate from the salary record, prorated by
   * paid days. `monthly` is an amount somebody entered for this one month —
   * Incentive, per the client — and is paid exactly as entered.
   *
   * Prorating an incentive would be wrong in a way nobody notices: a joiner
   * awarded ₹5,000 for their first fortnight would receive ₹2,500, because
   * the arithmetic treated a decision as a rate.
   */
  entry?: 'fixed' | 'monthly'
}

export interface SalaryInput {
  /**
   * Fixed components at their FULL monthly rate, before any proration, and
   * monthly entries at the amount entered.
   */
  components: readonly SalaryComponentValue[]

  /**
   * Days actually payable, and days in the month.
   *
   * A mid-month joiner, a mid-month leaver and a month with loss of pay all
   * arrive the same way: fewer paid days out of the same total. One mechanism
   * rather than three special cases.
   */
  paidDays: number
  daysInMonth: number

  /**
   * What the pay is prorated by, when the company does not count calendar
   * days: `payable` out of `basis`, from payDays.proration(). Left out, it is
   * paidDays out of daysInMonth — which is what calendar days means.
   */
  proration?: { payable: number; basis: number }

  /** 1–12. February matters for professional tax in some states. */
  month: number
  year: number

  pf: {
    applicable: boolean
    employeeRate: number
    employerRate: number
    restrictToCeiling: boolean
    wageCeiling: number
    /** The pension scheme's ceiling, which need not be the PF ceiling. */
    epsWageCeiling: number
    epsMember: boolean
    /**
     * The Labour Codes' wages rule, as a percent — PF wages are at least this
     * share of what was earned — or null when the company has it off.
     */
    wagesShare?: number | null
  }

  esi: {
    /** From the LOCKED coverage record for this period — never re-tested here. */
    covered: boolean
    employeeRate: number
    employerRate: number
  }

  pt: {
    state: string | null
    gender: Gender
    slabs: readonly PtSlabRule[]
  }

  /** Entered by hand per employee per month for v1. Never computed. */
  tds: number
}

export interface SalaryResult {
  /** Every component after proration, for the payslip to render. */
  earnings: { code: string; label: string; amount: number }[]
  deductions: { code: string; label: string; amount: number }[]

  grossEarnings: number
  /** What PF was calculated on, after proration and any ceiling. */
  pfWages: number
  /**
   * Set when the wages rule raised PF wages: the share applied, the wages the
   * components came to, and what they were raised to (before any ceiling).
   */
  wagesShare: { percent: number; wages: number; raisedTo: number } | null

  employeePf: number
  employeeEsi: number
  professionalTax: number
  tds: number
  otherDeductions: number
  totalDeductions: number

  netPayable: number

  /** Employer cost, which never appears on the payslip but does on returns. */
  employer: {
    pfTotal: number
    eps: number
    epf: number
    esi: number
  }

  /** Days the pay was prorated to, kept so a payslip can explain itself. */
  paidDays: number
  daysInMonth: number
  lopDays: number
}

/**
 * Prorates a full-month amount to the days actually payable.
 *
 * Calendar days, not working days. That is the common Indian practice and it is
 * also the only one that makes a month's pay independent of how many Sundays it
 * happened to contain — using working days would pay somebody differently for
 * the same absence depending on which month it fell in.
 */
function prorate(amount: number, paidDays: number, daysInMonth: number): number {
  if (daysInMonth <= 0) return 0
  if (paidDays >= daysInMonth) return paise(amount)
  if (paidDays <= 0) return 0

  return paise((amount * paidDays) / daysInMonth)
}

/**
 * PF wages under the Labour Codes' wages rule (Code on Wages 2019, s.2(y)):
 * whatever the left-out allowances come to beyond a share of the whole pay
 * counts as wages — one half, unless another share is notified. In effect the
 * wages are never less than that share of the gross. `percent` null: the rule
 * is off. Compared in whole rupees, so a paisa of proration never triggers it.
 */
export function withWagesShare(wages: number, gross: number, percent: number | null): number {
  if (!percent) return wages
  const floor = paise((gross * percent) / 100)
  return Math.round(floor) > Math.round(wages) ? floor : wages
}

export function computeSalary(input: SalaryInput): SalaryResult {
  const paidDays = Math.max(0, Math.min(input.paidDays, input.daysInMonth))
  const units = input.proration ?? { payable: paidDays, basis: input.daysInMonth }

  const earnings: SalaryResult['earnings'] = []
  const componentDeductions: SalaryResult['deductions'] = []

  let grossEarnings = 0
  let pfWagesFull = 0

  for (const component of input.components) {
    const amount =
      component.entry === 'monthly'
        ? paise(component.amount)
        : prorate(component.amount, units.payable, units.basis)

    if (component.type === 'earning') {
      earnings.push({ code: component.code, label: component.label, amount })
      grossEarnings = paise(grossEarnings + amount)

      // PF wages are prorated too. An employee who worked half the month has
      // half the PF wages — contributions follow what was earned, not what the
      // contract says.
      if (component.countsForPf) pfWagesFull = paise(pfWagesFull + amount)
    } else {
      componentDeductions.push({ code: component.code, label: component.label, amount })
    }
  }

  // The Labour Codes' wages rule — prorated, since the gross is.
  const share = input.pf.applicable ? (input.pf.wagesShare ?? null) : null
  const pfWagesDue = withWagesShare(pfWagesFull, grossEarnings, share)

  const pf = input.pf.applicable
    ? computePf({
        pfWages: pfWagesDue,
        employeeRate: input.pf.employeeRate,
        employerRate: input.pf.employerRate,
        restrictToCeiling: input.pf.restrictToCeiling,
        wageCeiling: input.pf.wageCeiling,
        epsWageCeiling: input.pf.epsWageCeiling,
        epsMember: input.pf.epsMember,
      })
    : { pfWages: 0, employee: 0, employerTotal: 0, employerEps: 0, employerEpf: 0 }

  // Recorded only where the rule changed what PF was worked out on — not a
  // raise the wage ceiling then took back in full.
  const withoutRule = input.pf.restrictToCeiling ? Math.min(pfWagesFull, input.pf.wageCeiling) : pfWagesFull
  const wagesShare = share && pfWagesDue > pfWagesFull && pf.pfWages > withoutRule
    ? { percent: share, wages: pfWagesFull, raisedTo: pfWagesDue }
    : null

  const esi = computeEsi({
    grossPaid: grossEarnings,
    employeeRate: input.esi.employeeRate,
    employerRate: input.esi.employerRate,
    covered: input.esi.covered,
  })

  const professionalTax = computePt({
    state: input.pt.state,
    gender: input.pt.gender,
    // Against the gross actually paid. A month of unpaid leave that drops
    // somebody into a lower slab genuinely lowers their PT.
    gross: grossEarnings,
    month: input.month,
    slabs: input.pt.slabs,
  })

  const otherDeductions = paise(
    componentDeductions.reduce((sum, d) => sum + d.amount, 0),
  )

  const totalDeductions = paise(
    pf.employee + esi.employee + professionalTax + input.tds + otherDeductions,
  )

  return {
    earnings,
    deductions: [
      ...componentDeductions,
      ...(pf.employee > 0 ? [{ code: 'PF', label: 'Provident Fund', amount: pf.employee }] : []),
      ...(esi.employee > 0 ? [{ code: 'ESI', label: 'ESI', amount: esi.employee }] : []),
      ...(professionalTax > 0
        ? [{ code: 'PT', label: 'Professional Tax', amount: professionalTax }]
        : []),
      ...(input.tds > 0 ? [{ code: 'TDS', label: 'Income Tax (TDS)', amount: input.tds }] : []),
    ],

    grossEarnings,
    pfWages: pf.pfWages,
    wagesShare,

    employeePf: pf.employee,
    employeeEsi: esi.employee,
    professionalTax,
    tds: paise(input.tds),
    otherDeductions,
    totalDeductions,

    // Can go negative if deductions exceed a heavily prorated gross. Returned
    // as it is rather than clamped to zero — a negative net is a real problem
    // somebody has to look at, and hiding it behind a zero means they will not.
    netPayable: paise(grossEarnings - totalDeductions),

    employer: {
      pfTotal: pf.employerTotal,
      eps: pf.employerEps,
      epf: pf.employerEpf,
      esi: esi.employer,
    },

    paidDays,
    daysInMonth: input.daysInMonth,
    lopDays: paise(input.daysInMonth - paidDays),
  }
}

/** Days in a calendar month. Handles February without a lookup table. */
export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/**
 * How many calendar days of a month fall inside somebody's employment.
 *
 * The window runs from the later of joining and the 1st, to the earlier of
 * their last working day and the month's end — inclusive at both ends, because
 * the day you join and the day you leave are both days you are paid for.
 *
 * Weekly offs and holidays inside the window COUNT. Somebody who joins on a
 * Monday is paid for the Sunday that follows; not paying it would make a
 * joiner's first month depend on which weekday they happened to start.
 *
 * This is only the window. Loss of pay comes off it separately, as `lopDays`,
 * because the two have different sources — the window is a fact from the
 * employee record, LOP is a judgement from attendance and leave.
 *
 * Dates as YYYY-MM-DD strings, compared as strings. A calendar date has no time
 * zone, and turning it into a Date is how 1 April becomes 31 March.
 */
export function employmentDaysInMonth(input: {
  year: number
  month: number
  dateOfJoining: string | null
  lastWorkingDate: string | null
}): number {
  const window = employmentWindow(input)
  if (!window) return 0

  return Number(window.to.slice(8, 10)) - Number(window.from.slice(8, 10)) + 1
}

/** The first and last day of somebody's employment inside a month, inclusive. */
export interface EmploymentWindow {
  from: string
  to: string
}

/**
 * The same window as employmentDaysInMonth, as dates: from the later of joining
 * and the 1st, to the earlier of their last working day and the month's end.
 * Null when they were not employed at all that month.
 */
export function employmentWindow(input: {
  year: number
  month: number
  dateOfJoining: string | null
  lastWorkingDate: string | null
}): EmploymentWindow | null {
  const total = daysInMonth(input.year, input.month)
  const mm = String(input.month).padStart(2, '0')
  const monthStart = `${input.year}-${mm}-01`
  const monthEnd = `${input.year}-${mm}-${String(total).padStart(2, '0')}`

  const from =
    input.dateOfJoining && input.dateOfJoining > monthStart ? input.dateOfJoining : monthStart
  const to =
    input.lastWorkingDate && input.lastWorkingDate < monthEnd ? input.lastWorkingDate : monthEnd

  // Joined after the month ended, or left before it began.
  if (from > to) return null

  return { from, to }
}
