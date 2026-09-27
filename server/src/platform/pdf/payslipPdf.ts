import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import PDFDocument from 'pdfkit'
import type { PayslipView } from '../../domain/payroll/payslipView'

/**
 * A payslip view, laid out on an A4 page.
 *
 * pdfkit, not a headless browser: nothing to install on the server, no Chrome
 * to keep patched, and the whole document is built in memory and returned as
 * a Buffer (guide, Day 17).
 *
 * This file decides WHERE things go and nothing else. Every word, date and
 * amount arrives already formatted in the view, so what a payslip says is
 * tested in domain/payroll/payslipView.test.ts without a PDF in sight.
 *
 * The font is embedded — Noto Sans, under the SIL Open Font License, in
 * assets/fonts. The fourteen fonts every PDF reader has built in cannot print
 * ₹, and a payslip that shows a box where the currency should be is not one.
 */

function fontsDir(): string {
  // Next to src/ when run from source, one level further up when compiled
  // into dist/, and the working directory as the last resort.
  const candidates = [
    resolve(__dirname, '../../../assets/fonts'),
    resolve(__dirname, '../../../../assets/fonts'),
    resolve(process.cwd(), 'assets/fonts'),
  ]
  const found = candidates.find((dir) => existsSync(resolve(dir, 'NotoSans-Regular.ttf')))
  if (!found) throw new Error('Payslip fonts are missing: expected assets/fonts/NotoSans-Regular.ttf')
  return found
}

const INK = '#111827'
const MUTED = '#6b7280'
const RULE = '#d1d5db'
const STAMP = '#b91c1c'

export interface RenderOptions {
  /**
   * Written into the PDF as its creation date. Passed in rather than read from
   * the clock, so the same payslip rendered twice is the same file.
   */
  createdAt: Date
}

