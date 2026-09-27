import { monthName, type CalendarDate } from '../shared/dates'

/**
 * The bank transfer file: one line per person to be paid, laid out the way the
 * company's bank wants it (guide, Day 18: "the client cannot pay anyone
 * without it").
 *
 * The layout is DATA — a template of columns — because every bank's portal
 * wants its own. What goes in each column is one of a fixed set of payment
 * facts, or a fixed text. Nothing here reads a database or a clock.
 */

/** What a column can hold, with the words Settings shows for it. */
export const BANK_FILE_FIELDS = {
  beneficiary_name: 'Account holder name',
  employee_name: 'Employee name',
  employee_code: 'Employee code',
  account_number: 'Account number',
  ifsc: 'IFSC',
  bank_name: 'Bank name',
  amount: 'Amount',
  narration: 'Narration',
  pay_date: 'Payment date',
  fixed: 'Fixed text',
} as const

export type BankFileField = keyof typeof BANK_FILE_FIELDS

export const BANK_FILE_DATE_FORMATS = ['DD/MM/YYYY', 'YYYY-MM-DD', 'DD-MM-YYYY', 'MM/DD/YYYY'] as const
export type BankFileDateFormat = (typeof BANK_FILE_DATE_FORMATS)[number]

export interface BankFileColumn {
  header: string
  field: BankFileField
  /** The text of a `fixed` column — NEFT, a debit account number. */
  text?: string | null | undefined
}

export interface BankFileTemplate {
  columns: BankFileColumn[]
  includeHeader: boolean
  dateFormat: BankFileDateFormat
  /** With {month}, {year} and {code} filled in per line. */
  narration: string
  onlyVerified: boolean
}

/** What a company gets until it describes its own bank's format. */
export const DEFAULT_BANK_FILE_TEMPLATE: BankFileTemplate = {
  columns: [
    { header: 'Beneficiary Name', field: 'beneficiary_name' },
    { header: 'Account Number', field: 'account_number' },
    { header: 'IFSC', field: 'ifsc' },
    { header: 'Amount', field: 'amount' },
    { header: 'Payment Mode', field: 'fixed', text: 'NEFT' },
    { header: 'Narration', field: 'narration' },
    { header: 'Employee Code', field: 'employee_code' },
  ],
  includeHeader: true,
  dateFormat: 'DD/MM/YYYY',
  narration: 'Salary {month} {year}',
  onlyVerified: true,
}

const MAX_COLUMNS = 25
const MAX_TEXT = 60
const PLACEHOLDER = /\{(\w+)\}/g
const KNOWN_PLACEHOLDERS = new Set(['month', 'year', 'code'])

/**
 * What is wrong with a template, in words for the person fixing it. Empty
 * means it can be saved.
 */
export function templateProblems(template: BankFileTemplate): string[] {
  const problems: string[] = []
  const { columns } = template

  if (columns.length === 0) problems.push('Add at least one column.')
  if (columns.length > MAX_COLUMNS) problems.push(`A bank file can have at most ${MAX_COLUMNS} columns.`)

  columns.forEach((column, i) => {
    const n = i + 1
    if (!(column.field in BANK_FILE_FIELDS)) problems.push(`Column ${n} holds something unknown.`)
    if (template.includeHeader && !column.header.trim()) problems.push(`Column ${n} needs a heading.`)
    if (column.header.length > MAX_TEXT) problems.push(`Column ${n}'s heading is longer than ${MAX_TEXT} characters.`)
    if (column.field === 'fixed' && !column.text?.trim()) problems.push(`Column ${n} is fixed text — enter the text.`)
    if ((column.text ?? '').length > MAX_TEXT) problems.push(`Column ${n}'s text is longer than ${MAX_TEXT} characters.`)
  })

  // Without these the file pays nobody, whatever else it says.
  for (const needed of ['account_number', 'amount'] as const) {
    if (!columns.some((column) => column.field === needed)) {
      problems.push(`The file needs an ${BANK_FILE_FIELDS[needed].toLowerCase()} column.`)
    }
  }

  if (!BANK_FILE_DATE_FORMATS.includes(template.dateFormat)) problems.push('Choose a date format from the list.')
  if (template.narration.length > MAX_TEXT) problems.push(`The narration is longer than ${MAX_TEXT} characters.`)
  for (const [, name] of template.narration.matchAll(PLACEHOLDER)) {
    if (!KNOWN_PLACEHOLDERS.has(name ?? '')) problems.push(`The narration uses {${name}}, which is not {month}, {year} or {code}.`)
  }

  return problems
}

/** One person to pay. */
export interface BankPayment {
  employeeName: string
  employeeCode: string
  beneficiaryName: string
  accountNumber: string
  ifsc: string
  bankName: string
  amount: number
}

/** 27400 → "27400.00": no grouping, no symbol — what bank portals parse. */
export function formatAmount(amount: number): string {
  return (Math.round(amount * 100) / 100).toFixed(2)
}

export function formatDate(day: CalendarDate, format: BankFileDateFormat): string {
  const [y, m, d] = day.split('-')
  switch (format) {
    case 'YYYY-MM-DD':
      return `${y}-${m}-${d}`
    case 'DD-MM-YYYY':
      return `${d}-${m}-${y}`
    case 'MM/DD/YYYY':
      return `${m}/${d}/${y}`
    case 'DD/MM/YYYY':
      return `${d}/${m}/${y}`
  }
}

export function narrationFor(template: string, context: { year: number; month: number; code: string }): string {
  const [name] = monthName(context.year, context.month).split(' ')
  return template.replace(PLACEHOLDER, (whole, key: string) =>
    key === 'month' ? (name ?? whole) : key === 'year' ? String(context.year) : key === 'code' ? context.code : whole,
  )
}

/** The file as rows of cells, header first when the template has one. */
export function bankFileRows(
  template: BankFileTemplate,
  payments: readonly BankPayment[],
  context: { year: number; month: number; payDate: CalendarDate },
): string[][] {
  const cell = (column: BankFileColumn, p: BankPayment): string => {
    switch (column.field) {
      case 'beneficiary_name':
        return p.beneficiaryName
      case 'employee_name':
        return p.employeeName
      case 'employee_code':
        return p.employeeCode
      case 'account_number':
        return p.accountNumber
      case 'ifsc':
        return p.ifsc
      case 'bank_name':
        return p.bankName
      case 'amount':
        return formatAmount(p.amount)
      case 'narration':
        return narrationFor(template.narration, { year: context.year, month: context.month, code: p.employeeCode })
      case 'pay_date':
        return formatDate(context.payDate, template.dateFormat)
      case 'fixed':
        return column.text ?? ''
    }
  }

  const rows = payments.map((p) => template.columns.map((column) => cell(column, p)))
  return template.includeHeader ? [template.columns.map((column) => column.header), ...rows] : rows
}

/**
 * Who is left out of the file, and why — said to Accounts before the file is
 * used, so nobody finds out on pay day.
 */
export type BankExclusion = 'no_bank_account' | 'rejected' | 'not_verified' | 'nothing_to_pay'

export function exclusionOf(input: {
  netPayable: number
  account: { verificationStatus: string } | null
  onlyVerified: boolean
}): BankExclusion | null {
  if (input.netPayable <= 0) return 'nothing_to_pay'
  if (!input.account) return 'no_bank_account'
  // Checked and found wrong is never paid, whatever the company allows for
  // accounts nobody has checked yet.
  if (input.account.verificationStatus === 'rejected') return 'rejected'
  if (input.onlyVerified && input.account.verificationStatus !== 'verified') return 'not_verified'
  return null
}
