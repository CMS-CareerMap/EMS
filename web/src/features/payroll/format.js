/**
 * How payroll figures read on screen. Formatting only — every number arrives
 * from the server already worked out.
 */

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

/** 2026, 8 → "August 2026". */
export function monthLabel(year, month) {
  return `${MONTHS[month - 1] ?? month} ${year}`
}

export const MONTH_NAMES = MONTHS

/** Rupees with the Indian grouping, paise shown: ₹1,20,981.10. Null is a dash. */
export function money(value, currency = 'INR') {
  if (value === null || value === undefined) return '—'
  try {
    return new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: 2 }).format(Number(value))
  } catch {
    return `${currency} ${Number(value).toFixed(2)}`
  }
}

/** "2026-09-01" → "1 Sep 2026" — the app's one day formatter (lib/dates). */
export { formatDay } from '../../lib/dates'

/** 28 → "28", 28.5 → "28.5". */
export function days(n) {
  if (n === null || n === undefined) return '—'
  return Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1)
}

/** How a day's pay was worked out — the run's snapshot of the company setting. */
export const LOP_BASIS = {
  calendar_days: 'calendar days',
  fixed_30: 'a fixed 30-day month',
  working_days: 'working days',
}

export const RUN_STATUS = {
  draft: { label: 'Draft', cls: 'bg-gray-100 text-gray-700', dot: 'bg-gray-400' },
  approved: { label: 'Approved', cls: 'bg-blue-100 text-blue-700', dot: 'bg-blue-500' },
  paid: { label: 'Paid', cls: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
}

/** The financial year a month belongs to, by the year it starts in — April to March. */
export function financialYearOf(year, month) {
  return month >= 4 ? year : year - 1
}

export function financialYearLabel(fy) {
  return `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`
}

/** The last `count` months up to and including this one, newest first. */
export function recentMonths(today, count = 13) {
  let year = Number(today.slice(0, 4))
  let month = Number(today.slice(5, 7))
  const out = []
  for (let i = 0; i < count; i++) {
    out.push({ year, month })
    month -= 1
    if (month === 0) {
      month = 12
      year -= 1
    }
  }
  return out
}

/** The month after this one. */
export function monthAfter({ year, month }) {
  return month === 12 ? { year: year + 1, month: 1 } : { year, month: month + 1 }
}

/** { year: 2026, month: 9 } ⇄ "2026-09", for a <select>. */
export function monthValue({ year, month }) {
  return `${year}-${String(month).padStart(2, '0')}`
}

export function parseMonthValue(value) {
  return { year: Number(value.slice(0, 4)), month: Number(value.slice(5, 7)) }
}
