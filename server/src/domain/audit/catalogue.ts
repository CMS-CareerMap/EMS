import { dayLabel, monthName, isCalendarDate } from '../shared/dates'
import { NOTIFICATION_EVENTS, isNotificationEvent } from '../notifications/events'

/**
 * Every action the audit log records, what it is called, and how a row of it
 * reads.
 *
 * One list, keyed by the action's code, so adding an action without a name
 * fails to compile: the reading screen can never show a raw "payroll.run_paid"
 * because somebody forgot this file. The codes stay in the table — they are
 * what a filter and a CSV sort by — but a person reads the label and the
 * summary.
 *
 * Pure: the names of the people and things a row points at are looked up by
 * the caller and handed in, so this file can be tested without a database.
 */

export const AUDIT_CATEGORIES = {
  sign_in: 'Sign-ins and sessions',
  refused: 'Refused requests',
  users: 'Users and roles',
  people: 'Employee records',
  pay: 'Salary and payroll',
  bank: 'Bank accounts',
  time: 'Leave and attendance',
  documents: 'Documents and files',
  exports: 'Exports and downloads',
  settings: 'Company settings',
  system: 'System jobs',
} as const

export type AuditCategory = keyof typeof AUDIT_CATEGORIES

interface ActionInfo {
  label: string
  category: AuditCategory
}

