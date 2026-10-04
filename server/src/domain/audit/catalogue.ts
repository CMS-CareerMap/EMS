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
  // A second login for somebody already here (Day 23): an HR login beside their employee login.
  'user.login_added': { label: 'Login added', category: 'users' },
  'user.invite_withdrawn': { label: 'Invitation withdrawn', category: 'users' },
  'user.role_changed': { label: 'Role changed', category: 'users' },
  'user.status_changed': { label: 'Login turned on or off', category: 'users' },
  'user.terminated': { label: 'User removed', category: 'users' },
  'user.password_link_issued': { label: 'Password link issued', category: 'users' },
  // Roles themselves (Day 21): what each one may do is the Super Admin's choice.
  'role.created': { label: 'Role created', category: 'users' },
  'role.updated': { label: 'Role changed', category: 'users' },
  'role.reset': { label: 'Role reset to default', category: 'users' },
  'role.deleted': { label: 'Role deleted', category: 'users' },
  // People
  'employee.created': { label: 'Employee added', category: 'people' },
  'employee.updated': { label: 'Employee record changed', category: 'people' },
  'employee.imported': { label: 'Employees imported', category: 'people' },
  // The employee lifecycle (client §43)
  'lifecycle.onboarding_completed': { label: 'Onboarding completed', category: 'people' },
  'lifecycle.probation_extended': { label: 'Probation extended', category: 'people' },
  'lifecycle.confirmed': { label: 'Confirmed after probation', category: 'people' },
  'lifecycle.transferred': { label: 'Transferred', category: 'people' },
  'lifecycle.promoted': { label: 'Promoted', category: 'people' },
  'lifecycle.resignation_submitted': { label: 'Resignation handed in', category: 'people' },
  'lifecycle.resignation_accepted': { label: 'Resignation accepted', category: 'people' },
  'lifecycle.resignation_withdrawn': { label: 'Resignation withdrawn', category: 'people' },
  'lifecycle.resignation_cancelled': { label: 'Resignation called off', category: 'people' },
  'lifecycle.exited': { label: 'Exit completed', category: 'people' },
  'lifecycle.settings_updated': { label: 'Lifecycle settings changed', category: 'settings' },
  // Requests (client §28–29)
  'request.submitted': { label: 'Request sent', category: 'time' },
  'request.approved': { label: 'Request approved', category: 'time' },
  'request.rejected': { label: 'Request rejected', category: 'time' },
  'request.withdrawn': { label: 'Request withdrawn', category: 'time' },
  'request.attachment_added': { label: 'File added to a request', category: 'documents' },
  'request.attachment_downloaded': { label: 'Request file opened', category: 'exports' },
  'request.settings_updated': { label: 'Request approval settings changed', category: 'settings' },
  'request.closed_on_leaving': { label: 'Requests closed on leaving', category: 'people' },
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
  'leave.recorded_directly': { label: 'Owner’s leave recorded', category: 'time' },
  'leave.rejected': { label: 'Leave rejected', category: 'time' },
  'leave.reversed': { label: 'Leave reversed', category: 'time' },
  'leave.granted': { label: 'Leave year granted', category: 'time' },
  'leave.balance_adjusted': { label: 'Leave balance corrected', category: 'time' },
  'attendance.marked': { label: 'Attendance marked', category: 'time' },
  'attendance.imported': { label: 'Attendance imported', category: 'time' },
  // Company rules
  'company.updated': { label: 'Company details changed', category: 'settings' },
  'company.owner_marked': { label: 'Owner marked', category: 'people' },
  'approvals.updated': { label: 'Approval settings changed', category: 'settings' },
  'policy.updated': { label: 'Payroll rules changed', category: 'settings' },
  'salary_component.pf_changed': { label: 'What counts as PF wages changed', category: 'settings' },
  'salary_component.created': { label: 'Salary component added', category: 'settings' },
  'salary_component.restored': { label: 'Salary component restored', category: 'settings' },
  'salary_component.updated': { label: 'Salary component changed', category: 'settings' },
  'salary_component.archived': { label: 'Salary component archived', category: 'settings' },
  'loan.recorded': { label: 'Loan or advance recorded', category: 'pay' },
  'loan.closed': { label: 'Loan or advance closed', category: 'pay' },
  'loan.deleted': { label: 'Loan or advance removed', category: 'pay' },
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

