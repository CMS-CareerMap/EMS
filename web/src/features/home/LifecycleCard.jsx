import { Link } from 'react-router-dom'
import { ChevronRight } from 'lucide-react'
import DataState from '../../components/DataState'
import { Avatar, Card, CardLink, Chip } from '../../components/ui/bits'
import { useLifecycleSummary } from '../../hooks/useLifecycle'
import { formatDay } from '../../lib/dates'

/**
 * Joining to exit (client §43): who needs a step from HR, within their reach.
 * Each group says what it means and what its date is.
 */
const GROUPS = [
  ['exit_due', 'Exit due', 'Past their last working day — complete the exit', 'last day', 'bad'],
  ['resigned', 'Resigned', 'Waiting for the person they report to', 'asks to leave', 'warn'],
  ['probation_ending', 'Probation ending', 'Within 30 days, or already past — confirm or extend', 'ends', 'warn'],
  ['onboarding', 'Onboarding', 'Joined, onboarding not completed', 'joined', 'brand'],
  ['joining_soon', 'Joining soon', 'A joining date still ahead', 'joins', 'info'],
  ['serving_notice', 'Serving notice', 'Resignation accepted; last working day not passed yet', 'last day', 'leave'],
]

export default function LifecycleCard() {
  const summary = useLifecycleSummary()
  return (
    <Card title="Joining to exit" subtitle="Who needs a step from HR" action={<CardLink to="/employees">Employees</CardLink>}>
      <DataState query={summary} compact>
        {(data) => {
          const groups = GROUPS.filter(([key]) => data[key].length > 0)
          if (groups.length === 0) return <p className="py-6 text-center text-sm text-gray-500">Nobody needs a step right now.</p>
          return (
            <div className="space-y-4">
              {groups.map(([key, label, hint, when, tone]) => (
                <section key={key} aria-label={label}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10.5px] font-extrabold uppercase tracking-wider text-gray-400">{label}</p>
                    <Chip tone={tone} dot={false}>{data[key].length}</Chip>
                  </div>
                  <p className="text-xs text-gray-400 mb-1.5">{hint}</p>
                  <ul className="space-y-1">
                    {data[key].slice(0, 4).map((p) => (
                      <li key={p.employee_id}>
                        <Link to={`/employees/${p.employee_id}?tab=employment`} className="flex items-center gap-2.5 rounded-lg px-1 py-1.5 -mx-1 hover:bg-gray-50 group">
                          <Avatar name={p.full_name} size="sm" />
                          <span className="min-w-0 flex-1">
                            <span className="block text-[13px] font-semibold text-gray-900 truncate group-hover:text-brand-700">{p.full_name}</span>
                            <span className="block text-xs text-gray-500 truncate">{[p.department, p.date ? `${when} ${formatDay(p.date)}` : null].filter(Boolean).join(' · ')}</span>
                          </span>
                          <ChevronRight className="w-4 h-4 text-gray-300 group-hover:text-gray-500 shrink-0" aria-hidden="true" />
                        </Link>
                      </li>
                    ))}
                    {data[key].length > 4 && (
                      <li><Link to="/employees" className="text-xs font-semibold text-brand-600 hover:underline">and {data[key].length - 4} more, on the Employees page</Link></li>
                    )}
                  </ul>
                </section>
              ))}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}
