/**
 * Indian statutory deductions: PF, ESI and professional tax.
 *
 * Pure arithmetic over values it is given. No database, no dates from a clock,
 * no rates from a constant — every rule that a company can configure arrives as
 * an argument, and every rule that the law fixes is written here with the
 * reason beside it.
 *
 * This is the file where being wrong costs somebody money, so each rounding
 * decision is stated rather than assumed. They are not all the same: PF rounds
 * to the nearest rupee and ESI rounds UP, which is not a style choice.
 */

/** Rupees, to the nearest paisa. */
function paise(value: number): number {
  return Math.round(value * 100) / 100
}

/** EPFO rounds contributions to the nearest rupee. */
function toNearestRupee(value: number): number {
  return Math.round(value)
}

/** ESIC rounds each contribution UP to the next rupee, independently. */
function upToRupee(value: number): number {
  return Math.ceil(value)
}

// ── Provident Fund ──────────────────────────────────────────────────────────

/**
 * The statutory wage ceiling for PF and EPS.
 *
 * A number the law fixes, not a company setting — which is why it is here and
 * the RATE is not. A company may choose to contribute on full wages; it may not
 * choose what the ceiling is.
 */
export const PF_WAGE_CEILING = 15_000

/** 8.33% of the ceiling. The maximum that can ever go to the pension scheme. */
export const EPS_MONTHLY_CAP = 1_250

/** The date from which a new high-wage joiner is excluded from EPS. */
export const EPS_EXCLUSION_DATE = '2014-09-01'

export interface PfInput {
  /**
   * PF wages: basic + DA + retaining allowance.
   *
   * Per the 2019 Supreme Court ruling, an allowance that is ordinarily and
   * universally paid to everybody forms part of PF wages — so a "special
   * allowance" paid to all staff is not automatically excluded. Which
   * components count is a decision for the company's accountant, and it
   * arrives here already decided.
   */
  pfWages: number
  /** From OrganizationPolicy. Editable, because the client asked for that. */
  employeeRate: number
  employerRate: number
  /** Whether to cap the base at the statutory ceiling. */
  restrictToCeiling: boolean
  /** The ceiling in force. Passed in so a future revision is a settings change. */
  wageCeiling?: number
  /**
   * Whether this employee is a member of the pension scheme.
   *
   * Use `isEpsMember()` to decide rather than assuming true — the answer
   * changes the split between EPF and EPS, not the total.
   */
  epsMember: boolean
}

export interface PfResult {
  /** The base the percentages were applied to, after any ceiling. */
  pfWages: number
  employee: number
  /** Employer's total, before the split. */
  employerTotal: number
  /** The pension share. Zero for a non-member. */
  employerEps: number
  /** The provident-fund share. The remainder. */
  employerEpf: number
}

/**
 * Is this person a member of the Employees' Pension Scheme?
 *
 * Somebody who FIRST joined the provident fund on or after 1 September 2014
 * earning above the ceiling is excluded from EPS — their employer's entire
 * contribution goes to EPF instead. It changes the split, never the total, so
 * getting it wrong is invisible in the payslip's bottom line and wrong in every
 * statutory return.
 *
 * `hasPriorMembership` is a question only the employee can answer, from their
 * previous employment. Defaulting it to false is the safe reading: it excludes
 * a high earner from EPS, which is the outcome the rule intends for a genuine
 * new entrant.
 */
export function isEpsMember(input: {
  dateOfJoining: string | null
  pfWagesAtJoining: number
  hasPriorMembership: boolean
}): boolean {
  if (input.hasPriorMembership) return true
  if (!input.dateOfJoining) return true
  if (input.dateOfJoining < EPS_EXCLUSION_DATE) return true

  // Joined after the cut-off, above the ceiling, never a member before.
  return input.pfWagesAtJoining <= PF_WAGE_CEILING
}

export function computePf(input: PfInput): PfResult {
  const ceiling = input.wageCeiling ?? PF_WAGE_CEILING
  const base = input.restrictToCeiling ? Math.min(input.pfWages, ceiling) : input.pfWages

  const employee = toNearestRupee((base * input.employeeRate) / 100)
  const employerTotal = toNearestRupee((base * input.employerRate) / 100)

  if (!input.epsMember) {
    // The whole employer share goes to EPF. Not an edge case to skip: it is
    // the correct treatment for every high-wage joiner since 2014.
    return { pfWages: base, employee, employerTotal, employerEps: 0, employerEpf: employerTotal }
  }

  // EPS is always 8.33% of wages capped at the CEILING, even when the company
  // contributes on more than that. The cap is on the pension scheme, not on
  // what the employer chooses to pay.
  const epsBase = Math.min(base, ceiling)
  const employerEps = Math.min(toNearestRupee((epsBase * 8.33) / 100), EPS_MONTHLY_CAP)

  return {
    pfWages: base,
    employee,
    employerTotal,
    employerEps,
    // The remainder, so the two halves always add to the total. Computing EPF
    // independently would let rounding put them a rupee apart.
    employerEpf: employerTotal - employerEps,
  }
}

