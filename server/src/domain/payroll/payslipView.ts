import { monthName, type CalendarDate } from '../shared/dates'
import { rupeesInWords } from '../shared/words'
import { templateFor, type PayslipTemplate } from './payslipTemplates'

/**
 * A payslip as it will be printed: every value already a string, in the right
 * words, date order and currency for the employee's country.
 *
 * The PDF renderer only places these on a page; it formats nothing and decides
 * nothing. So what a payslip SAYS is tested here, without a PDF in sight, and
 * the renderer can be swapped without touching a single rule.
 */

export interface PayslipViewInput {
  country: string
  currency: string
  /** Anything but paid prints a stamp saying it is not a payslip yet. */
  status: 'draft' | 'approved' | 'paid'
  employer: { name: string; address: string | null }
  year: number
  month: number
  payDate: CalendarDate | null
  employee: {
    name: string
    code: string
    designation: string | null
    department: string | null
    dateOfJoining: CalendarDate | null
  }
  identifiers: { uan: string | null; pfMemberId: string | null; esicNumber: string | null; pan: string | null }
  days: { daysInMonth: number; paidDays: number; lopDays: number }
  earnings: { label: string; rate: number | null; amount: number }[]
  deductions: { label: string; amount: number }[]
  totals: { gross: number; deductions: number; net: number }
  employerContributions: { eps: number; epf: number; esi: number }
}

export interface PayslipView {
  title: string
  stamp: string | null
  employer: { name: string; address: string | null }
  heading: string
  /** Who they are on the left; their statutory numbers and the period on the right. */
  details: { left: { label: string; value: string }[]; right: { label: string; value: string }[] }
  days: { label: string; value: string }[]
  labels: { earnings: string; deductions: string; rate: string; amount: string }
  earnings: { label: string; rate: string | null; amount: string }[]
  deductions: { label: string; amount: string }[]
  totals: { label: string; value: string }[]
  net: { label: string; value: string; words: string | null }
  employerContributions: { title: string; rows: { label: string; amount: string }[]; none: string } | null
  footer: string
  /** What the downloaded file is called. Letters, digits, dash and underscore. */
  filename: string
}

/** Printed where a fact is not on record. Never a placeholder value. */
const NOT_ON_RECORD = '—'

function money(template: PayslipTemplate, currency: string): (n: number) => string {
  let format: Intl.NumberFormat | null = null
  try {
    format = new Intl.NumberFormat(template.locale, {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  } catch {
    // A currency code Intl does not know: print the code rather than guess a symbol.
    format = null
  }
  return (n: number) => (format ? format.format(n) : `${currency} ${n.toFixed(2)}`)
}

function dateIn(template: PayslipTemplate): (day: CalendarDate | null) => string {
  return (day) => {
    if (!day) return NOT_ON_RECORD
    const [y, m, d] = day.split('-')
    return template.dateOrder === 'MDY' ? `${m}/${d}/${y}` : `${d}/${m}/${y}`
  }
}

/** 28 → "28", 28.5 → "28.5". Half days are real and are shown as such. */
function days(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function payslipView(input: PayslipViewInput, template: PayslipTemplate = templateFor(input.country)): PayslipView {
  const fmt = money(template, input.currency)
  const date = dateIn(template)
  const l = template.labels

  const mm = String(input.month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(input.year, input.month, 0)).getUTCDate()
  const first = `${input.year}-${mm}-01`
  const last = `${input.year}-${mm}-${String(lastDay).padStart(2, '0')}`

  const details: PayslipView['details'] = {
    left: [
      { label: l.employeeName, value: input.employee.name },
      { label: l.employeeCode, value: input.employee.code },
      { label: l.designation, value: input.employee.designation ?? NOT_ON_RECORD },
      { label: l.department, value: input.employee.department ?? NOT_ON_RECORD },
      { label: l.dateOfJoining, value: date(input.employee.dateOfJoining) },
    ],
    right: [
      ...template.identifiers.map((id) => ({ label: id.label, value: input.identifiers[id.key] ?? NOT_ON_RECORD })),
      { label: l.payPeriod, value: `${date(first)} – ${date(last)}` },
      { label: l.payDate, value: date(input.payDate) },
    ],
  }

  const employer = template.employerContributions
    ? {
        title: l.employerContributions,
        rows: [
          { label: l.eps, amount: input.employerContributions.eps },
          { label: l.epf, amount: input.employerContributions.epf },
          { label: l.esi, amount: input.employerContributions.esi },
        ]
          .filter((row) => row.amount > 0)
          .map((row) => ({ label: row.label, amount: fmt(row.amount) })),
        none: l.none,
      }
    : null

  const safe = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, '')

  return {
    title: template.title,
    stamp: input.status === 'paid' ? null : input.status === 'approved' ? template.stamps.approved : template.stamps.draft,
    employer: input.employer,
    heading: `${template.title} for ${monthName(input.year, input.month)}`,
    details,
    days: [
      { label: l.daysInMonth, value: days(input.days.daysInMonth) },
      { label: l.paidDays, value: days(input.days.paidDays) },
      { label: l.lopDays, value: days(input.days.lopDays) },
    ],
    labels: { earnings: l.earnings, deductions: l.deductions, rate: l.rate, amount: l.amount },
    earnings: input.earnings.map((row) => ({
      label: row.label,
      rate: row.rate === null ? null : fmt(row.rate),
      amount: fmt(row.amount),
    })),
    deductions: input.deductions.map((row) => ({ label: row.label, amount: fmt(row.amount) })),
    totals: [
      { label: l.gross, value: fmt(input.totals.gross) },
      { label: l.totalDeductions, value: fmt(input.totals.deductions) },
    ],
    net: {
      label: l.net,
      value: fmt(input.totals.net),
      // Words are rupees and paise, so only for rupees.
      words: template.netInWords && input.currency === 'INR' ? rupeesInWords(input.totals.net) : null,
    },
    employerContributions: employer,
    footer: template.footer,
    filename: `payslip-${input.year}-${mm}-${safe(input.employee.code) || 'employee'}.pdf`,
  }
}

/** An address for a payslip header, from the company's own fields. */
export function addressOf(parts: {
  addressLine: string | null
  city: string | null
  state: string | null
  pincode: string | null
}): string | null {
  const stateAndPin = [parts.state, parts.pincode].filter(Boolean).join(' ')
  const joined = [parts.addressLine, parts.city, stateAndPin].filter(Boolean).join(', ')
  return joined || null
}
