import { writeFileSync } from 'node:fs'
import { payslipView, type PayslipViewInput } from '../src/domain/payroll/payslipView'
import { renderPayslipPdf } from '../src/platform/pdf/payslipPdf'

/**
 * Renders sample payslips to look at, one per template.
 *
 *   npx tsx scripts/samplePayslip.ts <outDir>
 *
 * Made-up figures and no database. For checking the layout by eye after a
 * change to the renderer or a template.
 */

const outDir = process.argv[2] ?? '.'

const base: PayslipViewInput = {
  country: 'IN',
  currency: 'INR',
  status: 'paid',
  employer: { name: 'Sample Company Private Limited', address: '1st Floor, Example House, MG Road, Pune, Maharashtra 411001' },
  year: 2026,
  month: 8,
  payDate: '2026-09-01',
  employee: { name: 'Asha Kulkarni', code: 'EMP001', designation: 'Software Engineer', department: 'Engineering', dateOfJoining: '2024-06-17' },
  identifiers: { uan: '100123456789', pfMemberId: 'MHBAN00123450000012345', esicNumber: null, pan: 'ABCDE1234F' },
  days: { daysInMonth: 31, paidDays: 28, lopDays: 3 },
  earnings: [
    { label: 'Basic', rate: 20000, amount: 18064.52 },
    { label: 'Dearness Allowance', rate: 2000, amount: 1806.45 },
    { label: 'House Rent Allowance', rate: 10000, amount: 9032.26 },
    { label: 'Incentive', rate: null, amount: 5000 },
  ],
  deductions: [
    { label: 'Provident Fund', amount: 2384 },
    { label: 'Professional Tax', amount: 200 },
  ],
  // The client deducts no income tax through payroll (TDS off in Settings).
  totals: { gross: 33903.23, deductions: 2584, net: 31319.23 },
  employerContributions: { eps: 1250, epf: 1134, esi: 0 },
}

async function main() {
  const samples: [string, PayslipViewInput][] = [
    ['in-paid', base],
    ['in-draft', { ...base, status: 'draft', identifiers: { uan: null, pfMemberId: null, esicNumber: null, pan: null } }],
    // The same payroll in the other layouts: PF and PT are what was deducted.
    ['gb-paid', { ...base, country: 'GB', currency: 'GBP' }],
    ['us-paid', { ...base, country: 'US', currency: 'USD' }],
  ]
  for (const [name, input] of samples) {
    const view = payslipView(input)
    // Made-up people with made-up PAN and UAN, on a page that otherwise looks
    // exactly like the real thing. Stamped, so a sample forwarded to somebody
    // can never be taken for a payslip.
    if (!view.stamp) view.stamp = 'SAMPLE — DUMMY DATA, NOT A REAL PAYSLIP'
    const pdf = await renderPayslipPdf(view, { createdAt: new Date('2026-09-01T00:00:00Z') })
    writeFileSync(`${outDir}/sample-${name}.pdf`, pdf)
    console.log(name, pdf.length, 'bytes')
  }
}

void main()
