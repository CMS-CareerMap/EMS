import { useState } from 'react'
import { Link } from 'react-router-dom'
import { UserMinus, ChevronRight } from 'lucide-react'
import DataState, { QueryError } from '../../components/DataState'
import { useLifecycleSummary, useWaitingResignations } from '../../hooks/useLifecycle'
import { AcceptResignationDialog, CancelResignationDialog } from '../employees/LifecycleDialogs'
import { formatDay } from '../../lib/dates'

/**
 * The employee lifecycle on the dashboards (client §43): who needs HR, and the
 * resignations waiting for the person they report to.
 */

/** Each group: its name, what it means, what its date is, and its colour. */
const GROUPS = [
  ['exit_due', 'Exit due', 'Past their last working day — complete the exit', 'last day', 'bg-red-50 text-red-700'],
  ['resigned', 'Resigned', 'Waiting for the person they report to', 'asks to leave', 'bg-orange-50 text-orange-700'],
  ['probation_ending', 'Probation ending', 'Within 30 days, or already past — confirm or extend', 'ends', 'bg-amber-50 text-amber-700'],
  ['onboarding', 'Onboarding', 'Joined, onboarding not completed', 'joined', 'bg-indigo-50 text-indigo-700'],
  ['joining_soon', 'Joining soon', 'A joining date still ahead', 'joins', 'bg-sky-50 text-sky-700'],
  ['serving_notice', 'Serving notice', 'Resignation accepted; last working day not passed yet', 'last day', 'bg-rose-50 text-rose-700'],
]

/** For HR: everybody at a step that is theirs to take, within their reach. */
export function LifecycleCard() {
  const summary = useLifecycleSummary()
  return (
    <section aria-label="Employee lifecycle" className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-gray-100">
        <p className="text-base font-semibold text-gray-900">Employee Lifecycle</p>
        <p className="text-xs text-gray-400 mt-0.5">Joining to exit — who needs a step from HR</p>
      </div>
      <DataState query={summary} compact>
        {(data) => {
          const groups = GROUPS.filter(([key]) => data[key].length > 0)
          if (groups.length === 0) return <p className="px-5 py-8 text-center text-sm text-gray-400">Nobody needs a step right now.</p>
          return (
            <div className="divide-y divide-gray-100">
              {groups.map(([key, label, hint, when, cls]) => (
                <div key={key} className="px-5 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-gray-800">{label}</p>
                    <span className={`px-2 py-0.5 rounded-full text-xs font-semibold ${cls}`}>{data[key].length}</span>
                  </div>
                  <p className="text-xs text-gray-400">{hint}</p>
                  <ul className="mt-1.5 space-y-1">
                    {data[key].slice(0, 5).map((p) => (
                      <li key={p.employee_id}>
                        <Link to={`/employees?open=${p.employee_id}`} className="flex items-center justify-between gap-2 text-sm text-gray-700 hover:text-blue-700">
                          <span className="truncate">{p.full_name}{p.department ? <span className="text-gray-400"> · {p.department}</span> : null}</span>
                          <span className="flex items-center gap-1 text-xs text-gray-500 shrink-0">{p.date ? `${when} ${formatDay(p.date)}` : ''} <ChevronRight className="w-3.5 h-3.5" /></span>
                        </Link>
                      </li>
                    ))}
                    {data[key].length > 5 && (
                      <li><Link to="/employees" className="text-xs text-blue-600 hover:underline">and {data[key].length - 5} more, on the Employees page</Link></li>
                    )}
                  </ul>
                </div>
              ))}
            </div>
          )
        }}
      </DataState>
    </section>
  )
}

/**
 * Resignations the caller accepts, as the person their writer reports to —
 * whatever the caller's role, as with leave. Nothing at all while there are none.
 */
export function WaitingResignations() {
  const waiting = useWaitingResignations()
  const [dialog, setDialog] = useState(null)

  if (waiting.isError) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm">
        <p className="px-5 pt-4 text-sm font-semibold text-gray-900">Resignations waiting for you</p>
        <QueryError error={waiting.error} onRetry={() => waiting.refetch()} retrying={waiting.isFetching} compact />
      </div>
    )
  }
  const rows = waiting.data ?? []
  if (rows.length === 0) return null

  return (
    <section aria-label="Resignations waiting for you" className="bg-white rounded-xl border border-orange-200 shadow-sm overflow-hidden">
      <div className="flex items-center gap-2 px-5 py-4 border-b border-orange-100 bg-orange-50">
        <UserMinus className="w-4 h-4 text-orange-700" aria-hidden="true" />
        <p className="text-sm font-semibold text-orange-900">
          {rows.length} resignation{rows.length === 1 ? '' : 's'} waiting for you
        </p>
      </div>
      <div className="divide-y divide-gray-100">
        {rows.map((r) => (
          <div key={r.id} className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-gray-900">
                {r.full_name}
                <span className="font-normal text-gray-400"> · {[r.designation, r.department].filter(Boolean).join(', ') || r.employee_code}</span>
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Handed in {formatDay(r.submitted_on)} · asks to leave {formatDay(r.requested_last_day)}
                {r.as_backup && ` · standing in for ${r.decided_by}`}
              </p>
              <p className="text-xs text-gray-600 mt-0.5 italic truncate">“{r.reason}”</p>
            </div>
            <div className="flex gap-2 shrink-0">
              <button onClick={() => setDialog({ kind: 'accept', r })}
                className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium">
                Accept
              </button>
              <button onClick={() => setDialog({ kind: 'cancel', r })}
                className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium">
                Call off
              </button>
            </div>
          </div>
        ))}
      </div>
      {dialog?.kind === 'accept' && <AcceptResignationDialog resignation={dialog.r} name={dialog.r.full_name} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'cancel' && <CancelResignationDialog resignationId={dialog.r.id} name={dialog.r.full_name} accepted={false} onClose={() => setDialog(null)} />}
    </section>
  )
}
