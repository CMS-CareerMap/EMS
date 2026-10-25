import { describe, it, expect } from 'vitest'
import { renderPayslipPdf } from './payslipPdf'
import { payslipView } from '../../domain/payroll/payslipView'

/**
 * The renderer: a real PDF comes out, with the font that can print ₹ embedded
 * in it. What the payslip SAYS is tested in payslipView.test.ts; this proves
 * the page is made.
 */

const view = payslipView({
  country: 'IN',
  currency: 'INR',
  status: 'paid',
  employer: { name: 'Sample Company', address: 'Pune' },
  year: 2026,
  month: 8,
  payDate: '2026-09-01',
  employee: { name: 'Asha', code: 'EMP001', designation: null, department: null, dateOfJoining: null },
  identifiers: { uan: null, pfMemberId: null, esicNumber: null, pan: null },
  days: { daysInMonth: 31, paidDays: 31, lopDays: 0 },
  earnings: [{ label: 'Basic', rate: 20_000, amount: 20_000 }],
  deductions: [{ label: 'Provident Fund', amount: 1_800 }],
  totals: { gross: 20_000, deductions: 1_800, net: 18_200 },
  employerContributions: { eps: 1_250, epf: 550, esi: 0 },
})

const createdAt = new Date('2026-09-01T00:00:00Z')

describe('a payslip PDF', () => {
  it('is a complete PDF of one page', async () => {
    const pdf = await renderPayslipPdf(view, { createdAt })
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-')
    expect(pdf.subarray(-6).toString('latin1')).toContain('%%EOF')
    expect(pdf.toString('latin1').match(/\/Type \/Page\b/g)).toHaveLength(1)
  })

  it('embeds Noto Sans, so ₹ prints as ₹', async () => {
    const pdf = await renderPayslipPdf(view, { createdAt })
    expect(pdf.toString('latin1')).toContain('NotoSans')
  })

  it('carries the creation date it was given, not the clock’s', async () => {
    const pdf = await renderPayslipPdf(view, { createdAt })
    expect(pdf.toString('latin1')).toContain('D:20260901')
  })

  const pages = (pdf: Buffer) => pdf.toString('latin1').match(/\/Type \/Page\b/g)?.length
  const withLines = (earnings: { label: string; rate: number; amount: number }[], deductions: { label: string; amount: number }[]) =>
    payslipView({
      country: 'IN', currency: 'INR', status: 'paid', employer: { name: 'Sample Company', address: 'Pune' }, year: 2026, month: 8, payDate: '2026-09-01',
      employee: { name: 'Asha', code: 'EMP001', designation: null, department: null, dateOfJoining: null },
      identifiers: { uan: null, pfMemberId: null, esicNumber: null, pan: null },
      days: { daysInMonth: 31, paidDays: 31, lopDays: 0 },
      earnings, deductions,
      totals: { gross: 1, deductions: 1, net: 0 },
      employerContributions: { eps: 1_250, epf: 550, esi: 0 },
    })

  it('keeps a full payslip with long labels on one page — a long label wraps, its row grows', async () => {
    const long = ['Children Education Allowance', 'Leave Travel Allowance (reimbursed against bills)', 'Uniform and Washing Allowance', 'Basic', 'House Rent Allowance', 'Special Allowance', 'Conveyance', 'Incentive', 'Bonus', 'Overtime', 'Leave encashment', 'Arrears']
    const pdf = await renderPayslipPdf(withLines(
      long.map((label) => ({ label, rate: 1_000, amount: 1_000 })),
      ['Provident Fund', 'ESI', 'Professional Tax', 'Income Tax (TDS)', 'Loan recovery', 'Salary advance recovery', 'Canteen and transport recovery for the month'].map((label) => ({ label, amount: 100 })),
    ), { createdAt })
    expect(pages(pdf)).toBe(1)
  })

  it('makes a row taller for a label that wraps — the same lines, two lines each, need a second page', async () => {
    const short = Array.from({ length: 22 }, (_, i) => ({ label: `Allowance ${i + 1}`, rate: 100, amount: 100 }))
    const long = short.map((line) => ({ ...line, label: `${line.label}, paid against bills` }))
    const deductions = [{ label: 'Provident Fund', amount: 12 }]
    expect(pages(await renderPayslipPdf(withLines(short, deductions), { createdAt }))).toBe(1)
    expect(pages(await renderPayslipPdf(withLines(long, deductions), { createdAt }))).toBe(2)
  })

  it('puts more lines than a page holds on a second page, not many broken ones', async () => {
    const lines = Array.from({ length: 40 }, (_, i) => ({ label: `Allowance ${i + 1}`, rate: 100, amount: 100 }))
    const pdf = await renderPayslipPdf(withLines(lines, [{ label: 'Provident Fund', amount: 12 }]), { createdAt })
    expect(pages(pdf)).toBe(2)
  })
})
