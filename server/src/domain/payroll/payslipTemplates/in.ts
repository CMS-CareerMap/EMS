import type { PayslipTemplate } from './template'

/**
 * India. What the guide says an Indian payslip must show: employer name and
 * address, employee name and code, designation, UAN, PF member id, ESIC number,
 * PAN, pay period, paid days and LOP days, each earning and deduction, gross,
 * total deductions, net in figures and in words, and the employer's PF and ESI.
 */
export const INDIA: PayslipTemplate = {
  country: 'IN',
  locale: 'en-IN',
  dateOrder: 'DMY',

  title: 'Payslip',
  labels: {
    employeeName: 'Employee name',
    employeeCode: 'Employee code',
    designation: 'Designation',
    department: 'Department',
    dateOfJoining: 'Date of joining',
    payPeriod: 'Pay period',
    payDate: 'Pay date',
    daysInMonth: 'Days in month',
    paidDays: 'Paid days',
    lopDays: 'Loss of pay days',
    earnings: 'Earnings',
    deductions: 'Deductions',
    rate: 'Rate',
    amount: 'Amount',
    gross: 'Gross earnings',
    totalDeductions: 'Total deductions',
    net: 'Net pay',
    employerContributions: 'Employer contributions (not deducted from your pay)',
    eps: 'Provident Fund — pension (EPS)',
    epf: 'Provident Fund — EPF',
    esi: 'ESI',
    none: 'None this month',
  },

  identifiers: [
    { key: 'uan', label: 'UAN' },
    { key: 'pfMemberId', label: 'PF member ID' },
    { key: 'esicNumber', label: 'ESIC number' },
    { key: 'pan', label: 'PAN' },
  ],

  netInWords: true,
  employerContributions: true,

  stamps: {
    draft: 'DRAFT — FOR REVIEW, NOT A PAYSLIP',
    approved: 'APPROVED — NOT YET PAID',
  },
  footer: 'This is a computer-generated payslip and does not need a signature.',
}
