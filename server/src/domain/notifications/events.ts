/**
 * Every notice the system can send, who it goes to, and whether a company may
 * switch it off.
 *
 * Settings → Notifications is drawn from this list, and a notice is only ever
 * sent for an event named here — so the screen that says "you will be told
 * when X" and the code that tells you cannot drift apart.
 *
 * Pure: the recipients are described in words here; the service finds them.
 */

export type NotificationKind = 'leave' | 'payroll' | 'document' | 'bank' | 'account' | 'announcement' | 'system'

export interface EventRule {
  kind: NotificationKind
  group: 'Leave' | 'Requests' | 'Payroll' | 'Documents' | 'Bank accounts' | 'Employment' | 'Account'
  /** "A leave request is submitted" — what happened, for Settings. */
  label: string
  /** Who is told, in words, for Settings. */
  tells: string
  /** False for security notices: nobody may turn off "your password was changed". */
  optional: boolean
}

export const NOTIFICATION_EVENTS = {
  'leave.submitted': {
    kind: 'leave', group: 'Leave', optional: true,
    label: 'A leave request is submitted',
    tells: 'The person who decides it — their reporting manager, or the Super Admin when they have nobody above',
  },
  'leave.decided': {
    kind: 'leave', group: 'Leave', optional: true,
    label: 'A request is approved or rejected',
    tells: 'The employee who asked',
  },
  'leave.withdrawn': {
    kind: 'leave', group: 'Leave', optional: true,
    label: 'A request is withdrawn',
    tells: 'Whoever was asked to approve it',
  },
  'leave.reversed': {
    kind: 'leave', group: 'Leave', optional: true,
    label: 'Approved leave is reversed',
    tells: 'The employee whose leave it was',
  },
  'leave.balance_changed': {
    kind: 'leave', group: 'Leave', optional: true,
    label: 'Leave is added to or taken from a balance',
    tells: 'The employee whose balance it is',
  },
  'payroll.awaiting_approval': {
    kind: 'payroll', group: 'Payroll', optional: true,
    label: 'A payroll run is ready to approve',
    tells: 'The Super Admin, who approves payroll',
  },
  'payroll.approved': {
    kind: 'payroll', group: 'Payroll', optional: true,
    label: 'A payroll run is approved',
    tells: 'Accounts and the Super Admin, who pay it',
  },
  'payslip.ready': {
    kind: 'payroll', group: 'Payroll', optional: true,
    label: 'A payslip is ready',
    tells: 'The employee it belongs to',
  },
  'document.submitted': {
    kind: 'document', group: 'Documents', optional: true,
    label: 'An employee uploads a document to be checked',
    tells: 'HR, Admin and the Super Admin — whoever checks documents',
  },
  'document.decided': {
    kind: 'document', group: 'Documents', optional: true,
    label: 'A document is verified or rejected',
    tells: 'The employee it belongs to',
  },
  'company_document.published': {
    kind: 'announcement', group: 'Documents', optional: true,
    label: 'A company document is published',
    tells: 'Everybody',
  },
  'bank.submitted': {
    kind: 'bank', group: 'Bank accounts', optional: true,
    label: 'An employee sends in bank details',
    tells: 'Accounts and the Super Admin, to check them',
  },
  'bank.decided': {
    kind: 'bank', group: 'Bank accounts', optional: true,
    label: 'Bank details are verified or rejected',
    tells: 'The employee they belong to',
  },
  // A security notice: where somebody's salary goes was changed by somebody else.
  'bank.changed': {
    kind: 'bank', group: 'Bank accounts', optional: false,
    label: 'Somebody else changes an employee’s salary account',
    tells: 'The employee it belongs to',
  },
  // Requests (client §28–29): attendance corrections, working from home or on duty, overtime, profile changes.
  'request.submitted': {
    kind: 'system', group: 'Requests', optional: true,
    label: 'An employee sends a request, or withdraws one',
    tells: 'Whoever decides it — the person they report to, or HR, as Settings → Approvals says for that kind of request',
  },
  'request.decided': {
    kind: 'system', group: 'Requests', optional: true,
    label: 'A request is approved or rejected',
    tells: 'The employee who sent it',
  },
  // The employee lifecycle (client §43).
  'employment.resignation_submitted': {
    kind: 'system', group: 'Employment', optional: true,
    label: 'An employee hands in or withdraws their resignation',
    tells: 'The person who decides it — whoever they report to — and HR, who runs the exit',
  },
  'employment.resignation_decided': {
    kind: 'system', group: 'Employment', optional: true,
    label: 'A resignation is accepted or called off',
    tells: 'The employee whose resignation it is, and HR — and, when it is called off, whoever decides it',
  },
  'employment.changed': {
    kind: 'system', group: 'Employment', optional: true,
    label: 'Onboarding is complete, probation is confirmed or extended, or somebody is transferred or promoted',
    tells: 'The employee it is about',
  },
  // Client §45: "Employee created", "Employee deactivated".
  'employment.joined': {
    kind: 'system', group: 'Employment', optional: true,
    label: 'A new employee is added',
    tells: 'The person they report to, and HR who keep employee records for them',
  },
  'employment.left': {
    kind: 'system', group: 'Employment', optional: true,
    label: 'An employee leaves, or their access is removed',
    tells: 'The person they reported to, and HR who keep employee records for them',
  },
  'account.password_changed': {
    kind: 'account', group: 'Account', optional: false,
    label: 'A password is changed',
    tells: 'The person whose password it is — always, as a security notice',
  },
} as const satisfies Record<string, EventRule>

export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS

export const NOTIFICATION_EVENT_KEYS = Object.keys(NOTIFICATION_EVENTS) as NotificationEvent[]

export function isNotificationEvent(value: string): value is NotificationEvent {
  return Object.prototype.hasOwnProperty.call(NOTIFICATION_EVENTS, value)
}

/**
 * Whether an event is sent, given the company's saved switches. A switch for a
 * security notice is ignored — it is always sent.
 */
export function isEnabled(event: NotificationEvent, saved: ReadonlyMap<string, boolean>): boolean {
  const rule: EventRule = NOTIFICATION_EVENTS[event]
  if (!rule.optional) return true
  return saved.get(event) ?? true
}

/** Old notices are cleared after this long. */
export const NOTIFICATION_RETENTION_DAYS = 180
