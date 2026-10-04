import { formatDay } from './dates'

/** Requests (client §28–29) in the words and colours every screen uses. */

export const REQUEST_TYPES = [
  ['attendance_correction', 'Attendance correction'],
  ['work_from_home', 'Work from home'],
  ['on_duty', 'On duty'],
  ['overtime', 'Overtime'],
  ['leave_encashment', 'Leave encashment'],
  ['profile_change', 'Profile change'],
]

export const typeLabel = (type) => REQUEST_TYPES.find(([key]) => key === type)?.[1] ?? type

/** "1h 30m", "45m". */
export function minutesLabel(minutes) {
  const m = Number(minutes) || 0
  const h = Math.floor(m / 60)
  return h > 0 ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m % 60}m`
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

export const STATUS = {
  pending: { label: 'Waiting', cls: 'bg-amber-100 text-amber-800' },
  approved: { label: 'Approved', cls: 'bg-emerald-100 text-emerald-800' },
  rejected: { label: 'Rejected', cls: 'bg-rose-100 text-rose-800' },
  withdrawn: { label: 'Withdrawn', cls: 'bg-gray-100 text-gray-600' },
}

export const statusOf = (status) => STATUS[status] ?? { label: status, cls: 'bg-gray-100 text-gray-600' }

/** The details a profile change may touch, in the order a form shows them. */
export const PROFILE_FIELDS = [
  ['fullName', 'Full name'],
  ['phone', 'Phone'],
  ['personalEmail', 'Personal email'],
  ['dateOfBirth', 'Date of birth'],
  ['nationality', 'Nationality'],
  ['address', 'Address'],
  ['emergencyContactName', 'Emergency contact'],
  ['emergencyContactRelation', 'Emergency contact’s relation'],
  ['emergencyContactPhone', 'Emergency contact’s phone'],
]

const fieldLabel = (key) => PROFILE_FIELDS.find(([k]) => k === key)?.[1] ?? key

/** "Work mode" words, for attendance rows and the punch card (client §33). */
export const WORK_MODES = {
  office: 'Office',
  wfh: 'Work from home',
  on_duty: 'On duty',
  remote: 'Remote',
}

/** What a request asks, in one line. */
export function summaryOf(r) {
  const days = r.from_date ? (r.from_date === r.to_date ? formatDay(r.from_date) : `${formatDay(r.from_date)} – ${formatDay(r.to_date)}`) : ''
  const d = r.details ?? {}
  switch (r.type) {
    case 'attendance_correction':
      return `${days}: ${[d.checkIn ? `in ${d.checkIn}` : null, d.checkOut ? `out ${d.checkOut}` : null].filter(Boolean).join(', ')}`
    case 'work_from_home':
    case 'on_duty':
      return days
    case 'overtime':
      return `${days}: ${minutesLabel(d.minutes)} past the shift${d.payMonth ? `, paid with ${MONTH_NAMES[d.payMonth - 1]} ${d.payYear} salary` : ''}`
    case 'leave_encashment':
      return `${d.days} day${d.days === 1 ? '' : 's'} of ${d.leaveTypeName ?? 'leave'}${d.payMonth ? `, paid with ${MONTH_NAMES[d.payMonth - 1]} ${d.payYear} salary` : ''}`
    case 'profile_change':
      // Only which details, to whoever may not read personal details.
      if (d.fields) return `Changes to: ${d.fields.map(fieldLabel).join(', ')}`
      return Object.entries(d.changes ?? {})
        .map(([key, value]) => `${fieldLabel(key)}: ${d.before?.[key] ?? '—'} → ${value ?? '—'}`)
        .join(' · ')
    default:
      return days
  }
}
