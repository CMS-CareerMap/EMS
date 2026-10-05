import { formatDay } from './dates'

/**
 * The employee lifecycle (client §43) in the words and colours every screen
 * uses: the employee list, the profile page, the home page.
 */

export const STAGES = {
  joining_soon: { label: 'Joining soon', cls: 'bg-sky-100 text-sky-800' },
  onboarding: { label: 'Onboarding', cls: 'bg-indigo-100 text-indigo-800' },
  probation: { label: 'On probation', cls: 'bg-amber-100 text-amber-800' },
  confirmed: { label: 'Confirmed', cls: 'bg-emerald-100 text-emerald-800' },
  resigned: { label: 'Resigned', cls: 'bg-orange-100 text-orange-800' },
  notice_period: { label: 'Serving notice', cls: 'bg-rose-100 text-rose-800' },
  exit_due: { label: 'Exit due', cls: 'bg-red-100 text-red-800' },
  left: { label: 'Left', cls: 'bg-gray-200 text-gray-700' },
}

/** The order the employee list's filter offers them in — the order they happen in. */
export const STAGE_ORDER = ['joining_soon', 'onboarding', 'probation', 'confirmed', 'resigned', 'notice_period', 'exit_due', 'left']

export const stageOf = (key) => STAGES[key] ?? { label: key ?? '—', cls: 'bg-gray-100 text-gray-700' }

/** The same stages as the person reads them about themselves — "Exit due" is HR's word. */
const OWN_LABELS = { exit_due: 'Last working day passed', notice_period: 'Serving notice' }
export const ownStageOf = (key) => ({ ...stageOf(key), ...(OWN_LABELS[key] ? { label: OWN_LABELS[key] } : {}) })

/**
 * A calendar day some months on, the day kept within the shorter month —
 * as the server works out probation (31 Aug + 6 months is 28 Feb).
 */
export function addMonths(day, months) {
  const [y, m, d] = day.split('-').map(Number)
  const index = y * 12 + (m - 1) + months
  const year = Math.floor(index / 12)
  const month = (index % 12) + 1
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

/** The longest probation the company may set, and so the furthest it may be extended from today. */
export const PROBATION_MONTHS_MAX = 24

export const EXIT_REASONS = [
  ['resigned', 'Resigned'],
  ['terminated', 'Terminated'],
  ['retired', 'Retired'],
  ['contract_ended', 'Contract ended'],
  ['absconded', 'Stopped coming (absconded)'],
  ['other', 'Other'],
]

export const exitReasonLabel = (key) => EXIT_REASONS.find(([k]) => k === key)?.[1] ?? key ?? '—'

const RESIGNATION_STATUS = {
  submitted: 'Waiting for acceptance',
  accepted: 'Accepted',
  withdrawn: 'Withdrawn',
  cancelled: 'Called off',
  completed: 'Completed — they have left',
}

export const resignationStatusLabel = (key) => RESIGNATION_STATUS[key] ?? key

/** One line of somebody's employment history, from the server's event. */
export function describeEvent(event) {
  const d = event.details ?? {}
  switch (event.kind) {
    case 'onboarding_completed':
      return 'Onboarding completed'
    case 'probation_extended':
      return `Probation extended to ${formatDay(d.to)}`
    case 'confirmed':
      return 'Confirmed'
    case 'transferred': {
      if (d.via === 'edit') return `Department changed on their record: ${d.fromDepartment ?? 'No department'} → ${d.toDepartment ?? 'No department'}`
      const parts = []
      if ('toDepartment' in d) parts.push(`${d.fromDepartment ?? 'No department'} → ${d.toDepartment ?? 'No department'}`)
      if ('toManager' in d) parts.push(`reports to ${d.toManager ?? 'nobody above'}${d.fromManager ? ` (was ${d.fromManager})` : ''}`)
      return `Transferred: ${parts.join(', ')}`
    }
    case 'promoted':
      if (d.via === 'edit') return `Designation changed on their record: ${d.fromDesignation ?? 'No designation'} → ${d.toDesignation ?? 'No designation'}`
      return `Promoted: ${d.fromDesignation ?? 'No designation'} → ${d.toDesignation}`
    case 'resignation_submitted':
      return `Resignation ${d.onBehalf ? 'recorded by HR' : 'handed in'}, asking to leave on ${formatDay(d.requestedLastDay)}`
    case 'resignation_accepted':
      return `Resignation accepted — last working day ${formatDay(d.lastWorkingDay)}`
    case 'resignation_withdrawn':
      return 'Resignation withdrawn'
    case 'resignation_cancelled':
      return 'Resignation called off — staying on'
    case 'exited':
      if (d.neverJoined) return `Did not join — ${exitReasonLabel(d.reason).toLowerCase()}`
      return d.via === 'access_removed'
        ? 'Left the company — access removed under Settings → Users'
        : `Left the company — ${exitReasonLabel(d.reason).toLowerCase()}`
    default:
      return event.kind
  }
}