export const AUDIT_ACTIONS = {
  // Signing in and staying in
  'auth.login_succeeded': { label: 'Signed in', category: 'sign_in' },
  'auth.login_failed': { label: 'Sign-in refused', category: 'sign_in' },
  'auth.logged_out': { label: 'Signed out', category: 'sign_in' },
  'auth.refresh_token_reused': { label: 'Copied session stopped', category: 'sign_in' },
  'auth.password_changed': { label: 'Password changed', category: 'sign_in' },
  'auth.password_link_used': { label: 'Password set from a link', category: 'sign_in' },
  // Refusals
  'permission.denied': { label: 'Request refused', category: 'refused' },
  // Who has access, and as what
  'user.invited': { label: 'User invited', category: 'users' },
  'user.role_changed': { label: 'Role changed', category: 'users' },
  'user.status_changed': { label: 'Login turned on or off', category: 'users' },
  'user.terminated': { label: 'User removed', category: 'users' },
  'user.password_link_issued': { label: 'Password link issued', category: 'users' },
  // People
  'employee.created': { label: 'Employee added', category: 'people' },
  'employee.updated': { label: 'Employee record changed', category: 'people' },
  'employee.imported': { label: 'Employees imported', category: 'people' },
  // Pay
  'salary.set': { label: 'Salary set', category: 'pay' },
  'payroll.run_created': { label: 'Payroll calculated', category: 'pay' },
  'payroll.run_recalculated': { label: 'Payroll recalculated', category: 'pay' },
  'payroll.run_discarded': { label: 'Payroll discarded', category: 'pay' },
  'payroll.run_approved': { label: 'Payroll approved', category: 'pay' },
  'payroll.run_reopened': { label: 'Payroll reopened', category: 'pay' },
  'payroll.run_paid': { label: 'Payroll marked paid', category: 'pay' },
  'payroll.tds_directive_set': { label: 'TDS set', category: 'pay' },
  'payroll.entry_set': { label: 'Monthly amount set', category: 'pay' },
  'payroll.entry_removed': { label: 'Monthly amount removed', category: 'pay' },
  'bank_file_template.saved': { label: 'Bank file format saved', category: 'pay' },
  // Bank accounts
  'bank_account.saved': { label: 'Bank account saved', category: 'bank' },
  'bank_account.submitted': { label: 'Bank account sent in', category: 'bank' },
  'bank_account.verified': { label: 'Bank account verified', category: 'bank' },
  'bank_account.rejected': { label: 'Bank account rejected', category: 'bank' },
  // Leave and attendance
  'leave.applied_for': { label: 'Leave applied for', category: 'time' },
  'leave.withdrawn': { label: 'Leave withdrawn', category: 'time' },
  'leave.approved': { label: 'Leave approved', category: 'time' },
  'leave.rejected': { label: 'Leave rejected', category: 'time' },
  'leave.reversed': { label: 'Leave reversed', category: 'time' },
  'leave.granted': { label: 'Leave year granted', category: 'time' },
  'leave.balance_adjusted': { label: 'Leave balance corrected', category: 'time' },
  'attendance.marked': { label: 'Attendance marked', category: 'time' },
  'attendance.imported': { label: 'Attendance imported', category: 'time' },
  // Company rules
  'company.updated': { label: 'Company details changed', category: 'settings' },
  'policy.updated': { label: 'Payroll rules changed', category: 'settings' },
  'pt_table.set': { label: 'Professional tax slabs set', category: 'settings' },
  'geofence.saved': { label: 'Office location saved', category: 'settings' },
  'geofence.deleted': { label: 'Office location removed', category: 'settings' },
  'leave_type.created': { label: 'Leave type added', category: 'settings' },
  'leave_type.restored': { label: 'Leave type restored', category: 'settings' },
  'leave_type.updated': { label: 'Leave type changed', category: 'settings' },
  'leave_type.archived': { label: 'Leave type archived', category: 'settings' },
  'holiday.added': { label: 'Holiday added', category: 'settings' },
  'holiday.changed': { label: 'Holiday changed', category: 'settings' },
  'holiday.removed': { label: 'Holiday removed', category: 'settings' },
  'master_data.added': { label: 'List entry added', category: 'settings' },
  'master_data.restored': { label: 'List entry restored', category: 'settings' },
  'master_data.renamed': { label: 'List entry renamed', category: 'settings' },
  'master_data.changed': { label: 'Shift changed', category: 'settings' },
  'master_data.archived': { label: 'List entry archived', category: 'settings' },
  'notification_settings.saved': { label: 'Notification settings changed', category: 'settings' },
  // Documents. Opening one is recorded as well as changing it: who opened whose
  // Aadhaar is exactly what an audit of an HR system is asked.
  'document_type.created': { label: 'Document type added', category: 'documents' },
  'document_type.updated': { label: 'Document type changed', category: 'documents' },
  'document_type.archived': { label: 'Document type archived', category: 'documents' },
  'document_type.restored': { label: 'Document type restored', category: 'documents' },
  'document.uploaded': { label: 'Document uploaded', category: 'documents' },
  'document.verified': { label: 'Document verified', category: 'documents' },
  'document.rejected': { label: 'Document rejected', category: 'documents' },
  'document.removed': { label: 'Document removed', category: 'documents' },
  'document.downloaded': { label: 'Document opened', category: 'documents' },
  'company_document.published': { label: 'Company document published', category: 'documents' },
  'company_document.removed': { label: 'Company document withdrawn', category: 'documents' },
  'company_document.downloaded': { label: 'Company document opened', category: 'documents' },
  'bank_account.proof_downloaded': { label: 'Bank proof opened', category: 'documents' },
  'file.unreadable': { label: 'Stored file unreadable', category: 'documents' },
  // Everything that leaves the system as a file.
  'report.exported': { label: 'Report exported', category: 'exports' },
  'employee.exported': { label: 'Employee list exported', category: 'exports' },
  'attendance.exported': { label: 'Attendance exported', category: 'exports' },
  'payslip.downloaded': { label: 'Payslip downloaded', category: 'exports' },
  'payroll.bank_file_downloaded': { label: 'Bank file downloaded', category: 'exports' },
  'audit.exported': { label: 'Audit log exported', category: 'exports' },
  // The server's own jobs, so a backup that stopped working shows here, where
  // somebody looks, and not only in a log file on the server.
  'backup.taken': { label: 'Backup taken', category: 'system' },
  'backup.failed': { label: 'Backup FAILED', category: 'system' },
  'backup.drill_passed': { label: 'Restore drill passed', category: 'system' },
  'backup.drill_failed': { label: 'Restore drill FAILED', category: 'system' },
} as const satisfies Record<string, ActionInfo>

export type AuditAction = keyof typeof AUDIT_ACTIONS

export function isAuditAction(value: string): value is AuditAction {
  return Object.hasOwn(AUDIT_ACTIONS, value)
}

export function isAuditCategory(value: string): value is AuditCategory {
  return Object.hasOwn(AUDIT_CATEGORIES, value)
}

/** Every action in a category — what a category filter asks the database for. */
export function actionsIn(category: AuditCategory): AuditAction[] {
  return (Object.keys(AUDIT_ACTIONS) as AuditAction[]).filter((a) => AUDIT_ACTIONS[a].category === category)
}