export async function renderPayslipPdf(view: PayslipView, options: RenderOptions): Promise<Buffer> {
  const dir = fontsDir()
  const doc = new PDFDocument({
    size: 'A4',
    margin: 40,
    info: {
      Title: `${view.heading} — ${view.details.left[0]?.value ?? ''}`,
      Author: view.employer.name,
      Creator: 'EMS',
      Producer: 'EMS',
      CreationDate: options.createdAt,
      ModDate: options.createdAt,
    },
  })

  doc.registerFont('body', resolve(dir, 'NotoSans-Regular.ttf'))
  doc.registerFont('bold', resolve(dir, 'NotoSans-Bold.ttf'))

  const chunks: Buffer[] = []
  doc.on('data', (chunk: Buffer) => chunks.push(chunk))
  const done = new Promise<Buffer>((resolveDone, reject) => {
    doc.on('end', () => resolveDone(Buffer.concat(chunks)))
    doc.on('error', reject)
  })

  const left = doc.page.margins.left
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right
  const rule = (y: number) => doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.6).strokeColor(RULE).stroke()

  // ── Employer and heading ────────────────────────────────────────────────
  let y = doc.page.margins.top
  doc.font('bold').fontSize(15).fillColor(INK).text(view.employer.name, left, y, { width })
  y = doc.y
  if (view.employer.address) {
    doc.font('body').fontSize(8.5).fillColor(MUTED).text(view.employer.address, left, y + 1, { width })
    y = doc.y
  }

  y += 10
  doc.font('bold').fontSize(12).fillColor(INK).text(view.heading, left, y, { width })
  y = doc.y

  if (view.stamp) {
    y += 6
    const stampHeight = 20
    doc.rect(left, y, width, stampHeight).lineWidth(1).strokeColor(STAMP).stroke()
    doc.font('bold').fontSize(9.5).fillColor(STAMP).text(view.stamp, left, y + 5, { width, align: 'center' })
    y += stampHeight
  }

  y += 10
  rule(y)
  y += 8

  // ── The employee on the left, their numbers and the period on the right ──
  const colWidth = width / 2
  const labelWidth = 110
  const column = (items: PayslipView['details']['left'], x: number, top: number): number => {
    let at = top
    for (const item of items) {
      doc.font('body').fontSize(8.5).fillColor(MUTED).text(item.label, x, at, { width: labelWidth })
      const labelBottom = doc.y
      doc.font('bold').fontSize(8.5).fillColor(INK).text(item.value, x + labelWidth, at, { width: colWidth - labelWidth - 8 })
      at = Math.max(labelBottom, doc.y) + 3
    }
    return at
  }
  y = Math.max(column(view.details.left, left, y), column(view.details.right, left + colWidth, y))

  y += 4
  rule(y)
  y += 8

  // ── Days ────────────────────────────────────────────────────────────────
  const dayWidth = width / view.days.length
  view.days.forEach((d, i) => {
    const x = left + i * dayWidth
    doc.font('body').fontSize(8.5).fillColor(MUTED).text(d.label, x, y, { width: dayWidth - 8 })
    doc.font('bold').fontSize(10).fillColor(INK).text(d.value, x, y + 12, { width: dayWidth - 8 })
  })
  y += 32
  rule(y)
  y += 10

  // ── Earnings and deductions, side by side ───────────────────────────────
  const gap = 16
  const half = (width - gap) / 2
  const earnX = left
  const dedX = left + half + gap
  const amountWidth = 80
  const rateWidth = 72

  doc.font('bold').fontSize(9).fillColor(INK)
  doc.text(view.labels.earnings, earnX, y, { width: half - rateWidth - amountWidth })
  doc.text(view.labels.rate, earnX + half - rateWidth - amountWidth, y, { width: rateWidth, align: 'right' })
  doc.text(view.labels.amount, earnX + half - amountWidth, y, { width: amountWidth, align: 'right' })
  doc.text(view.labels.deductions, dedX, y, { width: half - amountWidth })
  doc.text(view.labels.amount, dedX + half - amountWidth, y, { width: amountWidth, align: 'right' })
  y += 15
  doc.moveTo(earnX, y).lineTo(earnX + half, y).lineWidth(0.6).strokeColor(RULE).stroke()
  doc.moveTo(dedX, y).lineTo(dedX + half, y).lineWidth(0.6).strokeColor(RULE).stroke()
  y += 5

  const lines = Math.max(view.earnings.length, view.deductions.length, 1)
  for (let i = 0; i < lines; i++) {
    const earning = view.earnings[i]
    const deduction = view.deductions[i]
    doc.font('body').fontSize(8.5).fillColor(INK)
    if (earning) {
      doc.text(earning.label, earnX, y, { width: half - rateWidth - amountWidth - 4 })
      doc.fillColor(MUTED).text(earning.rate ?? '', earnX + half - rateWidth - amountWidth, y, { width: rateWidth, align: 'right' })
      doc.fillColor(INK).text(earning.amount, earnX + half - amountWidth, y, { width: amountWidth, align: 'right' })
    }
    if (deduction) {
      doc.fillColor(INK).text(deduction.label, dedX, y, { width: half - amountWidth - 4 })
      doc.text(deduction.amount, dedX + half - amountWidth, y, { width: amountWidth, align: 'right' })
    }
    y += 14
  }

  y += 2
  doc.moveTo(earnX, y).lineTo(earnX + half, y).lineWidth(0.6).strokeColor(RULE).stroke()
  doc.moveTo(dedX, y).lineTo(dedX + half, y).lineWidth(0.6).strokeColor(RULE).stroke()
  y += 5

  const [gross, deductions] = view.totals
  doc.font('bold').fontSize(9).fillColor(INK)
  if (gross) {
    doc.text(gross.label, earnX, y, { width: half - amountWidth })
    doc.text(gross.value, earnX + half - amountWidth, y, { width: amountWidth, align: 'right' })
  }
  if (deductions) {
    doc.text(deductions.label, dedX, y, { width: half - amountWidth })
    doc.text(deductions.value, dedX + half - amountWidth, y, { width: amountWidth, align: 'right' })
  }
  y += 22

  // ── Net pay ─────────────────────────────────────────────────────────────
  const netHeight = view.net.words ? 44 : 28
  doc.rect(left, y, width, netHeight).fillColor('#f3f4f6').fill()
  doc.font('bold').fontSize(11).fillColor(INK).text(view.net.label, left + 10, y + 8, { width: width / 2 })
  doc.font('bold').fontSize(12).text(view.net.value, left + width / 2, y + 7, { width: width / 2 - 10, align: 'right' })
  if (view.net.words) {
    doc.font('body').fontSize(8.5).fillColor(MUTED).text(view.net.words, left + 10, y + 26, { width: width - 20 })
  }
  y += netHeight + 14

  // ── What the employer paid on top ───────────────────────────────────────
  if (view.employerContributions) {
    doc.font('bold').fontSize(9).fillColor(INK).text(view.employerContributions.title, left, y, { width })
    y = doc.y + 4
    if (view.employerContributions.rows.length === 0) {
      doc.font('body').fontSize(8.5).fillColor(MUTED).text(view.employerContributions.none, left, y, { width })
      y = doc.y
    }
    for (const row of view.employerContributions.rows) {
      doc.font('body').fontSize(8.5).fillColor(INK).text(row.label, left, y, { width: half })
      doc.text(row.amount, left + half - amountWidth, y, { width: amountWidth, align: 'right' })
      y += 14
    }
  }

  // ── Footer ──────────────────────────────────────────────────────────────
  const footerY = doc.page.height - doc.page.margins.bottom - 12
  doc.font('body').fontSize(7.5).fillColor(MUTED).text(view.footer, left, footerY, { width, align: 'center', lineBreak: false })

  doc.end()
  return done
}
