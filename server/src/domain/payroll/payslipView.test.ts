import { describe, it, expect } from 'vitest'
import { payslipView, addressOf, type PayslipViewInput } from './payslipView'
import { templateFor } from './payslipTemplates'
import { payslipDifferences } from './run'

/**
 * What a payslip says, before any PDF is drawn.
 *
 * The first block is the guide's list for an Indian payslip, item by item:
 * employer name and address, employee name and code, designation, UAN, PF
 * member id, ESIC number, PAN, pay period, paid days and LOP days, each
 * earning and deduction, gross, total deductions, net in figures and words,
 * and the employer's PF and ESI contributions.
 */

const INPUT: PayslipViewInput = {
  country: 'IN',
  currency: 'INR',
  status: 'paid',
  employer: { name: 'Sample Company Private Limited', address: 'MG Road, Pune, Maharashtra 411001' },
  year: 2026,
  month: 8,
  payDate: '2026-09-01',
  employee: { name: 'Asha Kulkarni', code: 'EMP/001', designation: 'Engineer', department: 'Engineering', dateOfJoining: '2024-06-17' },
  identifiers: { uan: '100123456789', pfMemberId: 'MHBAN0012345000', esicNumber: null, pan: 'ABCDE1234F' },
  days: { daysInMonth: 31, paidDays: 28.5, lopDays: 2.5 },
  earnings: [
    { label: 'Basic', rate: 20_000, amount: 18_387.1 },
    { label: 'Incentive', rate: null, amount: 5_000 },
  ],
  deductions: [
    { label: 'Provident Fund', amount: 2_206 },
    { label: 'Professional Tax', amount: 200 },
  ],
  totals: { gross: 1_23_387.1, deductions: 2_406, net: 1_20_981.1 },
  employerContributions: { eps: 1_250, epf: 956, esi: 0 },
}

const value = (view: ReturnType<typeof payslipView>, label: string) =>
  [...view.details.left, ...view.details.right].find((d) => d.label === label)?.value

describe('an Indian payslip', () => {
  const view = payslipView(INPUT)

  it('names the employer, with the address', () => {
    expect(view.employer).toEqual(INPUT.employer)
    expect(view.heading).toBe('Payslip for August 2026')
  })

  it('names the employee, their code and designation', () => {
    expect(value(view, 'Employee name')).toBe('Asha Kulkarni')
    expect(value(view, 'Employee code')).toBe('EMP/001')
    expect(value(view, 'Designation')).toBe('Engineer')
    expect(value(view, 'Date of joining')).toBe('17/06/2024')
  })

  it('carries UAN, PF member ID, ESIC number and PAN — a dash where none is on record, never a guess', () => {
    expect(value(view, 'UAN')).toBe('100123456789')
    expect(value(view, 'PF member ID')).toBe('MHBAN0012345000')
    expect(value(view, 'ESIC number')).toBe('—')
    expect(value(view, 'PAN')).toBe('ABCDE1234F')
  })

  it('states the pay period and the pay date, day first', () => {
    expect(value(view, 'Pay period')).toBe('01/08/2026 – 31/08/2026')
    expect(value(view, 'Pay date')).toBe('01/09/2026')
  })

  it('states paid days and loss-of-pay days, half days included', () => {
    expect(view.days).toEqual([
      { label: 'Days in month', value: '31' },
      { label: 'Paid days', value: '28.5' },
      { label: 'Loss of pay days', value: '2.5' },
    ])
  })

  it('lists every earning with its rate, and every deduction, in rupees grouped the Indian way', () => {
    expect(view.earnings).toEqual([
      { label: 'Basic', rate: '₹20,000.00', amount: '₹18,387.10' },
      { label: 'Incentive', rate: null, amount: '₹5,000.00' },
    ])
    expect(view.deductions).toEqual([
      { label: 'Provident Fund', amount: '₹2,206.00' },
      { label: 'Professional Tax', amount: '₹200.00' },
    ])
    expect(view.totals).toEqual([
      { label: 'Gross earnings', value: '₹1,23,387.10' },
      { label: 'Total deductions', value: '₹2,406.00' },
    ])
  })

  it('gives the net pay in figures and in words', () => {
    expect(view.net).toEqual({
      label: 'Net pay',
      value: '₹1,20,981.10',
      words: 'Rupees One Lakh Twenty Thousand Nine Hundred Eighty One and Paise Ten Only',
    })
  })

  it('shows what the employer paid on top, leaving out what was nothing', () => {
    expect(view.employerContributions).toEqual({
      title: 'Employer contributions (not deducted from your pay)',
      rows: [
        { label: 'Provident Fund — pension (EPS)', amount: '₹1,250.00' },
        { label: 'Provident Fund — EPF', amount: '₹956.00' },
      ],
      none: 'None this month',
    })
  })

  it('is not stamped once paid; a draft and an approval say they are not payslips yet', () => {
    expect(view.stamp).toBeNull()
    expect(payslipView({ ...INPUT, status: 'draft' }).stamp).toBe('DRAFT — FOR REVIEW, NOT A PAYSLIP')
    expect(payslipView({ ...INPUT, status: 'approved' }).stamp).toBe('APPROVED — NOT YET PAID')
  })

  it('names the file safely', () => {
    expect(view.filename).toBe('payslip-2026-08-EMP001.pdf')
  })
})

