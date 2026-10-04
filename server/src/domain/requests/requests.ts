import type { CalendarDate } from '../shared/dates'

/**
 * Requests (client §28–29), without a database: what each kind is called,
 * which details a profile change may touch, and the number people quote.
 */

export const REQUEST_TYPES = ['attendance_correction', 'work_from_home', 'on_duty', 'overtime', 'profile_change', 'leave_encashment'] as const
export type RequestType = (typeof REQUEST_TYPES)[number]

export type RequestApprover = 'manager' | 'hr'

export const REQUEST_LABELS: Record<RequestType, string> = {
  attendance_correction: 'Attendance correction',
  work_from_home: 'Work from home',
  on_duty: 'On duty',
  overtime: 'Overtime',
  profile_change: 'Profile change',
  leave_encashment: 'Leave encashment',
}

/** Working from home or on duty: days away from the office location. */
export const AWAY_TYPES: readonly RequestType[] = ['work_from_home', 'on_duty']

/** The most days one away request may cover — longer is a different arrangement. */
export const AWAY_DAYS_MAX = 31

/**
 * What an employee may ask to change about themselves (client §27). Their
 * department, designation, joining date and pay are not theirs to ask for here:
 * those are HR's decisions, taken on the employee record.
 */
export const PROFILE_FIELDS = [
  { key: 'fullName', label: 'Full name' },
  { key: 'phone', label: 'Phone' },
  { key: 'personalEmail', label: 'Personal email' },
  { key: 'dateOfBirth', label: 'Date of birth' },
  { key: 'nationality', label: 'Nationality' },
  { key: 'address', label: 'Address' },
  { key: 'emergencyContactName', label: 'Emergency contact' },
  { key: 'emergencyContactRelation', label: 'Emergency contact’s relation' },
  { key: 'emergencyContactPhone', label: 'Emergency contact’s phone' },
] as const

export type ProfileField = (typeof PROFILE_FIELDS)[number]['key']

export const profileFieldLabel = (key: string): string => PROFILE_FIELDS.find((f) => f.key === key)?.label ?? key

/** "REQ-0042" — the number people quote on the phone. */
export function requestNumber(n: number): string {
  return `REQ-${String(n).padStart(4, '0')}`
}

/** Calendar days from one day to another, both counted. */
export function daysCovered(from: CalendarDate, to: CalendarDate): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}
