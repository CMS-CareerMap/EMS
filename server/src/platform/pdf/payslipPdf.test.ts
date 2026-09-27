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
})
