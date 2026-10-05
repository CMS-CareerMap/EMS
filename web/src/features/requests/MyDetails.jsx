import { useNavigate } from 'react-router-dom'
import { IdCard } from 'lucide-react'
import DataState from '../../components/DataState'
import { useAuthStore } from '../../stores/authStore'
import { useMyDetails } from '../../hooks/useRequests'
import { formatDay } from '../../lib/dates'
import { PROFILE_FIELDS } from '../../lib/requests'
import { btn } from '../../components/ui/styles'

/**
 * The caller's own personal details (client §42), in their profile. They do
 * not edit them here: a change goes as a request (client §27) to whoever
 * Settings → Approvals says — HR, to start.
 */
export default function MyDetails() {
  const query = useMyDetails()
  const navigate = useNavigate()
  // Asked like leave: from a login that may apply for leave (Day 23).
  const asks = useAuthStore((state) => state.can('leave:apply'))
  return (
    <section aria-label="My details" className="space-y-3">
      <div className="flex items-center gap-2">
        <IdCard className="w-4 h-4 text-brand-600" aria-hidden="true" />
        <h2 className="text-sm font-bold text-gray-900">My Details</h2>
      </div>
      <DataState query={query} compact>
        {(details) => (
          <div className="space-y-4 text-sm">
            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3">
              {PROFILE_FIELDS.filter(([key]) => key !== 'fullName').map(([key, label]) => (
                <div key={key} className="min-w-0">
                  <dt className="text-xs font-semibold text-gray-500">{label}</dt>
                  <dd className="font-semibold text-gray-900 mt-0.5 wrap-break-word">
                    {details[key] ? (key === 'dateOfBirth' ? formatDay(details[key]) : details[key]) : 'Not recorded'}
                  </dd>
                </div>
              ))}
            </dl>
            {asks ? (
              <button onClick={() => navigate('/requests?new=profile_change')} className={btn.soft}>
                Request an update
              </button>
            ) : <p className="text-xs text-gray-500">To change these, send a request from your employee login.</p>}
          </div>
        )}
      </DataState>
    </section>
  )
}