// ── Employees' State Insurance ──────────────────────────────────────────────

/**
 * ESI contribution periods.
 *
 * ELIGIBILITY IS LOCKED PER PERIOD, NOT PER MONTH, and this is the rule the
 * current code gets wrong (`Payroll.jsx:23` re-tests every month). Somebody
 * covered on 1 April stays covered until 30 September even if they get a raise
 * in June — and somebody above the threshold in April stays out until October
 * even if their wages fall.
 *
 * Re-testing monthly produces an employee who drifts in and out of ESI, which
 * is both wrong and impossible to explain to them.
 */
export const ESI_PERIODS = [
  { startMonth: 4, endMonth: 9, label: 'Apr–Sep' },
  { startMonth: 10, endMonth: 3, label: 'Oct–Mar' },
] as const

export interface EsiPeriod {
  /** YYYY-MM-DD. */
  start: string
  end: string
  label: string
}

/** Which contribution period a calendar month falls in. */
export function esiPeriodFor(year: number, month: number): EsiPeriod {
  if (month >= 4 && month <= 9) {
    return { start: `${year}-04-01`, end: `${year}-09-30`, label: 'Apr–Sep' }
  }

  // October to March spans a year boundary: January belongs to the period that
  // began the previous October.
  const startYear = month >= 10 ? year : year - 1
  return { start: `${startYear}-10-01`, end: `${startYear + 1}-03-31`, label: 'Oct–Mar' }
}

export interface EsiEligibilityInput {
  /**
   * The WAGE RATE, not the amount actually paid.
   *
   * Somebody on ₹20,000 who took unpaid leave and was paid ₹12,000 is tested
   * on ₹20,000. Testing the paid amount would pull people into ESI in the
   * months they were ill, which is precisely backwards.
   */
  wageRate: number
  threshold: number
}

export function isEsiEligible(input: EsiEligibilityInput): boolean {
  return input.wageRate <= input.threshold
}

export interface EsiInput {
  /** The gross actually payable this month — contributions are on what is paid. */
  grossPaid: number
  employeeRate: number
  employerRate: number
  /** From the locked coverage record for the period, NOT re-tested here. */
  covered: boolean
}

export interface EsiResult {
  employee: number
  employer: number
}

export function computeEsi(input: EsiInput): EsiResult {
  if (!input.covered) return { employee: 0, employer: 0 }

  // Each rounded UP to the next rupee, and INDEPENDENTLY. Rounding the total
  // and splitting it would produce figures that do not match the ESIC return.
  return {
    employee: upToRupee((input.grossPaid * input.employeeRate) / 100),
    employer: upToRupee((input.grossPaid * input.employerRate) / 100),
  }
}

// ── Professional Tax ────────────────────────────────────────────────────────

/**
 * The annual ceiling on professional tax.
 *
 * Article 276 of the Constitution caps it at ₹2,500 a year per person, in every
 * state. Any slab table that can produce more than this is wrong, which is why
 * there is an invariant test for it.
 */
export const PT_ANNUAL_CAP = 2_500

export type Gender = 'male' | 'female' | 'any'

export interface PtSlabRule {
  state: string
  /** 'any' applies to everybody; a gendered rule wins over it. */
  gender: Gender
  wageFrom: number
  /** Null means "and above". */
  wageTo: number | null
  amount: number
  /**
   * Some states charge a different amount in one month to reach the annual
   * total without a fractional monthly figure. Maharashtra charges ₹300 in
   * February instead of ₹200: 11 × 200 + 300 = 2,500 exactly.
   */
  februaryAmount?: number | null
}

export interface PtInput {
  state: string | null
  gender: Gender
  /** Monthly gross, which is what the slabs are written against. */
  gross: number
  /** 1–12. February is 2, and some states differ that month. */
  month: number
  slabs: readonly PtSlabRule[]
}