describe('the other layouts', () => {
  it('prints a UK payslip in pounds, day first, with no Indian identifiers and no words', () => {
    const view = payslipView({ ...INPUT, country: 'GB', currency: 'GBP' })
    expect(view.title).toBe('Payslip')
    expect(view.totals[0]).toEqual({ label: 'Total payments', value: '£123,387.10' })
    expect(value(view, 'Pay period')).toBe('01/08/2026 – 31/08/2026')
    expect(value(view, 'UAN')).toBeUndefined()
    expect(view.net.words).toBeNull()
    expect(view.employerContributions).toBeNull()
  })

  it('prints a US earnings statement in dollars, month first', () => {
    const view = payslipView({ ...INPUT, country: 'US', currency: 'USD' })
    expect(view.heading).toBe('Earnings Statement for August 2026')
    expect(view.net.value).toBe('$120,981.10')
    expect(value(view, 'Pay period')).toBe('08/01/2026 – 08/31/2026')
    expect(value(view, 'Hire date')).toBe('06/17/2024')
  })

  it('finds the UK layout under GB or UK, and India’s for anything it does not know', () => {
    expect(templateFor('UK').country).toBe('GB')
    expect(templateFor('gb').country).toBe('GB')
    expect(templateFor('FR').country).toBe('IN')
    expect(templateFor(null).country).toBe('IN')
  })

  it('prints a currency it cannot format as its code, rather than a wrong symbol', () => {
    expect(payslipView({ ...INPUT, currency: 'XX1' }).net.value).toBe('XX1 120981.10')
  })

  it('writes no words for an amount that is not in rupees', () => {
    expect(payslipView({ ...INPUT, currency: 'USD' }).net.words).toBeNull()
  })
})

describe('the employer address', () => {
  it('joins what is there and skips what is not', () => {
    expect(addressOf({ addressLine: '1st Floor, MG Road', city: 'Pune', state: 'Maharashtra', pincode: '411001' })).toBe(
      '1st Floor, MG Road, Pune, Maharashtra 411001',
    )
    expect(addressOf({ addressLine: null, city: 'Pune', state: null, pincode: null })).toBe('Pune')
    expect(addressOf({ addressLine: null, city: null, state: null, pincode: null })).toBeNull()
  })
})

describe('what approval checks: would the payslips come out the same?', () => {
  const slip = (id: string, net: number, lineAmount = 20_000) => ({
    employeeId: id,
    employeeName: `Person ${id}`,
    figures: { netPayable: net, grossEarnings: 20_000 },
    lines: [{ kind: 'earning', code: 'BASIC', amount: lineAmount }],
  })

  it('finds nothing when nothing moved', () => {
    expect(payslipDifferences([slip('a', 18_000)], [slip('a', 18_000)])).toEqual([])
  })

  it('names the figure that moved', () => {
    expect(payslipDifferences([slip('a', 18_000)], [slip('a', 17_500)])).toEqual([
      { employeeId: 'a', employeeName: 'Person a', change: 'changed', fields: ['netPayable'] },
    ])
  })

  it('names the line that moved', () => {
    expect(payslipDifferences([slip('a', 18_000)], [slip('a', 18_000, 19_354.84)])[0]?.fields).toEqual(['BASIC'])
  })

  it('notices somebody new, and somebody gone', () => {
    const d = payslipDifferences([slip('a', 1), slip('b', 1)], [slip('a', 1), slip('c', 1)])
    expect(d.map((x) => [x.employeeId, x.change])).toEqual([
      ['c', 'added'],
      ['b', 'removed'],
    ])
  })

  it('does not mistake floating point for a change', () => {
    expect(payslipDifferences([slip('a', 0.3)], [slip('a', 0.1 + 0.2)])).toEqual([])
  })
})
