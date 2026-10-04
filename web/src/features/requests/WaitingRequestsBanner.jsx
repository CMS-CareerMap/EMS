import { Link } from 'react-router-dom'
import { Inbox } from 'lucide-react'
import { useWaitingRequests } from '../../hooks/useRequests'

/**
 * "N requests waiting for you" on a dashboard — for whoever decides them, the
 * person somebody reports to or HR, whatever their role. Nothing at all while
 * none wait; a failure to load is left to the Requests page to explain.
 */
export default function WaitingRequestsBanner() {
  const waiting = useWaitingRequests()
  const count = waiting.data?.length ?? 0
  if (count === 0) return null
  return (
    <Link to="/requests?tab=decide" className="flex items-center gap-3 rounded-xl border border-indigo-200 bg-indigo-50 px-5 py-4 hover:bg-indigo-100 transition-colors">
      <Inbox className="w-5 h-5 text-indigo-600 shrink-0" aria-hidden="true" />
      <p className="text-sm text-indigo-900">
        <span className="font-semibold">{count} request{count === 1 ? '' : 's'} waiting for you</span> — corrections, work from home or on duty, overtime, leave encashment, profile changes. Open Requests to decide.
      </p>
    </Link>
  )
}
