import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'

/**
 * Day 19: the reports, worked out on the server from the records — and the
 * CSV made from exactly the same rows.
 *
 * August 2026: Sundays are the 2nd, 9th, 16th, 23rd and 30th, and the 15th is
 * Independence Day — 25 working days in the month.
 */

const PREFIX = 'reptest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()
const day = (d: string) => new Date(`${d}T00:00:00Z`)

let orgId = ''
const token = {} as Record<'admin' | 'hr', string>
const dept = {} as Record<'sales' | 'tech', string>
const emp = {} as Record<'asha' | 'bala' | 'chitra' | 'dev', string>
const lt = {} as Record<'CL' | 'SL' | 'LWP', string>

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.payslipLine.deleteMany({ where: org })
  await prisma.payslip.deleteMany({ where: org })
  await prisma.payrollRun.deleteMany({ where: org })
  await prisma.attendance.deleteMany({ where: org })
  await prisma.leaveLedgerEntry.deleteMany({ where: org })
  await prisma.leaveRequest.deleteMany({ where: org })
  await prisma.leaveType.deleteMany({ where: org })
  await prisma.holiday.deleteMany({ where: org })
  await prisma.organizationPolicy.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.department.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

const report = (id: string, query = 'year=2026&month=8', who: 'admin' | 'hr' = 'admin') =>
  request(app).get(`/api/reports/${id}?${query}`).set('Authorization', `Bearer ${token[who]}`)

const csvOf = (id: string, query = 'year=2026&month=8') =>
  report(id, `${query}&format=csv`)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })

const rowOf = (body: { data: { rows: Record<string, unknown>[] } }, name: string) => body.data.rows.find((r) => r.full_name === name)

async function payslip(runId: string, employeeId: string, code: string, name: string, department: string, m: number, figures: Record<string, number>) {
  await prisma.payslip.create({
    data: {
      organizationId: orgId, payrollRunId: runId, employeeId, year: 2026, month: m, employeeCode: code, employeeName: name, department,
      uan: figures.uan ? String(figures.uan) : null,
      daysInMonth: 31, employmentDays: 31, lopDays: 0, paidDays: 31, ncpDays: 0, lopBasis: 'calendar_days', payBasisDays: 31, payableDays: 31,
      grossEarnings: figures.gross ?? 0, pfWages: figures.pfWages ?? 0, employeePf: figures.pf ?? 0, employeeEsi: figures.esi ?? 0,
      professionalTax: figures.pt ?? 0, tds: 0, otherDeductions: 0, totalDeductions: figures.deductions ?? 0, netPayable: figures.net ?? 0,
      employerPf: (figures.eps ?? 0) + (figures.epf ?? 0), employerEps: figures.eps ?? 0, employerEpf: figures.epf ?? 0, employerEsi: figures.employerEsi ?? 0,
      basis: {},
    },
  })
}

