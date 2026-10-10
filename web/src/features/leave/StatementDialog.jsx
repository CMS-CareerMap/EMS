import Dialog from '../../components/Dialog'
import DataState from '../../components/DataState'
import { useLeaveStatement } from '../../hooks/useLeave'
import { useAuthStore } from '../../stores/authStore'
import { formatDay, formatDayOf } from '../../lib/dates'

/**
 * A leave type's statement for the year, like a passbook (client, 10 Oct
 * 2026): every time days were given, carried, taken, given back, corrected by
 * HR (with the reason the person was told) or encashed — and the balance after
 * each, so "why do I have 4.5 days?" answers itself. Days applied for and not
 * yet decided are not on it: nothing has moved for them yet.
 *
 * For an unpaid type with no limit (Loss of Pay) there is no balance, only
 * days taken — said that way.
 */

const dayCount = (n) => `${n} day${Math.abs(n) === 1 ? '' : 's'}`
const span = (from, to) => (from === to ? formatDay(from) : `${formatDay(from, { year: false })} – ${formatDay(to)}`)

/** What one line was, in words. */
function lineWords(l) {
  const leave = l.from_date ? ` (${span(l.from_date, l.to_date)})` : ''
  switch (l.reason) {
    case 'opening_grant':
      return l.note ?? (l.days > 0 ? 'Given for the year' : 'Taken off the year’s grant')
    case 'carry_forward':
      return l.days > 0 ? 'Carried in from last year' : 'Carried to next year'
    case 'consumed':
      return `Leave taken${leave}`
    case 'reversal':
      return `Given back: leave cancelled${leave}${l.note && l.note !== 'Approved leave reversed' ? ` — ${l.note}` : ''}`
    case 'adjustment':
      return `Corrected by HR${l.note ? ` — “${l.note}”` : ''}`
    case 'encashed':
      return 'Turned into pay (encashed)'
    default:
      return l.note ?? l.reason
  }
}

export default function StatementDialog({ leaveTypeId, title, employeeId = null, onClose }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const statement = useLeaveStatement({ leaveTypeId, employeeId })

  return (
    <Dialog title={title} onClose={onClose}>
      <DataState query={statement} compact>
        {(s) => (
            <div className="space-y-3">
              <p className="text-sm text-gray-600">
                {s.label} · {s.unlimited ? `${dayCount(s.taken)} taken — unpaid, cut from pay` : `Balance now: ${dayCount(s.balance)}`}
              </p>
              {s.lines.length === 0 ? (
                <p className="text-sm text-gray-500">Nothing has been given or taken this leave year yet.</p>
              ) : (
                <ol className="divide-y divide-gray-100 border border-gray-100 rounded-lg max-h-[55vh] overflow-y-auto" aria-label="Statement">
                  {s.lines.map((l) => (
                    <li key={l.id} className="px-3 py-2.5 flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-sm text-gray-900">{lineWords(l)}</p>
                        <p className="text-xs text-gray-400">{formatDayOf(l.at, timezone)}</p>
                      </div>
                      <div className="text-right shrink-0 tabular-nums">
                        <p className={`text-sm font-bold ${l.days < 0 ? 'text-red-700' : 'text-emerald-700'}`}>{l.days > 0 ? `+${l.days}` : l.days}</p>
                        {!s.unlimited && <p className="text-[11px] text-gray-400">left {l.balance}</p>}
                      </div>
                    </li>
                  ))}
                </ol>
              )}
              <p className="text-xs text-gray-500">Days applied for and not yet decided are not taken off here until they are approved.</p>
            </div>
        )}
      </DataState>
    </Dialog>
  )
}
