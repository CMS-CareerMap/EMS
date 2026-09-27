/**
 * Arithmetic over a whole payroll run.
 *
 * The run's totals are the sum of its payslips and nothing else — never
 * recalculated from salaries, which could disagree with what the payslips say.
 */

export interface PayslipTotals {
  grossEarnings: number
  totalDeductions: number
  netPayable: number
  employerPf: number
  employerEsi: number
}

const paise = (value: number) => Math.round(value * 100) / 100

/** Added to the paisa at every step, so a hundred payslips cannot drift. */
export function runTotals(payslips: readonly PayslipTotals[]): PayslipTotals & { employeeCount: number } {
  const totals: PayslipTotals = {
    grossEarnings: 0,
    totalDeductions: 0,
    netPayable: 0,
    employerPf: 0,
    employerEsi: 0,
  }

  for (const slip of payslips) {
    totals.grossEarnings = paise(totals.grossEarnings + slip.grossEarnings)
    totals.totalDeductions = paise(totals.totalDeductions + slip.totalDeductions)
    totals.netPayable = paise(totals.netPayable + slip.netPayable)
    totals.employerPf = paise(totals.employerPf + slip.employerPf)
    totals.employerEsi = paise(totals.employerEsi + slip.employerEsi)
  }

  return { ...totals, employeeCount: payslips.length }
}

/** A payslip reduced to what approval has to be sure of. */
export interface ComparablePayslip {
  employeeId: string
  employeeName: string
  figures: Record<string, number>
  lines: readonly { kind: string; code: string; amount: number }[]
}

export interface PayslipDifference {
  employeeId: string
  employeeName: string
  change: 'added' | 'removed' | 'changed'
  /** Which figures or lines moved, by name. */
  fields: string[]
}

/**
 * What would come out differently if the draft were calculated again now.
 *
 * Approval signs the figures on the page. If a leave was decided or a day of
 * attendance corrected after the draft was worked out, the page is out of date,
 * and approving it would sign figures the records no longer support.
 */
export function payslipDifferences(
  stored: readonly ComparablePayslip[],
  fresh: readonly ComparablePayslip[],
): PayslipDifference[] {
  const before = new Map(stored.map((slip) => [slip.employeeId, slip]))
  const after = new Map(fresh.map((slip) => [slip.employeeId, slip]))
  const out: PayslipDifference[] = []

  for (const slip of fresh) {
    const old = before.get(slip.employeeId)
    if (!old) {
      out.push({ employeeId: slip.employeeId, employeeName: slip.employeeName, change: 'added', fields: [] })
      continue
    }

    const fields = new Set<string>()
    for (const key of new Set([...Object.keys(old.figures), ...Object.keys(slip.figures)])) {
      if (paise(old.figures[key] ?? 0) !== paise(slip.figures[key] ?? 0)) fields.add(key)
    }

    const lineKey = (line: { kind: string; code: string }) => `${line.kind}:${line.code}`
    const oldLines = new Map(old.lines.map((line) => [lineKey(line), paise(line.amount)]))
    const newLines = new Map(slip.lines.map((line) => [lineKey(line), paise(line.amount)]))
    for (const key of new Set([...oldLines.keys(), ...newLines.keys()])) {
      if (oldLines.get(key) !== newLines.get(key)) fields.add(key.split(':')[1] ?? key)
    }

    if (fields.size > 0) {
      out.push({ employeeId: slip.employeeId, employeeName: slip.employeeName, change: 'changed', fields: [...fields] })
    }
  }

  for (const slip of stored) {
    if (!after.has(slip.employeeId)) {
      out.push({ employeeId: slip.employeeId, employeeName: slip.employeeName, change: 'removed', fields: [] })
    }
  }

  return out
}
