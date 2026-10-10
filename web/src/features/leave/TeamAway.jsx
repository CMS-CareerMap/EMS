import { Users } from 'lucide-react'
import { formatDay } from '../../lib/dates'

/**
 * Who else of the asker's team is away on the days a waiting request asks for
 * (client, 10 Oct 2026) — under a request whoever decides it sees, so a third
 * person off the same week is a decision made knowingly. The server sends
 * `team_away` on the lists of those who decide; null elsewhere, and nothing is
 * drawn then. An empty list says so: it was looked at, and nobody is.
 */
const span = (from, to) => (from === to ? formatDay(from, { year: false }) : `${formatDay(from, { year: false })} – ${formatDay(to, { year: false })}`)

export default function TeamAway({ req }) {
  if (req.status !== 'pending' || !Array.isArray(req.team_away)) return null
  if (req.team_away.length === 0) {
    return <p className="text-xs text-gray-400 flex items-center gap-1"><Users className="w-3 h-3 shrink-0" aria-hidden="true" />Nobody else in the team is away then</p>
  }
  return (
    <p className="text-xs text-amber-800 flex items-start gap-1">
      <Users className="w-3 h-3 shrink-0 mt-0.5" aria-hidden="true" />
      <span>
        Also away:{' '}
        {req.team_away.map((a, i) => (
          <span key={`${a.employee_id}-${a.from_date}`}>
            {i > 0 && ' · '}
            <b className="font-semibold">{a.full_name}</b> ({a.leave_type_name}{a.status === 'pending' ? ', waiting' : ''}, {span(a.from_date, a.to_date)})
          </span>
        ))}
      </span>
    </p>
  )
}
