import type { PayslipTemplate } from './template'

/**
 * United States — an earnings statement in dollars, dates month first. Federal
 * and state withholding and FICA are not calculated by this system; what prints
 * is what payroll recorded.
 */
export const UNITED_STATES: PayslipTemplate = {
  country: 'US',
  locale: 'en-US',
  dateOrder: 'MDY',

  title: 'Earnings Statement',
  labels: {
    employeeName: 'Employee',
    employeeCode: 'Employee ID',
    designation: 'Title',
    department: 'Department',
    dateOfJoining: 'Hire date',
    payPeriod: 'Pay period',
    payDate: 'Pay date',
    daysInMonth: 'Days in period',
    paidDays: 'Days paid',
    lopDays: 'Unpaid days',
    earnings: 'Earnings',
    deductions: 'Deductions',
    rate: 'Rate',
    amount: 'Current',
    gross: 'Gross pay',
    totalDeductions: 'Total deductions',
    net: 'Net pay',
    employerContributions: 'Employer contributions',
    eps: 'Pension (employer)',
    epf: 'Provident fund (employer)',
    esi: 'Insurance (employer)',
    none: 'None this period',
  },

  identifiers: [],

  netInWords: false,
  employerContributions: false,

  stamps: {
    draft: 'DRAFT — FOR REVIEW, NOT A PAY STATEMENT',
    approved: 'APPROVED — NOT YET PAID',
  },
  footer: 'This statement was produced electronically.',
}