/**
 * What the seven built-in roles were called when they were the only ones —
 * for rows written before roles had their names stored with them (Day 21).
 */
const BUILT_IN_ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  hr: 'HR',
  manager: 'Manager',
  rm: 'Reporting Manager',
  accounts: 'Accounts',
  employee: 'Employee',
}

/**
 * A role in words, AS IT WAS when the row was written:
 *
 *   1. the name stored with the row — every row since Day 21 has one;
 *   2. for a built-in role on an older row, what it was always called then,
 *      not what the Super Admin may have renamed it to since;
 *   3. the company's name for the role today;
 *   4. only then the key itself, tidied.
 */
export function roleLabel(role: unknown, names?: Pick<AuditNames, 'role'>, storedName?: unknown): string {
  const stored = typeof storedName === 'string' && storedName.trim() ? storedName : null
  if (stored) return stored
  if (typeof role !== 'string') return 'no role'
  return BUILT_IN_ROLE_LABELS[role] ?? names?.role(role) ?? humanise(role)
}

/** Settings → Approvals (Day 22), as the log says them. */
const BACKUP_WORDS: Record<string, string> = {
  super_admin: 'the Super Admin can decide instead',
  next_up: 'the manager’s own manager can decide instead',
  none: 'requests wait for the manager',
}
const REVERSAL_WORDS: Record<string, string> = {
  manager_or_super_admin: 'the reporting manager or the Super Admin',
  super_admin_only: 'only the Super Admin',
}

const ATTENDANCE_WORDS: Record<string, string> = {
  present: 'present',
  half_day: 'on a half day',
  absent: 'absent',
  on_leave: 'on leave',
  holiday: 'on a holiday',
  weekly_off: 'on a weekly off',
}

/** Why somebody left, in words (ExitReason). */
export const EXIT_WORDS: Record<string, string> = {
  resigned: 'resigned',
  terminated: 'let go',
  retired: 'retired',
  contract_ended: 'contract ended',
  absconded: 'stopped coming',
  other: 'left',
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

const REQUEST_WORDS: Record<string, string> = {
  attendance_correction: 'attendance correction',
  work_from_home: 'work-from-home request',
  on_duty: 'on-duty request',
  overtime: 'overtime request',
  profile_change: 'profile change',
  leave_encashment: 'leave encashment request',
}

/** "attendance correction REQ-0042". */
function requestRef(d: Record<string, unknown>): string {
  return `${REQUEST_WORDS[String(d.type)] ?? 'request'} REQ-${String(d.number ?? '').padStart(4, '0')}`
}

/** ": phone 98… → 99…; address …" — the old and the new value of each (client §47). */
function changeList(value: unknown): string {
  if (!value || typeof value !== 'object') return ''
  // A field kept by name only (a private detail) is null: it is named, never valued.
  const parts = Object.entries(value as Record<string, { from?: unknown; to?: unknown } | null>).map(
    ([field, c]) => (c ? `${humanise(field)} ${shown(c.from)} → ${shown(c.to)}` : humanise(field)),
  )
  return parts.length ? `: ${parts.join('; ')}` : ''
}

/** A stored value as words: text as it is, a number as digits, a switch as on or off. */
function shown(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  return text(value) ?? '(blank)'
}

/**
 * ": grace minutes 0 → 10; accrual yearly → monthly" — from a row that kept
 * `changes` (the new values) and `before` (the old) side by side (client §47).
 * Empty when there is no `before`: older rows named the fields only.
 */
function beforeAfter(d: Details): string {
  if (!d.changes || typeof d.changes !== 'object' || !d.before || typeof d.before !== 'object') return ''
  const changes = d.changes as Record<string, unknown>
  const before = d.before as Record<string, unknown>
  return changeList(Object.fromEntries(Object.keys(changes).map((k) => [k, { from: before[k], to: changes[k] }])))
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
  /** What the company calls a role key today, or null for one it no longer has. */
  role(key: unknown): string | null
}

/** "A, B and C" — the first few of a list of words, then how many more. */
function wordsOf(value: unknown, most = 5): string {
  const items = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : []
  if (items.length === 0) return ''
  const shown = items.slice(0, most)
  const rest = items.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} more`
  if (shown.length === 1) return shown[0]!
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`
}

