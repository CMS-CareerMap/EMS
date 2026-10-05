import { Banknote, Briefcase, Clock, Home, Timer, UserPen } from 'lucide-react'

/**
 * Each kind of request with its icon, a tone, and what it is for in a line —
 * for the chooser a new request starts from, and every list that shows one.
 */
export const REQUEST_KINDS = {
  attendance_correction: { icon: Clock, tone: 'brand', hint: 'A check-in or check-out that is missing or wrong' },
  work_from_home: { icon: Home, tone: 'info', hint: 'Work from home on some days' },
  on_duty: { icon: Briefcase, tone: 'ok', hint: 'Company work away from the office — a client visit, travel' },
  overtime: { icon: Timer, tone: 'warn', hint: 'Be paid for time worked past your shift' },
  leave_encashment: { icon: Banknote, tone: 'leave', hint: 'Turn unused leave into pay' },
  profile_change: { icon: UserPen, tone: 'gray', hint: 'Change your phone, address or other details' },
}

export const kindOf = (type) => REQUEST_KINDS[type] ?? { icon: Clock, tone: 'gray', hint: '' }

/** A request's status as a chip tone. */
export const REQUEST_TONE = { pending: 'warn', approved: 'ok', rejected: 'bad', withdrawn: 'gray' }
