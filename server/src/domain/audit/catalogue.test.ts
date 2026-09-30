import { describe, it, expect } from 'vitest'
import {
  AUDIT_ACTIONS,
  AUDIT_CATEGORIES,
  actionLabel,
  actionsIn,
  deviceOf,
  humanise,
  money,
  summarise,
  type AuditAction,
  type AuditNames,
} from './catalogue'
import { isoInstant, zonedDateTime, zonedDayStart } from '../shared/dates'

/**
 * The audit log's words. What matters: every action has a name, every row
 * reads as a sentence with names in it, and no row — however thin its facts —
 * shows a code, an id, "undefined" or "[object Object]".
 */

const names: AuditNames = {
  employee: (id) => (id === 'e-ravi' ? 'Ravi Patil' : null),
  user: (id) => (id === 'u-neha' ? 'Neha Sharma' : null),
  membership: (id) => (id === 'm-ravi' ? 'Ravi Patil' : null),
  documentType: (code) => (code === 'AADHAAR' ? 'Aadhaar Card' : null),
  component: (code) => (code === 'INCENTIVE' ? 'Incentive' : null),
  leaveType: (code) => (code === 'CL' ? 'Casual Leave' : null),
  report: (id) => (id === 'leave-taken' ? 'Leave taken' : null),
}

const row = (action: string, details: Record<string, unknown> = {}, entity: { type?: string; id?: string } = {}) =>
  summarise({ action, entityType: entity.type ?? null, entityId: entity.id ?? null, details }, names)

const ALL = Object.keys(AUDIT_ACTIONS) as AuditAction[]

describe('the catalogue', () => {
  it('names every action and puts it in a real category', () => {
    for (const action of ALL) {
      expect(AUDIT_ACTIONS[action].label.length, action).toBeGreaterThan(3)
      expect(Object.keys(AUDIT_CATEGORIES)).toContain(AUDIT_ACTIONS[action].category)
    }
  })

  it('files every action in exactly one category, and every category has some', () => {
    const filed = (Object.keys(AUDIT_CATEGORIES) as (keyof typeof AUDIT_CATEGORIES)[]).flatMap((c) => {
      expect(actionsIn(c).length, c).toBeGreaterThan(0)
      return actionsIn(c)
    })
    expect(filed.sort()).toEqual([...ALL].sort())
  })

  it('covers what the guide says the log must: sign-ins, refusals, roles, salary, payroll, documents, exports', () => {
    for (const a of [
      'auth.login_succeeded', 'auth.login_failed', 'permission.denied', 'user.role_changed', 'salary.set',
      'payroll.run_created', 'payroll.run_approved', 'payroll.run_reopened', 'payroll.run_paid',
      'document.downloaded', 'company_document.downloaded', 'bank_account.proof_downloaded',
      'report.exported', 'employee.exported', 'attendance.exported', 'payslip.downloaded', 'payroll.bank_file_downloaded',
    ]) expect(ALL).toContain(a)
  })

  it('gives an action it does not know words rather than its code', () => {
    expect(actionLabel('something.new_here')).toBe('something new here')
  })
})

