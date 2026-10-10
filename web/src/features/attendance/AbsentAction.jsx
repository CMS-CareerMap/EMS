import { CalendarPlus } from 'lucide-react'
import { Chip } from '../../components/ui/bits'

/**
 * Beside an absent day of one's own (client, 10 Oct 2026): "Apply leave" —
 * the leave form on that day — so somebody with leave left need not lose the
 * day's pay. The day stays Absent until leave for it is approved; nothing is
 * turned into Loss of Pay by itself. Leave already asked for says how it
 * stands — waiting, or approved for part of it (a half day, or a day with a
 * punch, stays Absent beside it); a day leave can no longer be asked for says
 * why (its month paid, or too long ago).
 */
export default function AbsentAction({ absent, day, onApply }) {
  if (!absent) return null
  if (absent.applied) {
    const leave = absent.leave
    return leave?.status === 'approved'
      ? <Chip tone="leave" dot={false}>{leave.half ? '½ ' : ''}{leave.leave_type_name} approved</Chip>
      : <Chip tone="leave" dot={false}>Leave applied · waiting</Chip>
  }
  if (absent.can_apply && onApply) {
    return (
      <button type="button" onClick={() => onApply(day)} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline">
        <CalendarPlus className="w-3.5 h-3.5" aria-hidden="true" />Apply leave
      </button>
    )
  }
  return absent.why ? <span className="text-[11px] text-gray-400">{absent.why}</span> : null
}