beforeAll(async () => {
  await cleanup()
  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata' } })
  orgId = org.id
  await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: day('2020-04-01'), weeklyOffDays: [0], leaveYearStartMonth: 4 } })
  await prisma.holiday.create({ data: { organizationId: orgId, name: 'Independence Day', date: day('2026-08-15'), type: 'public' } })
  dept.sales = (await prisma.department.create({ data: { organizationId: orgId, name: 'Sales' } })).id
  dept.tech = (await prisma.department.create({ data: { organizationId: orgId, name: 'Tech' } })).id

  const people = [
    ['asha', 'RP-1', 'Asha', dept.sales, '2025-01-01', null, 'full_time'],
    ['bala', 'RP-2', 'Bala', dept.tech, '2026-08-10', null, 'full_time'],
    ['chitra', 'RP-3', 'Chitra', dept.tech, '2024-05-01', '2026-08-20', 'contract'],
    ['dev', 'RP-4', 'Dev', dept.sales, '2026-09-05', null, 'intern'],
  ] as const
  for (const [key, code, name, departmentId, joined, left, type] of people) {
    emp[key] = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: code, fullName: name, departmentId, dateOfJoining: day(joined), lastWorkingDate: left ? day(left) : null, employmentType: type },
    })).id
  }

  const mark = (who: keyof typeof emp, d: string, status: 'present' | 'half_day' | 'absent' | 'on_leave', hours: number | null = null) =>
    prisma.attendance.create({ data: { organizationId: orgId, employeeId: emp[who], date: day(d), status, source: 'manual', hoursWorked: hours } })
  for (const d of ['01', '03', '04', '05', '06']) await mark('asha', `2026-08-${d}`, 'present', 9)
  await mark('asha', '2026-08-07', 'half_day', 4.5)
  await mark('asha', '2026-08-08', 'absent')
  await mark('asha', '2026-08-31', 'on_leave')
  await mark('bala', '2026-08-10', 'present', 9)
  await mark('bala', '2026-08-11', 'present', 9)
  for (const d of ['03', '04', '05']) await mark('chitra', `2026-08-${d}`, 'absent')

  for (const [code, name, isPaid] of [['CL', 'Casual Leave', true], ['SL', 'Sick Leave', true], ['LWP', 'Leave Without Pay', false]] as const) {
    lt[code] = (await prisma.leaveType.create({ data: { organizationId: orgId, code, name, isPaid, annualQuota: 12 } })).id
  }
  const leave = (who: keyof typeof emp, type: keyof typeof lt, from: string, to: string, days: number, status: 'approved' | 'pending', halfDayDates: string[] = []) =>
    prisma.leaveRequest.create({
      data: { organizationId: orgId, employeeId: emp[who], leaveTypeId: lt[type], fromDate: day(from), toDate: day(to), days, leaveYear: 2026, reason: 'x', status, halfDayDates },
    })
  await leave('asha', 'CL', '2026-08-31', '2026-09-02', 3, 'approved')
  await leave('asha', 'SL', '2026-08-28', '2026-08-28', 0.5, 'approved', ['2026-08-28'])
  await leave('chitra', 'LWP', '2026-08-17', '2026-08-18', 2, 'approved')
  await leave('bala', 'SL', '2026-10-05', '2026-10-05', 1, 'pending')
  const ledger = (who: keyof typeof emp, type: keyof typeof lt, days: number, reason: 'opening_grant' | 'consumed') =>
    prisma.leaveLedgerEntry.create({ data: { organizationId: orgId, employeeId: emp[who], leaveTypeId: lt[type], leaveYear: 2026, days, reason } })
  await ledger('asha', 'CL', 12, 'opening_grant')
  await ledger('asha', 'CL', -3, 'consumed')
  await ledger('asha', 'SL', 12, 'opening_grant')
  await ledger('asha', 'SL', -0.5, 'consumed')

  const run = (m: number, status: 'paid' | 'draft', net: number) =>
    prisma.payrollRun.create({
      data: {
        organizationId: orgId, year: 2026, month: m, status, lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 3,
        grossEarnings: net + 2000, totalDeductions: 2000, netPayable: net, employerPf: 0, employerEsi: 0, calculatedAt: day('2026-08-31'),
        paidOn: status === 'paid' ? day('2026-08-31') : null,
      },
    })
  await run(7, 'paid', 50000)
  const august = await run(8, 'paid', 55275)
  await payslip(august.id, emp.asha, 'RP-1', 'Asha', 'Sales', 8, { gross: 30000, pfWages: 15000, pf: 1800, pt: 200, deductions: 2000, net: 28000, eps: 1250, epf: 550, uan: 100000000001 })
  await payslip(august.id, emp.bala, 'RP-2', 'Bala', 'Tech', 8, { gross: 18000, pfWages: 12000, pf: 1440, esi: 135, pt: 200, deductions: 1775, net: 16225, eps: 999.6, epf: 440.4, employerEsi: 585 })
  await payslip(august.id, emp.chitra, 'RP-3', 'Chitra', 'Tech', 8, { gross: 12000, pfWages: 0, esi: 90, pt: 175, deductions: 265, net: 11050, employerEsi: 390 })

  for (const [key, role] of [['admin', 'super_admin'], ['hr', 'hr']] as const) {
    const email = `${PREFIX}-${key}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role, status: 'active' } })
    token[key] = (await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })).body.data.accessToken
  }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('attendance', () => {
  it('counts each person’s month — including the working days nobody marked', async () => {
    const res = await report('attendance-summary')
    expect(res.status).toBe(200)
    expect(res.body.data).toMatchObject({ id: 'attendance-summary', title: 'Monthly attendance summary', period: 'August 2026' })
    // Dev joined in September: not in August.
    expect(res.body.data.rows.map((r: { full_name: string }) => r.full_name)).toEqual(['Asha', 'Bala', 'Chitra'])

    expect(rowOf(res.body, 'Asha')).toMatchObject({ present: 5, half_day: 1, absent: 1, on_leave: 1, not_marked: 17, hours: 49.5, attendance_pct: 78.6, department: 'Sales' })
    // Joined on the 10th: 18 working days from then, two of them marked.
    expect(rowOf(res.body, 'Bala')).toMatchObject({ present: 2, not_marked: 16, attendance_pct: 100 })
    // Left on the 20th: 16 working days up to then, three marked absent.
    expect(rowOf(res.body, 'Chitra')).toMatchObject({ absent: 3, not_marked: 13, attendance_pct: 0 })
    expect(res.body.data.totals).toMatchObject({ full_name: 'Total (3)', present: 7, absent: 4, not_marked: 46, hours: 67.5 })
  })

  it('narrows to a department', async () => {
    const res = await report('attendance-summary', `year=2026&month=8&departmentId=${dept.tech}`)
    expect(res.body.data.rows.map((r: { full_name: string }) => r.full_name)).toEqual(['Bala', 'Chitra'])
  })

  it('adds up by department, with a chart of the percentages', async () => {
    const res = await report('attendance-by-department')
    expect(res.body.data.rows).toEqual([
      expect.objectContaining({ department: 'Sales', employees: 1, present: 5, attendance_pct: 78.6 }),
      expect.objectContaining({ department: 'Tech', employees: 2, present: 2, absent: 3, attendance_pct: 40 }),
    ])
    expect(res.body.data.chart).toEqual({ kind: 'bar', label: 'Attendance %', points: [{ label: 'Sales', value: 78.6 }, { label: 'Tech', value: 40 }] })
  })
})

describe('leave', () => {
  it('counts leave taken inside the month only — halves as halves, unpaid apart', async () => {
    const res = await report('leave-taken')
    const labels = res.body.data.columns.map((c: { label: string }) => c.label)
    expect(labels).toEqual(['Code', 'Employee', 'Department', 'Casual Leave', 'Leave Without Pay', 'Sick Leave', 'Total', 'Of which unpaid'])
    // 31 Aug – 2 Sept: only the 31st is August's.
    expect(rowOf(res.body, 'Asha')).toMatchObject({ type_CL: 1, type_SL: 0.5, total: 1.5, unpaid: 0 })
    expect(rowOf(res.body, 'Chitra')).toMatchObject({ type_LWP: 2, total: 2, unpaid: 2 })
    expect(rowOf(res.body, 'Bala')).toMatchObject({ total: 0 })
  })

  it('shows the ledger’s balances — and 0, not an invented quota, where nothing was granted', async () => {
    const res = await report('leave-balances')
    expect(res.body.data.period).toBe('Leave year 2026-27 (from April)')
    expect(rowOf(res.body, 'Asha')).toMatchObject({ type_CL: 9, type_SL: 11.5, type_LWP: 0, pending: 0 })
    expect(rowOf(res.body, 'Bala')).toMatchObject({ type_CL: 0, type_SL: 0, pending: 1 })
  })
})

describe('payroll', () => {
  it('lists the month’s payslips with totals, the run’s standing, and six months of net pay', async () => {
    const res = await report('payroll-summary')
    expect(res.body.data.notes[0]).toBe('Paid on 31 Aug 2026.')
    expect(rowOf(res.body, 'Asha')).toMatchObject({ gross: 30000, pf: 1800, pt: 200, deductions: 2000, net: 28000 })
    expect(res.body.data.totals).toMatchObject({ gross: 60000, net: 55275 })
    expect(res.body.data.chart.points).toEqual([
      { label: 'Mar', value: null }, { label: 'Apr', value: null }, { label: 'May', value: null },
      { label: 'Jun', value: null }, { label: 'Jul', value: 50000 }, { label: 'Aug', value: 55275 },
    ])
  })

  it('says so when a month has no payroll, rather than showing zeros', async () => {
    const res = await report('payroll-summary', 'year=2026&month=6')
    expect(res.body.data.rows).toEqual([])
    expect(res.body.data.totals).toBeNull()
    expect(res.body.data.notes[0]).toBe('No payroll has been run for June 2026.')
  })

  it('gives PF and ESI per person with the UAN on the payslip', async () => {
    const res = await report('pf-esi')
    expect(rowOf(res.body, 'Asha')).toMatchObject({ uan: '100000000001', pf_wages: 15000, employee_pf: 1800, employer_eps: 1250, employer_epf: 550 })
    expect(rowOf(res.body, 'Chitra')).toMatchObject({ uan: null, employee_esi: 90, employer_esi: 390 })
    expect(res.body.data.totals).toMatchObject({ employee_pf: 3240, employee_esi: 225, employer_esi: 975 })
  })
})

describe('people', () => {
  it('counts who was employed at the end of the month, by department and type', async () => {
    const res = await report('headcount')
    expect(res.body.data.period).toBe('As of 31 Aug 2026')
    expect(res.body.data.rows).toEqual([
      { department: 'Sales', total: 1, full_time: 1, part_time: 0, contract: 0, intern: 0 },
      { department: 'Tech', total: 1, full_time: 1, part_time: 0, contract: 0, intern: 0 },
    ])
  })

  it('lists joiners and leavers with their real dates — not "Inactive"', async () => {
    const res = await report('joiners-exits')
    expect(res.body.data.rows).toEqual([
      expect.objectContaining({ full_name: 'Bala', movement: 'Joined', date: '2026-08-10' }),
      expect.objectContaining({ full_name: 'Chitra', movement: 'Left', date: '2026-08-20' }),
    ])
    expect(res.body.data.totals.full_name).toBe('Joined 1 · left 1 · net +0')
  })
})

describe('the CSV', () => {
  it('is the same rows, through the one writer, and its taking is recorded', async () => {
    const res = await csvOf('payroll-summary')
    expect(res.status).toBe(200)
    expect(res.headers['content-disposition']).toBe('attachment; filename="payroll-summary-2026-08.csv"')
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8')
    const text = (res.body as Buffer).toString('utf8')
    expect(text.startsWith('﻿')).toBe(true)
    const lines = text.slice(1).split('\r\n').filter(Boolean)
    expect(lines[0]).toBe('Code,Employee,Department,Paid days,Loss of pay,Gross,PF,ESI,PT,TDS,Other,Deductions,Net pay')
    expect(lines).toContain('RP-1,Asha,Sales,31,0,30000.00,1800.00,0.00,200.00,0.00,0.00,2000.00,28000.00')
    expect(lines[lines.length - 1]).toBe(',Total (3),,93,0,60000.00,3240.00,225.00,575.00,0.00,0.00,4040.00,55275.00')

    const event = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'report.exported' }, orderBy: { createdAt: 'desc' } })
    expect(event?.details).toMatchObject({ report: 'payroll-summary', year: 2026, month: 8, rows: 3 })
  })
})

/**
 * June 2026, kept apart from August above: people who were let go, a person
 * nobody can place, a leave type since archived, the weekly-off rule changing
 * later, and a payslip carrying the department its person was in then.
 *
 * June 2026: Sundays are the 7th, 14th, 21st and 28th — 26 working days.
 */
describe('people who left, and rules that changed since', () => {
  const june = 'year=2026&month=6'
  let esha = ''
  let farid = ''

  beforeAll(async () => {
    // Esha was let go on 18 June (archived, 17:30 in Kolkata) with no last working day recorded.
    esha = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: 'RP-5', fullName: 'Esha', departmentId: dept.sales, dateOfJoining: day('2025-01-01'), archivedAt: new Date('2026-06-18T12:00:00Z') },
    })).id
    // Farid's last day was the 10th; he was archived two days later.
    farid = (await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: 'RP-6', fullName: 'Farid', departmentId: dept.tech, dateOfJoining: day('2025-01-01'), lastWorkingDate: day('2026-06-10'), status: 'inactive', archivedAt: new Date('2026-06-12T06:00:00Z') },
    })).id
    // Gita is marked inactive, with no last working day, and was never archived.
    await prisma.employee.create({
      data: { organizationId: orgId, employeeCode: 'RP-7', fullName: 'Gita', departmentId: dept.sales, dateOfJoining: day('2025-01-01'), status: 'inactive' },
    })
    for (const d of ['01', '02', '03']) {
      await prisma.attendance.create({ data: { organizationId: orgId, employeeId: esha, date: day(`2026-06-${d}`), status: 'present', source: 'manual' } })
    }
    // Two days under a type that has since been archived.
    const od = await prisma.leaveType.create({ data: { organizationId: orgId, code: 'OD', name: 'On Duty', isPaid: true, annualQuota: 0, archivedAt: new Date('2026-07-01T00:00:00Z') } })
    await prisma.leaveRequest.create({
      data: { organizationId: orgId, employeeId: esha, leaveTypeId: od.id, fromDate: day('2026-06-04'), toDate: day('2026-06-05'), days: 2, leaveYear: 2026, reason: 'x', status: 'approved' },
    })
    // From October Saturdays are off too; June was counted by the old rule.
    await prisma.organizationPolicy.updateMany({ where: { organizationId: orgId, effectiveTo: null }, data: { effectiveTo: day('2026-09-30') } })
    await prisma.organizationPolicy.create({ data: { organizationId: orgId, effectiveFrom: day('2026-10-01'), weeklyOffDays: [0, 6], leaveYearStartMonth: 4 } })

    // June's payroll: Asha was in Tech then (Sales now); Farid's net came out below zero.
    const juneRun = await prisma.payrollRun.create({
      data: {
        organizationId: orgId, year: 2026, month: 6, status: 'paid', lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 2,
        grossEarnings: 32000, totalDeductions: 4350, netPayable: 27650, employerPf: 0, employerEsi: 0, calculatedAt: day('2026-06-30'), paidOn: day('2026-06-30'),
      },
    })
    await payslip(juneRun.id, emp.asha, 'RP-1', 'Asha', 'Tech', 6, { gross: 30000, deductions: 2000, net: 28000 })
    await payslip(juneRun.id, farid, 'RP-6', 'Farid', 'Tech', 6, { gross: 2000, deductions: 2350, net: -350 })
    // May is still a draft.
    await prisma.payrollRun.create({
      data: {
        organizationId: orgId, year: 2026, month: 5, status: 'draft', lopBasis: 'calendar_days', sandwichRule: false, employeeCount: 0,
        grossEarnings: 0, totalDeductions: 0, netPayable: 0, employerPf: 0, employerEsi: 0, calculatedAt: day('2026-05-31'),
      },
    })
  })

  it('still counts somebody who was let go, for the days they worked', async () => {
    const res = await report('attendance-summary', june)
    const names = res.body.data.rows.map((r: { full_name: string }) => r.full_name)
    expect(names).toContain('Esha')
    expect(names).toContain('Farid')
    // Esha: 1–18 June is 16 working days (the 7th and 14th are Sundays); three marked present.
    expect(rowOf(res.body, 'Esha')).toMatchObject({ present: 3, not_marked: 13 })
    // Farid: 1–10 June, 9 working days, none marked.
    expect(rowOf(res.body, 'Farid')).toMatchObject({ not_marked: 9 })
  })

  it('leaves out, and says so, somebody inactive with no last working day', async () => {
    const res = await report('attendance-summary', june)
    expect(res.body.data.rows.map((r: { full_name: string }) => r.full_name)).not.toContain('Gita')
    expect(res.body.data.notes.join(' ')).toMatch(/One person is marked inactive with no last working day recorded, and left out/)
  })

  it('counts June by the weekly offs June had, not the rule that came in October', async () => {
    // Asha marked nothing in June: all 26 working days are unmarked. With the
    // October rule (Saturdays off) it would wrongly be 22.
    const res = await report('attendance-summary', june)
    expect(rowOf(res.body, 'Asha')).toMatchObject({ not_marked: 26 })
  })

  it('lists who left with the day it ended — recorded, or the day access was removed', async () => {
    const res = await report('joiners-exits', june)
    expect(res.body.data.rows).toEqual([
      expect.objectContaining({ full_name: 'Farid', movement: 'Left', date: '2026-06-10' }),
      expect.objectContaining({ full_name: 'Esha', movement: 'Left — access removed', date: '2026-06-18' }),
    ])
    expect(res.body.data.notes.join(' ')).toMatch(/One person left with no last working day recorded/)
    // Neither is counted at the end of June — Asha and Chitra are.
    const head = await report('headcount', june)
    expect(head.body.data.totals.total).toBe(2)
  })

  it('keeps leave taken under a type archived since — and hides the type where it has no days', async () => {
    const res = await report('leave-taken', june)
    expect(res.body.data.columns.map((c: { label: string }) => c.label)).toContain('On Duty (archived)')
    expect(rowOf(res.body, 'Esha')).toMatchObject({ type_OD: 2, total: 2 })
    const august = await report('leave-taken')
    expect(august.body.data.columns.map((c: { label: string }) => c.label)).not.toContain('On Duty (archived)')
  })

  it('filters payslips by the department they carry, and the trend follows the filter and marks drafts', async () => {
    const tech = await report('payroll-summary', `${june}&departmentId=${dept.tech}`)
    expect(tech.body.data.rows.map((r: { full_name: string }) => r.full_name)).toEqual(['Asha', 'Farid'])
    expect(tech.body.data.totals).toMatchObject({ net: 27650 })
    const sales = await report('payroll-summary', `${june}&departmentId=${dept.sales}`)
    expect(sales.body.data.rows).toEqual([])
    // The June bar is the filtered table's total; May says it is a draft.
    const points = tech.body.data.chart.points as { label: string; value: number | null }[]
    expect(tech.body.data.chart.label).toBe('Net pay by month — for these filters')
    expect(points.find((x) => x.label === 'Jun')?.value).toBe(27650)
    expect(points.some((x) => x.label === 'May (draft)')).toBe(true)
  })

  it('writes a negative net pay into the CSV as a number, so the column still adds up', async () => {
    const res = await csvOf('payroll-summary', june)
    const text = (res.body as Buffer).toString('utf8')
    expect(text).toContain('RP-6,Farid,Tech,31,0,2000.00,0.00,0.00,0.00,0.00,0.00,2350.00,-350.00')
    expect(text).not.toContain("'-350")
  })
})

describe('who may run them', () => {
  it('is the Super Admin, as the client’s matrix says', async () => {
    expect((await report('attendance-summary', 'year=2026&month=8', 'hr')).status).toBe(403)
  })

  it('refuses a report that does not exist, or a month that cannot', async () => {
    expect((await report('salaries-of-everyone')).status).toBe(404)
    expect((await report('headcount', 'year=2026&month=13')).status).toBe(422)
  })
})