/** What a role change did, in clauses: renamed, moved, given, taken, widened. */
function roleChanges(d: Details): string {
  const parts: string[] = []
  if (text(d.previousName) && text(d.previousName) !== text(d.name)) parts.push(`renamed from “${text(d.previousName)}”`)
  if (d.parentChanged && text(d.parentName)) parts.push(`now under ${text(d.parentName)}`)
  if (wordsOf(d.added)) parts.push(`can now: ${wordsOf(d.added)}`)
  if (wordsOf(d.removed)) parts.push(`can no longer: ${wordsOf(d.removed)}`)
  if (wordsOf(d.scopeChanges)) parts.push(`reaches ${wordsOf(d.scopeChanges)}`)
  if (d.descriptionChanged) parts.push('description changed')
  return parts.join('; ')
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
      return `Was refused ${text(d.method) ?? ''} ${text(d.path) ?? 'a request'} — not allowed for ${roleLabel(d.role, names, d.roleName)}`.replace(/\s+/g, ' ')

    case 'user.invited':
      return `Invited ${text(d.email) ?? who()} as ${roleLabel(d.role, names, d.roleName)}`
    case 'user.invite_withdrawn':
      return `Withdrew the unused ${roleLabel(d.role, names, d.roleName)} invitation${text(d.email) ? ` for ${text(d.email)}` : ''}${d.employeeId ? ` (${who()})` : ''}`
    case 'user.login_added':
      return `Gave ${who()} ${Number(d.logins) > 1 ? 'another login' : 'a login'}, as ${roleLabel(d.role, names, d.roleName)}${text(d.email) ? ` (${text(d.email)})` : ''}`
    case 'user.role_changed':
      return `Changed ${who()}’s role from ${roleLabel(d.from, names, d.fromName)} to ${roleLabel(d.to, names, d.toName)}`

    case 'role.created': {
      const what = wordsOf(d.permissions, 4)
      const reach = wordsOf(d.reach, 6)
      return `Created the role “${text(d.name) ?? 'a role'}”${text(d.parentName) ? ` under ${text(d.parentName)}` : ''}${what ? `, which can: ${what}` : ', which can do nothing yet'}${reach ? `; reaches ${reach}` : ''}`
    }
    case 'role.updated': {
      const changes = roleChanges(d)
      return `Changed the role “${text(d.name) ?? 'a role'}”${changes ? `: ${changes}` : ''}`
    }
    case 'role.reset': {
      const changes = roleChanges(d)
      return `Reset the role “${text(d.name) ?? 'a role'}” to how it started${changes ? `: ${changes}` : ''}`
    }
    case 'role.deleted': {
      const reach = wordsOf(d.reach, 6)
      return `Deleted the role “${text(d.name) ?? 'a role'}”${reach ? `, which reached ${reach}` : ''}`
    }
    case 'user.status_changed':
      // Which login, since a person can have two (Day 23); older rows did not say.
      return `Changed ${who()}’s ${d.role ? `${roleLabel(d.role, names, d.roleName)} ` : ''}login${text(d.email) ? ` (${text(d.email)})` : ''} from ${ACCOUNT_STATUS_WORDS[String(d.from)] ?? 'before'} to ${ACCOUNT_STATUS_WORDS[String(d.to)] ?? 'changed'}`
    case 'user.terminated':
      return d.employeeArchived
        ? `Removed ${who()}’s access and archived their employee record${Number(d.loginsClosed) > 1 ? ` — all ${count(d.loginsClosed, 'login')} closed` : ''}`
        : `Removed ${who()}’s access`
    case 'user.password_link_issued':
      return `Issued ${d.purpose === 'reset' ? 'a password reset' : 'an invitation'} link for ${text(d.email) ?? who()}${d.via === 'terminal' ? ', from the server terminal' : ''}`

    case 'employee.created':
      return d.withLogin ? `Added ${who()} with a ${roleLabel(d.role, names, d.roleName)} login` : `Added ${who()}`
    case 'employee.updated': {
      const all = [d.fields, d.statutoryFields].flatMap((f) => (Array.isArray(f) ? f : [])) as unknown[]
      // A move in the company tree (Day 22) says where to.
      const moved = 'managerTo' in d
        ? d.managerTo
          ? `; now reports to ${names.employee(d.managerTo) ?? 'somebody else'}`
          : '; now has nobody above them'
        : ''
      // The work record's old and new values (client §47); the rest by name only.
      const changed = d.changes && typeof d.changes === 'object' ? (d.changes as Record<string, unknown>) : {}
      if (Object.keys(changed).length > 0) {
        const covered = new Set(Object.keys(changed).map((k) => (k === 'department' || k === 'designation' || k === 'shift' ? `${k}Id` : k)))
        covered.add('reportingManagerId')
        const others = fieldsOf(all.filter((f) => typeof f === 'string' && !covered.has(f)))
        return `Changed ${who()}’s record${changeList(changed)}${others ? `; also ${others}` : ''}${moved}`
      }
      const fields = fieldsOf(all)
      return fields ? `Changed ${who()}’s ${fields}${moved}` : `Changed ${who()}’s record${moved}`
    }
    case 'employee.imported':
      return `Imported ${count(d.employees, 'employee')}${Number(d.withLogin) > 0 ? `, ${count(d.withLogin, 'with a login', 'with logins')}` : ''}`

    case 'lifecycle.onboarding_completed':
      return `Completed ${who()}’s onboarding`
    case 'lifecycle.probation_extended':
      return `Extended ${who()}’s probation to ${day(d.to)}${d.from ? ` (was ${day(d.from)})` : ''}`
    case 'lifecycle.confirmed':
      return `Confirmed ${who()} from ${day(d.confirmedOn)}`
    case 'lifecycle.transferred':
      return `Transferred ${who()}${text(d.toDepartment) ? ` to ${text(d.toDepartment)}` : ''}${text(d.fromDepartment) ? ` from ${text(d.fromDepartment)}` : ''}, from ${day(d.effectiveDate)}`
    case 'lifecycle.promoted':
      return `Promoted ${who()} to ${text(d.toDesignation) ?? 'a new designation'}${text(d.fromDesignation) ? ` from ${text(d.fromDesignation)}` : ''}, from ${day(d.effectiveDate)}`
    case 'lifecycle.resignation_submitted':
      return d.onBehalf ? `Recorded ${who()}’s resignation, asking to leave on ${day(d.requestedLastDay)}` : `Handed in their resignation, asking to leave on ${day(d.requestedLastDay)}`
    case 'lifecycle.resignation_accepted':
      return `Accepted ${who()}’s resignation; last working day ${day(d.lastWorkingDay)}${d.asBackup ? ' (standing in)' : ''}`
    case 'lifecycle.resignation_withdrawn':
      return 'Withdrew their resignation'
    case 'lifecycle.resignation_cancelled':
      return `Called off ${who()}’s resignation — they are staying`
    case 'lifecycle.exited':
      return `Completed ${who()}’s exit: last working day ${day(d.lastWorkingDate)}, ${EXIT_WORDS[String(d.reason)] ?? 'left'}${Number(d.loginsClosed) > 0 ? `, ${count(d.loginsClosed, 'login')} closed` : ''}`
    case 'request.submitted':
      return `${d.recordedDirectly ? 'Recorded' : 'Sent'} ${requestRef(d)}${d.recordedDirectly ? ' (the owner’s: no approval needed)' : ''}`
    case 'request.approved':
      return `Approved ${who()}’s ${requestRef(d)}${d.asBackup ? ', standing in' : ''}${changeList(d.changes)}`
    case 'request.rejected':
      return `Rejected ${who()}’s ${requestRef(d)}${text(d.note) ? `: ${text(d.note)}` : ''}`
    case 'request.withdrawn':
      return `Withdrew ${requestRef(d)}`
    case 'request.attachment_added':
      return `Added ${text(d.fileName) ?? 'a file'} to REQ-${String(d.number ?? '').padStart(4, '0')}`
    case 'request.attachment_downloaded':
      return `Opened ${text(d.fileName) ?? 'the file'} of REQ-${String(d.number ?? '').padStart(4, '0')}`
    case 'request.closed_on_leaving':
      return `Closed ${count(d.closed, 'waiting request')} of ${who()}, who has left`
    case 'request.settings_updated':
      return 'Changed who decides each kind of request'
    case 'lifecycle.settings_updated':
      return `Set probation to ${count(d.probationMonths, 'month')} and the notice period to ${count(d.noticePeriodDays, 'day')}`

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
      return `Approved ${leave()} for ${who()}${d.fromDate ? `, ${day(d.fromDate)} to ${day(d.toDate)}` : ''}${d.asBackup ? ', standing in for their reporting manager' : ''}`
    case 'leave.recorded_directly':
      return `Recorded ${leave()} for ${who()}${d.fromDate ? `, ${day(d.fromDate)} to ${day(d.toDate)}` : ''} — the owner’s leave needs no approval`
    case 'leave.rejected':
      return `Rejected ${who()}’s request for ${leave()}${d.asBackup ? ', standing in for their reporting manager' : ''}`
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
    case 'company.owner_marked': {
      const before = names.employee(d.previousOwnerId)
      return `Marked ${who()} as the owner, at the top of the company tree${before ? ` (was ${before})` : ''}${'managerFrom' in d ? `; they no longer report to ${names.employee(d.managerFrom) ?? 'anybody'}` : ''}`
    }
    case 'approvals.updated': {
      const parts: string[] = []
      const changes = (d.changes && typeof d.changes === 'object' ? d.changes : {}) as Details
      if ('noManagerApprover' in changes) parts.push(`leave of people with nobody above now goes to ${d.noManagerApproverId ? (names.employee(d.noManagerApproverId) ?? 'a chosen person') : 'the Super Admin'}`)
      if ('backup' in changes) parts.push(`when a manager is away, ${BACKUP_WORDS[String(d.backup)] ?? 'the backup changed'}`)
      if ('reversal' in changes) parts.push(`approved leave can be cancelled by ${REVERSAL_WORDS[String(d.reversal)] ?? 'somebody else'}`)
      return parts.length ? `Changed the approval settings: ${parts.join('; ')}` : 'Changed the approval settings'
    }
    case 'policy.updated':
      return `${POLICY_KINDS[String(d.kind)] ?? 'Changed the payroll rules'}${fieldsOf(d.changes) ? ` (${fieldsOf(d.changes)})` : ''} from ${day(d.effectiveFrom)}`
    case 'salary_component.pf_changed':
      return `${d.countsForPf ? 'Counted' : 'Stopped counting'} ${text(d.label) ?? 'a salary component'} as PF wages`
    case 'salary_component.created':
      return `Added the salary component “${text(d.label) ?? text(d.code) ?? 'unnamed'}” (${text(d.code) ?? '?'})`
    case 'salary_component.restored':
      return `Restored the salary component “${text(d.label) ?? text(d.code) ?? 'unnamed'}” (${text(d.code) ?? '?'})`
    case 'salary_component.updated':
      return `Changed the salary component ${text(d.code) ?? 'unnamed'}${beforeAfter(d) || ` (${fieldsOf(d.changes) || 'details'})`}`
    case 'salary_component.archived':
      return `Archived the salary component “${text(d.label) ?? text(d.code) ?? 'unnamed'}”`
    case 'loan.recorded':
      return `Recorded ${d.kind === 'advance' ? 'a salary advance' : 'a loan'} of ${money(d.amount)} for ${who()}, recovered ${money(d.installment)} a month from ${month({ year: d.startYear, month: d.startMonth })}`
    case 'loan.closed':
      return `Closed ${d.kind === 'advance' ? 'the salary advance' : 'the loan'} of ${who()} with ${money(d.left)} still owed${text(d.note) ? `: ${text(d.note)}` : ''}`
    case 'loan.deleted':
      return `Removed ${d.kind === 'advance' ? 'a salary advance' : 'a loan'} of ${money(d.amount)} recorded for ${who()} — nothing had been recovered`
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
      return `Changed the leave type “${names.leaveType(row.entityId) ?? names.leaveType(d.code) ?? text(d.code) ?? 'unnamed'}”${beforeAfter(d) || ` (${fieldsOf(d.changes) || 'details'})`}`
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
      return `Changed the shift “${text(d.name) ?? 'unnamed'}”${beforeAfter(d) || ` (${fieldsOf(d.changes) || 'details'})`}`
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