/** An action written before this list knew its name still gets words, not a code. */
export function actionLabel(action: string): string {
  return isAuditAction(action) ? AUDIT_ACTIONS[action].label : humanise(action.replace(/[._]/g, ' '))
}

export function categoryOf(action: string): AuditCategory | null {
  return isAuditAction(action) ? AUDIT_ACTIONS[action].category : null
}

// ── Words for the values the rows carry ──────────────────────────────────────

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  hr: 'HR',
  manager: 'Manager',
  rm: 'Reporting Manager',
  accounts: 'Accounts',
  employee: 'Employee',
}

export function roleLabel(role: unknown): string {
  return typeof role === 'string' ? ROLE_LABELS[role] ?? humanise(role) : 'no role'
}

const ATTENDANCE_WORDS: Record<string, string> = {
  present: 'present',
  half_day: 'on a half day',
  absent: 'absent',
  on_leave: 'on leave',
  holiday: 'on a holiday',
  weekly_off: 'on a weekly off',
}

const ACCOUNT_STATUS_WORDS: Record<string, string> = {
  active: 'active',
  inactive: 'turned off',
  invited: 'invited',
}

/** Field names as a person would say them. Unknown ones are split out of camelCase. */
const FIELD_LABELS: Record<string, string> = {
  fullName: 'name',
  personalEmail: 'personal email',
  phone: 'phone',
  departmentId: 'department',
  designationId: 'designation',
  reportingManagerId: 'reporting manager',
  shiftId: 'shift',
  joiningDate: 'joining date',
  lastWorkingDate: 'last working day',
  dateOfBirth: 'date of birth',
  employmentType: 'employment type',
  pan: 'PAN',
  uan: 'UAN',
  esiNumber: 'ESI number',
  ptState: 'professional tax state',
  pfApplicable: 'PF',
  hasPriorPfMembership: 'earlier PF membership',
  maxUploadMb: 'upload limit',
  timezone: 'time zone',
  legalName: 'legal name',
  gstin: 'GSTIN',
  tan: 'TAN',
  leaveYearStartMonth: 'leave year start',
}

/** "reportingManagerId" → "reporting manager". */
export function humanise(key: string): string {
  const known = FIELD_LABELS[key]
  if (known) return known
  return key
    .replace(/Id$/, '')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim()
}