export function computePt(input: PtInput): number {
  if (!input.state) return 0

  const forState = input.slabs.filter(
    (slab) => slab.state.toLowerCase() === input.state!.toLowerCase(),
  )

  // No slabs for that state is NOT zero tax by decree — it is a state nobody
  // has configured. Returning zero is the only thing this function can do, and
  // the caller is expected to notice the state has no rules.
  if (forState.length === 0) return 0

  const matching = forState.filter(
    (slab) =>
      input.gross >= slab.wageFrom && (slab.wageTo === null || input.gross <= slab.wageTo),
  )

  if (matching.length === 0) return 0

  // A gendered rule beats a general one. Maharashtra exempts women up to
  // ₹25,000, and applying the men's slab to them over-deducts every month.
  const slab = matching.find((s) => s.gender === input.gender) ?? matching.find((s) => s.gender === 'any')
  if (!slab) return 0

  const amount =
    input.month === 2 && slab.februaryAmount != null ? slab.februaryAmount : slab.amount

  return paise(amount)
}

/**
 * What a full year of these slabs would cost.
 *
 * Exported so the invariant can be tested directly: no state may take more
 * than ₹2,500 from one person in a year, and a slab table that does is a data
 * entry error rather than a novel tax.
 */
export function annualPt(input: Omit<PtInput, 'month'>): number {
  let total = 0
  for (let month = 1; month <= 12; month++) {
    total += computePt({ ...input, month })
  }
  return paise(total)
}

// ── Keeping a PT table ──────────────────────────────────────────────────────

/**
 * One slab as a person enters it: where it STARTS, and what it charges.
 *
 * No upper bound. The bound is where the next slab starts, and asking people
 * for both is how a table gets a gap — 7,500 then 7,501 leaves 7,500.50 in no
 * slab at all, and a prorated salary landing there pays no tax for no reason.
 */
export interface PtSlabDraft {
  gender: Gender
  from: number
  amount: number
  februaryAmount?: number | null
}

/**
 * What is wrong with a state's table, in words a person can act on. Empty
 * means it may be saved.
 *
 * Checked on the way IN, so a table that could take more than the
 * constitutional ₹2,500 a year never reaches a payslip — the annual-cap test
 * on the engine guards the arithmetic; this guards the data.
 */
export function ptTableProblems(slabs: readonly PtSlabDraft[]): string[] {
  const problems: string[] = []
  if (slabs.length === 0) return ['Add at least one slab. A state with no PT is one slab from ₹0 charging ₹0.']

  const genders = new Set(slabs.map((s) => s.gender))
  if ((genders.has('male') || genders.has('female')) && !(genders.has('male') && genders.has('female'))) {
    // One gendered set alone leaves the other gender matching nothing, which
    // charges them nothing — silently.
    problems.push('Slabs for men and for women go together. Add the other set, or make the slabs apply to everyone.')
  }

  for (const gender of genders) {
    const label = gender === 'any' ? 'everyone' : gender === 'male' ? 'men' : 'women'
    const group = slabs.filter((s) => s.gender === gender).map((s) => s.from).sort((a, b) => a - b)

    if (group[0] !== 0) problems.push(`The first slab for ${label} must start at ₹0, or low salaries match no slab.`)
    for (let i = 1; i < group.length; i++) {
      if (group[i] === group[i - 1]) problems.push(`Two slabs for ${label} start at the same amount (₹${group[i]}).`)
    }
  }

  for (const slab of slabs) {
    if (slab.amount < 0 || (slab.februaryAmount ?? 0) < 0) {
      problems.push('A PT amount cannot be negative.')
      continue
    }
    const year = slab.amount * 11 + (slab.februaryAmount ?? slab.amount)
    if (year > PT_ANNUAL_CAP) {
      problems.push(
        `The slab from ₹${slab.from} would take ₹${year} a year. Professional tax is capped at ₹${PT_ANNUAL_CAP} a year (Article 276).`,
      )
    }
  }

  return [...new Set(problems)]
}

/**
 * The stored shape of a table: each slab's upper bound is one paisa below
 * where the next one starts, and the top slab is open-ended. Gaps and overlaps
 * are impossible by construction.
 */
export function ptTableRows(slabs: readonly PtSlabDraft[]) {
  const rows: { gender: Gender; wageFrom: number; wageTo: number | null; amount: number; februaryAmount: number | null }[] = []

  for (const gender of new Set(slabs.map((s) => s.gender))) {
    const group = slabs.filter((s) => s.gender === gender).sort((a, b) => a.from - b.from)
    group.forEach((slab, i) => {
      const next = group[i + 1]
      rows.push({
        gender,
        wageFrom: slab.from,
        wageTo: next ? paise(next.from - 0.01) : null,
        amount: slab.amount,
        februaryAmount: slab.februaryAmount ?? null,
      })
    })
  }

  return rows
}
