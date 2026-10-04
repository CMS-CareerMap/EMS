import { useNavigate } from 'react-router-dom'
import { IdCard } from 'lucide-react'
import DataState from '../../components/DataState'
import { useAuthStore } from '../../stores/authStore'
import { useMyDetails } from '../../hooks/useRequests'
import { formatDay } from '../../lib/dates'
import { PROFILE_FIELDS } from '../../lib/requests'

/**
 * The caller's own personal details (client §42), in their profile. They do
 * not edit them here: a change goes as a request (client §27) to whoever
 * Settings → Approvals says — HR, to start.
 */
export default function MyDetails() {
  const query = useMyDetails()
  const navigate = useNavigate()
  const close = useAuthStore((state) => state.setProfileDrawerOpen)
  // Asked like leave: from a login that may apply for leave (Day 23).
  const asks = useAuthStore((state) => state.can('leave:apply'))
  return (
    <section aria-label="My details" className="space-y-3">
      <div className="flex items-center gap-2">
        <IdCard className="w-4 h-4 text-blue-600" />
        <h4 className="text-sm font-bold text-gray-900">My Details</h4>
      </div>
      <DataState query={query} compact>
        {(details) => (
          <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 space-y-2 text-sm">
            <dl className="grid grid-cols-1 gap-1.5">
              {PROFILE_FIELDS.filter(([key]) => key !== 'fullName').map(([key, label]) => (
                <div key={key} className="flex justify-between gap-3">
                  <dt className="text-gray-500 shrink-0">{label}</dt>
                  <dd className="font-medium text-gray-900 text-right break-words min-w-0">
                    {details[key] ? (key === 'dateOfBirth' ? formatDay(details[key]) : details[key]) : 'Not recorded'}
                  </dd>
                </div>
              ))}
            </dl>
            {asks ? <button
              onClick={() => { close(false); navigate('/requests?new=profile_change') }}
              className="mt-2 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-100 text-xs font-medium text-gray-700">
              Request an update
            </button> : <p className="text-xs text-gray-500">To change these, send a request from your employee login.</p>}
          </div>
        )}
      </DataState>
    </section>
  )
}