/** "phone, department and shift". */
function listOf(words: string[]): string {
  if (words.length <= 1) return words[0] ?? ''
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

function fieldsOf(value: unknown): string {
  const keys = Array.isArray(value)
    ? value.filter((k): k is string => typeof k === 'string')
    : value && typeof value === 'object' ? Object.keys(value) : []
  return listOf([...new Set(keys.map(humanise))])
}

const RUPEES = new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function money(value: unknown): string {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN
  return Number.isFinite(n) ? RUPEES.format(n) : 'an amount'
}

function day(value: unknown): string {
  return typeof value === 'string' && isCalendarDate(value) ? dayLabel(value) : 'a day'
}

function month(details: Details): string {
  const y = Number(details.year)
  const m = Number(details.month)
  return Number.isInteger(y) && Number.isInteger(m) && m >= 1 && m <= 12 ? monthName(y, m) : 'a month'
}

function count(n: unknown, one: string, many = `${one}s`): string {
  const v = Number(n)
  return Number.isFinite(v) ? `${v} ${v === 1 ? one : many}` : `some ${many}`
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

/** "Edge on Windows" from a user-agent string — enough to tell two devices apart. */
export function deviceOf(userAgent: unknown): string | null {
  if (typeof userAgent !== 'string' || !userAgent) return null
  const browser =
    /Edg\//.test(userAgent) ? 'Edge'
      : /OPR\/|Opera/.test(userAgent) ? 'Opera'
        : /Firefox\//.test(userAgent) ? 'Firefox'
          : /Chrome\//.test(userAgent) ? 'Chrome'
            : /Safari\//.test(userAgent) ? 'Safari'
              : null
  const system =
    /Windows/.test(userAgent) ? 'Windows'
      : /Android/.test(userAgent) ? 'Android'
        : /iPhone|iPad|iOS/.test(userAgent) ? 'iPhone or iPad'
          : /Mac OS X|Macintosh/.test(userAgent) ? 'Mac'
            : /Linux/.test(userAgent) ? 'Linux'
              : null
  if (browser && system) return `${browser} on ${system}`
  return browser ?? system ?? 'another program'
}

// ── A row as a sentence ──────────────────────────────────────────────────────

export type Details = Record<string, unknown>

/** What the caller has looked up: the names behind the ids a row carries. */
export interface AuditNames {
  /** "Ravi Patil", or null for an id that matches nobody now. */
  employee(id: unknown): string | null
  /** Whoever holds this login: their name, or their email when they have no record. */
  user(id: unknown): string | null
  membership(id: unknown): string | null
  documentType(code: unknown): string | null
  component(code: unknown): string | null
  leaveType(code: unknown): string | null
  report(id: unknown): string | null
}

export interface AuditRowIn {
  action: string
  entityType: string | null
  entityId: string | null
  details: Details
}

/** Whom a row is about, in words — the employee, the login, or nothing. */
function subject(row: AuditRowIn, names: AuditNames): string {
  const d = row.details
  if (d.employeeId) return names.employee(d.employeeId) ?? 'a former employee'
  if (row.entityType === 'employee') return names.employee(row.entityId) ?? 'a former employee'
  if (row.entityType === 'membership') return names.membership(row.entityId) ?? text(d.email) ?? 'a removed login'
  if (row.entityType === 'user') return names.user(row.entityId) ?? 'a removed login'
  return 'somebody'
}

const LOGIN_REFUSALS: Record<string, string> = {
  wrong_password: 'wrong password',
  not_activated: 'the account has not been activated yet',
  inactive: 'the login is turned off',
}

const MASTER_KINDS: Record<string, string> = {
  department: 'department',
  designation: 'designation',
  shift: 'shift',
}

const SALARY_KINDS: Record<string, string> = {
  first: 'first salary',
  raise: 'new salary',
  correction: 'corrected salary',
}

const POLICY_KINDS: Record<string, string> = {
  first: 'Set the first payroll rules',
  correction: 'Corrected today’s payroll rules',
  new_period: 'Changed the payroll rules',
}

/**
 * One row, as one sentence, without the actor — the table shows who did it in
 * its own column, so the sentence says what they did. Every branch reads only
 * the facts that action writes; a missing fact gives vaguer words, never a
 * crash or a code.
 */
export function summarise(row: AuditRowIn, names: AuditNames): string {
  const d = row.details
  const who = () => subject(row, names)
  // Always after a possessive — “Ravi’s Aadhaar Card”, “their own document”.
  const docType = () => names.documentType(d.type) ?? 'document'
  const leave = () => `${count(d.days, 'day')} of leave`

  switch (row.action) {
    case 'auth.login_succeeded':
      return 'Signed in'
    case 'auth.login_failed':
      return `Sign-in to ${who()} refused: ${LOGIN_REFUSALS[String(d.reason)] ?? 'the details did not match'}`
    case 'auth.logged_out':
      return 'Signed out'
    case 'auth.refresh_token_reused':
      return `${who()}’s session was used from a second place, so all their sessions were ended (${count(d.tokensRevoked, 'session')})`
    case 'auth.password_changed':
      return Number(d.sessionsEnded) > 0 ? `Changed their password, signing out everywhere (${count(d.sessionsEnded, 'session')} ended; this one signed in again)` : 'Changed their password'
    case 'auth.password_link_used':
      return d.purpose === 'reset' ? 'Set a new password from a reset link' : 'Set a password from an invitation and activated the login'

    case 'permission.denied':
      return `Was refused ${text(d.method) ?? ''} ${text(d.path) ?? 'a request'} — not allowed for ${roleLabel(d.role)}`.replace(/\s+/g, ' ')

    case 'user.invited':
      return `Invited ${text(d.email) ?? who()} as ${roleLabel(d.role)}`
    case 'user.role_changed':
      return `Changed ${who()}’s role from ${roleLabel(d.from)} to ${roleLabel(d.to)}`
    case 'user.status_changed':
      return `Changed ${who()}’s login from ${ACCOUNT_STATUS_WORDS[String(d.from)] ?? 'before'} to ${ACCOUNT_STATUS_WORDS[String(d.to)] ?? 'changed'}`
    case 'user.terminated':
      return d.employeeArchived ? `Removed ${who()}’s access and archived their employee record` : `Removed ${who()}’s access`
    case 'user.password_link_issued':
      return `Issued ${d.purpose === 'reset' ? 'a password reset' : 'an invitation'} link for ${text(d.email) ?? who()}${d.via === 'terminal' ? ', from the server terminal' : ''}`

    case 'employee.created':
      return d.withLogin ? `Added ${who()} with a ${roleLabel(d.role)} login` : `Added ${who()}`
    case 'employee.updated': {
      const fields = fieldsOf([d.fields, d.statutoryFields].flatMap((f) => (Array.isArray(f) ? f : [])))
      return fields ? `Changed ${who()}’s ${fields}` : `Changed ${who()}’s record`
    }
    case 'employee.imported':
      return `Imported ${count(d.employees, 'employee')}${Number(d.withLogin) > 0 ? `, ${count(d.withLogin, 'with a login', 'with logins')}` : ''}`

    case 'salary.set':
      return `Set ${who()}’s ${SALARY_KINDS[String(d.kind)] ?? 'salary'}: CTC ${money(d.ctc)} a year from ${day(d.effectiveFrom)}${d.previousCtc != null ? ` (was ${money(d.previousCtc)})` : ''}`
    case 'payroll.run_created':
      return `Calculated ${month(d)} payroll: ${count(d.employees, 'person', 'people')}, net ${money(d.netPayable)}`
    case 'payroll.run_recalculated': {
      const before = d.previous && typeof d.previous === 'object' ? (d.previous as Details).netPayable : undefined
      return `Recalculated ${month(d)} payroll: ${count(d.employees, 'person', 'people')}, net ${money(d.netPayable)}${before !== undefined ? ` (was ${money(before)})` : ''}`
    }
    case 'payroll.run_discarded':
      return `Discarded the ${month(d)} payroll draft (${count(d.employees, 'person', 'people')}, net ${money(d.netPayable)})`
    case 'payroll.run_approved':
      return `Approved ${month(d)} payroll: ${count(d.employees, 'person', 'people')}, net ${money(d.netPayable)}${Number(d.assumedDays) > 0 ? `, confirming ${count(d.assumedDays, 'assumed day')}` : ''}`
    case 'payroll.run_reopened':
      return `Reopened the approved ${month(d)} payroll`
    case 'payroll.run_paid':
      return `Marked ${month(d)} payroll paid on ${day(d.paidOn)}: ${count(d.employees, 'person', 'people')}, net ${money(d.netPayable)}`
    case 'payroll.tds_directive_set':
      return `Set ${who()}’s TDS to ${money(d.monthlyAmount)} a month from ${day(d.effectiveFrom)}${text(d.reason) ? ` — “${text(d.reason)}”` : ''}`
    case 'payroll.entry_set':
      return `Set ${names.component(d.component) ?? 'an amount'} of ${money(d.amount)} for ${who()}, ${month(d)}`
    case 'payroll.entry_removed':
      return `Removed ${names.component(d.component) ?? 'an amount'} of ${money(d.amount)} for ${who()}, ${month(d)}`
    case 'bank_file_template.saved':
      return `Saved the bank file format (${count(Array.isArray(d.columns) ? d.columns.length : NaN, 'column')}${d.onlyVerified ? ', verified accounts only' : ''})`

    case 'bank_account.saved':
      return `Saved ${who()}’s bank account ending ${text(d.accountEnding) ?? '????'}${d.accountChanged && text(d.previousEnding) ? ` (was ending ${text(d.previousEnding)})` : ''}${d.status === 'verified' ? ', marked verified' : ''}`
    case 'bank_account.submitted':
      return `Sent in bank account ending ${text(d.accountEnding) ?? '????'} for ${who()} to be checked`
    case 'bank_account.verified':
      return `Verified ${who()}’s bank account ending ${text(d.accountEnding) ?? '????'}`
    case 'bank_account.rejected':
      return `Rejected ${who()}’s bank account ending ${text(d.accountEnding) ?? '????'}${text(d.remarks) ? ` — “${text(d.remarks)}”` : ''}`

    case 'leave.applied_for':
      return `Applied for ${leave()} for ${who()}, ${day(d.fromDate)} to ${day(d.toDate)}`
    case 'leave.withdrawn':
      return `Withdrew ${who()}’s request for ${leave()}`
    case 'leave.approved':
      return `Approved ${leave()} for ${who()}${d.fromDate ? `, ${day(d.fromDate)} to ${day(d.toDate)}` : ''}`
    case 'leave.rejected':
      return `Rejected ${who()}’s request for ${leave()}`
    case 'leave.granted':
      return `Granted the ${text(d.label) ?? 'year’s'} leave: ${count(d.days, 'day')} to ${count(d.people, 'person', 'people')}`
    case 'leave.balance_adjusted': {
      const n = Number(d.days)
      const amount = count(Number.isFinite(n) ? Math.abs(n) : NaN, 'day')
      const what = text(d.leaveTypeName) ?? 'leave'
      return `${n < 0 ? 'Took' : 'Added'} ${amount} of ${what} ${n < 0 ? 'from' : 'to'} ${who()}’s balance${typeof d.balanceAfter === 'number' ? `, now ${d.balanceAfter}` : ''}${text(d.note) ? ` — “${text(d.note)}”` : ''}`
    }
    case 'leave.reversed':
      return `Reversed ${who()}’s approved leave, returning ${count(d.daysReturned, 'day')}`
    case 'attendance.marked':
      return `Marked ${who()} ${ATTENDANCE_WORDS[String(d.status)] ?? 'attended'} on ${day(d.date)}${typeof d.hoursWorked === 'number' ? `, ${d.hoursWorked} hours` : ''}`
    case 'attendance.imported':
      return `Imported ${count(d.rows, 'attendance row')}${d.replacedExisting ? ', replacing rows already there' : ''}`

    case 'company.updated':
      return `Changed the company’s ${fieldsOf(d.changes) || 'details'}`
    case 'policy.updated':
      return `${POLICY_KINDS[String(d.kind)] ?? 'Changed the payroll rules'}${fieldsOf(d.changes) ? ` (${fieldsOf(d.changes)})` : ''} from ${day(d.effectiveFrom)}`
    case 'pt_table.set':
      return `Set the professional tax slabs for ${text(d.state) ?? 'a state'} from ${day(d.effectiveFrom)} (${count(Array.isArray(d.slabs) ? d.slabs.length : NaN, 'slab')})`
    case 'geofence.saved':
      return `${d.created ? 'Added' : 'Changed'} the office location “${text(d.name) ?? 'unnamed'}”`
    case 'geofence.deleted':
      return `Removed the office location “${text(d.name) ?? 'unnamed'}”`
    case 'leave_type.created':
      return `Added the leave type “${text(d.name) ?? text(d.code) ?? 'unnamed'}”`
    case 'leave_type.restored':
      return `Restored the leave type “${text(d.name) ?? text(d.code) ?? 'unnamed'}”`
    case 'leave_type.updated':
      return `Changed the leave type “${names.leaveType(row.entityId) ?? names.leaveType(d.code) ?? text(d.code) ?? 'unnamed'}” (${fieldsOf(d.changes) || 'details'})`
    case 'leave_type.archived':
      return `Archived the leave type “${text(d.name) ?? text(d.code) ?? 'unnamed'}”`
    case 'holiday.added':
      return `Added the holiday “${text(d.name) ?? 'unnamed'}” on ${day(d.date)}`
    case 'holiday.changed': {
      const from = (d.from && typeof d.from === 'object' ? d.from : {}) as Details
      const to = (d.to && typeof d.to === 'object' ? d.to : {}) as Details
      return `Changed the holiday “${text(from.name) ?? 'unnamed'}” on ${day(from.date)} to “${text(to.name) ?? 'unnamed'}” on ${day(to.date)}`
    }
    case 'holiday.removed':
      return `Removed the holiday “${text(d.name) ?? 'unnamed'}” on ${day(d.date)}`
    case 'master_data.added':
      return `Added the ${MASTER_KINDS[String(d.kind)] ?? 'list entry'} “${text(d.name) ?? 'unnamed'}”`
    case 'master_data.restored':
      return `Restored the ${MASTER_KINDS[String(d.kind)] ?? 'list entry'} “${text(d.name) ?? 'unnamed'}”`
    case 'master_data.renamed':
      return `Renamed the ${MASTER_KINDS[String(d.kind)] ?? 'list entry'} “${text(d.from) ?? 'unnamed'}” to “${text(d.to) ?? 'unnamed'}”`
    case 'master_data.changed':
      return `Changed the shift “${text(d.name) ?? 'unnamed'}” (${fieldsOf(d.changes) || 'details'})`
    case 'master_data.archived':
      return `Archived the ${MASTER_KINDS[String(d.kind)] ?? 'list entry'} “${text(d.name) ?? 'unnamed'}”`
    case 'notification_settings.saved': {
      const changes = Array.isArray(d.changes) ? d.changes as { event?: unknown; enabled?: unknown }[] : []
      const words = changes.map((c) => {
        const label = typeof c.event === 'string' && isNotificationEvent(c.event) ? NOTIFICATION_EVENTS[c.event].label : 'a notice'
        return `${c.enabled ? 'on' : 'off'}: “${label}”`
      })
      return words.length ? `Turned notices ${words.join('; ')}` : 'Saved the notification settings'
    }

    case 'document_type.created':
      return `Added “${text(d.label) ?? 'a document'}” to the document checklist${d.required ? ', as required' : ''}`
    case 'document_type.updated': {
      const before = (d.before && typeof d.before === 'object' ? d.before : {}) as Details
      return `Changed “${text(before.label) ?? names.documentType(d.code) ?? 'a document'}” on the document checklist`
    }
    case 'document_type.archived':
      return `Took “${text(d.label) ?? names.documentType(d.code) ?? 'a document'}” off the document checklist`
    case 'document_type.restored':
      return `Put “${text(d.label) ?? names.documentType(d.code) ?? 'a document'}” back on the document checklist`
    case 'document.uploaded':
      return `Uploaded ${who()}’s ${docType()}${d.verified ? ', marked verified' : ''}`
    case 'document.verified':
      return `Verified ${who()}’s ${docType()}`
    case 'document.rejected':
      return `Rejected ${who()}’s ${docType()}${text(d.remarks) ? ` — “${text(d.remarks)}”` : ''}`
    case 'document.removed':
      return `Removed ${who()}’s ${docType()}${d.restored ? '; the copy it replaced is current again' : ''}`
    case 'document.downloaded':
      return d.own ? `Opened their own ${docType()}` : `Opened ${who()}’s ${docType()}`
    case 'company_document.published':
      return `Published “${text(d.title) ?? 'a document'}” for everyone`
    case 'company_document.removed':
      return `Withdrew “${text(d.title) ?? 'a document'}”`
    case 'company_document.downloaded':
      return `Opened “${text(d.title) ?? 'a company document'}”`
    case 'bank_account.proof_downloaded':
      return `Opened ${who()}’s bank proof (account ending ${text(d.accountEnding) ?? '????'})`
    case 'file.unreadable':
      return 'A stored file was missing or had been altered when it was opened'

    case 'report.exported':
      return `Exported “${names.report(d.report) ?? 'a report'}” for ${month(d)}: ${count(d.rows, 'row')}${d.departmentId || d.employeeId ? ', filtered' : ''}`
    case 'employee.exported':
      return `Exported the employee list: ${count(d.rows, 'row')}${d.withCompensation ? ', with salaries' : ''}`
    case 'attendance.exported':
      return `Exported attendance for ${day(d.date)}: ${count(d.rows, 'row')}`
    case 'payslip.downloaded':
      return d.own ? `Downloaded their own ${month(d)} payslip` : `Downloaded ${who()}’s ${month(d)} payslip`
    case 'payroll.bank_file_downloaded':
      return `Downloaded the ${month(d)} bank file: ${count(d.payments, 'payment')}, ${money(d.total)}${Number(d.excluded) > 0 ? `, ${count(d.excluded, 'person', 'people')} left out` : ''}`
    case 'audit.exported':
      return `Exported the audit log: ${count(d.rows, 'row')}`

    case 'backup.taken':
      return `The nightly backup was stored: ${count(d.tables, 'table')}, ${count(d.rows, 'row')}${d.sealed === false ? ' — NOT sealed; set BACKUP_PASSPHRASE' : ''}`
    case 'backup.failed':
      return `The backup did not complete: ${text(d.error) ?? 'see the server log'}`
    case 'backup.drill_passed':
      return `A backup was restored in full and checked: ${count(d.tables, 'table')}, ${count(d.rows, 'row')}, every one matching`
    case 'backup.drill_failed':
      return `A backup could not be restored in full: ${text(d.error) ?? 'see the server log'}`

    default:
      return actionLabel(row.action)
  }
}
