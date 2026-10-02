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
  group: 'Leave' | 'Payroll' | 'Documents' | 'Bank accounts' | 'Account'
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
