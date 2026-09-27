/**
 * What a country's payslip looks like: its words, its dates, its money, and
 * which of the payslip's facts it prints.
 *
 * PRESENTATION ONLY. A template decides how a payslip reads, never what it
 * says — every figure is calculated before a template sees it, and the
 * statutory arithmetic is India's whichever template prints it. The UK and US
 * layouts do not compute PAYE, National Insurance or FICA (guide, Day 17).
 *
 * A fourth country is a fourth file in this folder, registered in index.ts.
 */

export type IdentifierKey = 'uan' | 'pfMemberId' | 'esicNumber' | 'pan'

export interface PayslipTemplate {
  /** ISO 3166 alpha-2, as Employee.country stores it. */
  country: string
  /** For number and currency formatting. */
  locale: string
  /** 31/08/2026 or 08/31/2026. */
  dateOrder: 'DMY' | 'MDY'

  title: string
  labels: {
    employeeName: string
    employeeCode: string
    designation: string
    department: string
    dateOfJoining: string
    payPeriod: string
    payDate: string
    daysInMonth: string
    paidDays: string
    lopDays: string
    earnings: string
    deductions: string
    rate: string
    amount: string
    gross: string
    totalDeductions: string
    net: string
    employerContributions: string
    eps: string
    epf: string
    esi: string
    none: string
  }

  /** The statutory identifiers this layout prints, in order. */
  identifiers: { key: IdentifierKey; label: string }[]

  /** Net pay written out in words — required on an Indian payslip. */
  netInWords: boolean
  /** The employer's PF and ESI, which an Indian payslip must show. */
  employerContributions: boolean

  /** What a payslip that is not yet paid says across its top. */
  stamps: { draft: string; approved: string }
  footer: string
}
