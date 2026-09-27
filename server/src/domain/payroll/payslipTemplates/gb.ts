import type { PayslipTemplate } from './template'

/**
 * United Kingdom — the layout and the pound, nothing more. PAYE and National
 * Insurance are not calculated by this system; what prints is what payroll
 * recorded.
 */
export const UNITED_KINGDOM: PayslipTemplate = {
  country: 'GB',
  locale: 'en-GB',
  dateOrder: 'DMY',

  title: 'Payslip',
  labels: {
    employeeName: 'Employee',
    employeeCode: 'Payroll number',
    designation: 'Job title',
    department: 'Department',
    dateOfJoining: 'Start date',
    payPeriod: 'Pay period',
    payDate: 'Pay date',
    daysInMonth: 'Days in period',
    paidDays: 'Days paid',
    lopDays: 'Unpaid days',
    earnings: 'Payments',
    deductions: 'Deductions',
    rate: 'Rate',
    amount: 'Amount',
    gross: 'Total payments',
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
    draft: 'DRAFT — FOR REVIEW, NOT A PAYSLIP',
    approved: 'APPROVED — NOT YET PAID',
  },
  footer: 'This payslip was produced electronically.',
}
