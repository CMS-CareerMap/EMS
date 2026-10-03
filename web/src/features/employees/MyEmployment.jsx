import { useState } from 'react'
import { toast } from 'sonner'
import { BriefcaseBusiness } from 'lucide-react'
import DataState from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import { useMyLifecycle, useResignationAction } from '../../hooks/useLifecycle'
import { formatDay } from '../../lib/dates'
import { ownStageOf, resignationStatusLabel } from '../../lib/lifecycle'
import { ResignDialog } from './LifecycleDialogs'

/**
 * "My employment" in one's own profile (client §43): where they stand, and
 * their resignation — handed in here, and withdrawn here until it is accepted.
 */
export default function MyEmployment() {
  const query = useMyLifecycle()
  return (
    <section aria-label="My employment" className="space-y-3">
      <div className="flex items-center gap-2">
        <BriefcaseBusiness className="w-4 h-4 text-blue-600" />
        <h4 className="text-sm font-bold text-gray-900">My Employment</h4>
      </div>
      <DataState query={query} compact>
        {(view) => <Mine view={view} />}
      </DataState>
    </section>
  )
}

function Mine({ view }) {
  const [dialog, setDialog] = useState(null)
  const action = useResignationAction()
  const stage = ownStageOf(view.stage)
  const r = view.resignation
  const open = r && ['submitted', 'accepted'].includes(r.status) ? r : null

  return (
    <div className="bg-gray-50 rounded-xl p-4 border border-gray-100 space-y-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${stage.cls}`}>{stage.label}</span>
        {view.stage === 'probation' && view.probation_end_date && <span className="text-xs text-gray-500">until {formatDay(view.probation_end_date)}</span>}
        {view.stage === 'confirmed' && view.confirmed_on && <span className="text-xs text-gray-500">since {formatDay(view.confirmed_on)}</span>}
      </div>

      {view.stage === 'joining_soon' && <p className="text-xs text-gray-600">You join on {formatDay(view.date_of_joining)}.</p>}
      {view.stage === 'onboarding' && <p className="text-xs text-gray-600">HR is completing your onboarding. Your documents and bank account help it along.</p>}
      {/* A last day set without an accepted resignation of theirs — a contract's end, say — is still theirs to know. */}
      {view.last_working_date && open?.status !== 'accepted' && (
        <p className="text-xs text-gray-700">Your last working day: <span className="font-semibold">{formatDay(view.last_working_date)}</span>.</p>
      )}

      {open && (
        <div className="space-y-1 text-xs border-t border-gray-200 pt-3">
          <p className="font-semibold text-gray-700">Resignation · {resignationStatusLabel(open.status)}</p>
          <p className="text-gray-500">
            Handed in {formatDay(open.submitted_on)} · you asked to leave on {formatDay(open.requested_last_day)}
          </p>
          {open.status === 'submitted' && open.decided_by_whom && <p className="text-gray-500">Waiting for {open.decided_by_whom} to accept it.</p>}
          {open.status === 'accepted' && (
            <p className="text-gray-700">Accepted by {open.decided_by ?? 'the person you report to'}. Your last working day is <span className="font-semibold">{formatDay(open.last_working_day)}</span>.</p>
          )}
        </div>
      )}

      {(view.may.resign || view.may.withdraw) && (
        <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-3">
          {view.may.resign && (
            <button onClick={() => setDialog('resign')} className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-100 text-xs font-medium text-gray-700">
              Hand in resignation
            </button>
          )}
          {view.may.withdraw && (
            <button onClick={() => setDialog('withdraw')} className="px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-100 text-xs font-medium text-gray-700">
              Withdraw resignation
            </button>
          )}
        </div>
      )}

      {dialog === 'resign' && <ResignDialog settings={view.settings} onClose={() => setDialog(null)} />}
      {dialog === 'withdraw' && open && (
        <ConfirmDialog title="Withdraw your resignation?" confirmLabel="Withdraw it" onClose={() => setDialog(null)}
          onConfirm={() => action.mutateAsync({ id: open.id, action: 'withdraw' }).then(() => toast.success('Your resignation is withdrawn'))}>
          <p>You stay on, as before. The person you report to and HR can see that you withdrew it.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}