describe('a row as a sentence', () => {
  it('never shows a code, an id or a missing value — even when the facts are empty', () => {
    for (const action of ALL) {
      for (const text of [row(action), row(action, {}, { type: 'employee', id: 'gone' })]) {
        expect(text, action).not.toMatch(/undefined|null|NaN|\[object|[a-z]+_[a-z]+|[a-z]+\.[a-z]+_/)
        expect(text.trim().length, action).toBeGreaterThan(5)
      }
    }
  })

  it('names the people and things a row points at', () => {
    expect(row('user.role_changed', { from: 'hr', to: 'rm' }, { type: 'membership', id: 'm-ravi' }))
      .toBe('Changed Ravi Patil’s role from HR to Reporting Manager')
    expect(row('document.downloaded', { employeeId: 'e-ravi', type: 'AADHAAR', own: false }))
      .toBe('Opened Ravi Patil’s Aadhaar Card')
    expect(row('document.downloaded', { employeeId: 'e-ravi', type: 'AADHAAR', own: true }))
      .toBe('Opened their own Aadhaar Card')
    expect(row('payroll.entry_set', { employeeId: 'e-ravi', component: 'INCENTIVE', year: 2026, month: 9, amount: 1500 }))
      .toBe('Set Incentive of ₹1,500.00 for Ravi Patil, September 2026')
    expect(row('auth.login_failed', { reason: 'wrong_password' }, { type: 'user', id: 'u-neha' }))
      .toBe('Sign-in to Neha Sharma refused: wrong password')
    expect(row('report.exported', { report: 'leave-taken', year: 2026, month: 8, rows: 12, departmentId: 'd1' }))
      .toBe('Exported “Leave taken” for August 2026: 12 rows, filtered')
  })

  it('states money the Indian way, with what it was before', () => {
    expect(row('salary.set', { kind: 'raise', ctc: 1250000, previousCtc: 1100000, effectiveFrom: '2026-10-01' }, { type: 'employee', id: 'e-ravi' }))
      .toBe('Set Ravi Patil’s new salary: CTC ₹12,50,000.00 a year from 1 Oct 2026 (was ₹11,00,000.00)')
    expect(row('payroll.run_approved', { year: 2026, month: 9, employees: 1, netPayable: 45210.5, assumedDays: 2 }))
      .toBe('Approved September 2026 payroll: 1 person, net ₹45,210.50, confirming 2 assumed days')
    expect(money('123456.00')).toBe('₹1,23,456.00')
    expect(money(-500)).toBe('-₹500.00')
  })

  it('says so when the person a row names is no longer on record', () => {
    expect(row('document.verified', { employeeId: 'e-left', type: 'PAN' })).toBe('Verified a former employee’s document')
  })

  it('reads the fields a change touched as words', () => {
    expect(row('employee.updated', { fields: ['phone', 'departmentId'], statutoryFields: ['pan'] }, { type: 'employee', id: 'e-ravi' }))
      .toBe('Changed Ravi Patil’s phone, department and PAN')
    expect(row('company.updated', { changes: { maxUploadMb: 5 } })).toBe('Changed the company’s upload limit')
    expect(humanise('reportingManagerId')).toBe('reporting manager')
    expect(humanise('someNewField')).toBe('some new field')
  })

  it('lists notification switches by their names', () => {
    expect(row('notification_settings.saved', { changes: [{ event: 'leave.submitted', enabled: false }] }))
      .toBe('Turned notices off: “A leave request is submitted”')
  })

  it('shows a refused request with the role in words', () => {
    expect(row('permission.denied', { permission: 'payroll:run:create', method: 'POST', path: '/api/payroll-runs', role: 'employee' }))
      .toBe('Was refused POST /api/payroll-runs — not allowed for Employee')
  })
})

describe('devices', () => {
  it('tells a browser and a system apart from the user agent', () => {
    expect(deviceOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0')).toBe('Edge on Windows')
    expect(deviceOf('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36')).toBe('Chrome on Android')
    expect(deviceOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1')).toBe('Safari on iPhone or iPad')
    expect(deviceOf('curl/8.4.0')).toBe('another program')
    expect(deviceOf(null)).toBeNull()
  })
})

describe('the company clock at a day boundary', () => {
  it('starts a Kolkata day at 18:30 UTC the day before', () => {
    expect(isoInstant(zonedDayStart('2026-10-01', 'Asia/Kolkata'))).toBe('2026-09-30T18:30:00.000Z')
  })

  it('lands on midnight on either side of a clock change', () => {
    // London: BST (UTC+1) until 25 Oct 2026, GMT after.
    expect(isoInstant(zonedDayStart('2026-10-25', 'Europe/London'))).toBe('2026-10-24T23:00:00.000Z')
    expect(isoInstant(zonedDayStart('2026-10-26', 'Europe/London'))).toBe('2026-10-26T00:00:00.000Z')
    expect(isoInstant(zonedDayStart('2026-01-15', 'UTC'))).toBe('2026-01-15T00:00:00.000Z')
  })

  it('writes an instant as the company reads it, sortable', () => {
    expect(zonedDateTime(new Date('2026-09-30T19:05:09Z'), 'Asia/Kolkata')).toBe('2026-10-01 00:35:09')
  })
})
