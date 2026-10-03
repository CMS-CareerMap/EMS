import { useState } from 'react'
import { History, ChevronDown, ChevronUp, Info } from 'lucide-react'
import DataState from '../../components/DataState'
import { useLifecycleOf } from '../../hooks/useLifecycle'
import { formatDay } from '../../lib/dates'
import { describeEvent, exitReasonLabel, resignationStatusLabel, stageOf } from '../../lib/lifecycle'
import { StepDialog, AcceptResignationDialog, CancelResignationDialog, OnboardingChecklist } from './LifecycleDialogs'

/**
 * Somebody's place in the employee lifecycle (client §43), in their profile:
 * the stage, the dates that make it, an open resignation, the steps the caller
 * may take — as the server allows them — and the employment history.
 */
export default function EmploymentSection({ employeeId }) {
  const query = useLifecycleOf(employeeId)
  return (
    <DataState query={query} compact>
      {(view) => <Employment view={view} />}
    </DataState>
  )
}

/** HR's steps, in the order the lifecycle runs. */
const STEPS = [
  ['onboarding', 'complete_onboarding', 'Complete onboarding'],
  ['confirm', 'confirm', 'Confirm'],
  ['probation', 'extend_probation', 'Extend probation'],
  ['transfer', 'transfer', 'Transfer'],
  ['promote', 'promote', 'Promote'],
  ['resignation', 'record_resignation', 'Record resignation'],
  ['exit', 'exit', 'Complete exit'],
]

function Employment({ view }) {
  const [dialog, setDialog] = useState(null)
  const [allHistory, setAllHistory] = useState(false)
  const stage = stageOf(view.stage)
  const r = view.resignation
  const openResignation = r && ['submitted', 'accepted'].includes(r.status) ? r : null
  const steps = STEPS.filter(([, may]) => view.may[may])
  const history = allHistory ? view.history : view.history.slice(0, 4)

  return (
    <section aria-label="Employment" className="space-y-3">
      <div className="bg-slate-50 rounded-xl border border-slate-200 p-4 space-y-3">
        <div className="flex items-center justify-between gap-2">
          <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-semibold ${stage.cls}`}>{stage.label}</span>
          {view.stage === 'probation' && view.probation_end_date && (
            <span className="text-xs text-slate-500">ends {formatDay(view.probation_end_date)}</span>
          )}
        </div>
        <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-xs">
          <Fact label="Joined" value={formatDay(view.date_of_joining)} />
          <Fact label="Onboarded" value={formatDay(view.onboarded_on)} />
          {/* Once confirmed, the day it happened says it all. */}
          {view.confirmed_on
            ? <Fact label="Confirmed" value={formatDay(view.confirmed_on)} />
            : <Fact label="Probation ends" value={formatDay(view.probation_end_date)} />}
          {view.last_working_date && <Fact label="Last working day" value={formatDay(view.last_working_date)} />}
          {view.exit_reason && <Fact label="Why they left" value={exitReasonLabel(view.exit_reason)} />}
        </dl>

        {view.onboarding && (
          <div className="border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold text-slate-500 mb-2">Onboarding</p>
            <OnboardingChecklist facts={view.onboarding} />
          </div>
        )}

        {openResignation && (
          <div className="border-t border-slate-200 pt-3 space-y-1.5 text-xs">
            <p className="font-semibold text-slate-700">
              Resignation · {resignationStatusLabel(openResignation.status)}
              {openResignation.on_behalf && <span className="font-normal text-slate-500"> · recorded by {openResignation.submitted_by ?? 'HR'}</span>}
            </p>
            <p className="text-slate-600">“{openResignation.reason}”</p>
            <p className="text-slate-500">
              Handed in {formatDay(openResignation.submitted_on)} · asked to leave {formatDay(openResignation.requested_last_day)}
              {openResignation.status === 'accepted' && ` · accepted by ${openResignation.decided_by ?? '—'}, last day ${formatDay(openResignation.last_working_day)}`}
            </p>
            {openResignation.status === 'submitted' && openResignation.decided_by_whom && !view.may.accept_resignation && (
              <p className="text-slate-500">Goes to {openResignation.decided_by_whom} to accept.</p>
            )}
            {(view.may.accept_resignation || view.may.cancel_resignation) && (
              <div className="flex flex-wrap gap-2 pt-1">
                {view.may.accept_resignation && (
                  <button onClick={() => setDialog('accept')} className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium">
                    {view.may.accept_as_backup ? 'Accept (standing in)' : 'Accept'}
                  </button>
                )}
                {view.may.cancel_resignation && (
                  <button onClick={() => setDialog('cancel')} className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-700 font-medium">
                    Call off
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {view.may.exit_from && (
          <p className="text-xs text-slate-500 border-t border-slate-200 pt-3">Their last working day is {formatDay(view.may.exit_from)}. The exit is completed on or after it, unless they are relieved early.</p>
        )}

        {steps.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-3">
            {steps.map(([kind, , label]) => (
              <button key={kind} onClick={() => setDialog(kind)}
                className={`px-3 py-1.5 rounded-lg text-xs font-medium ${kind === 'exit'
                  ? 'border border-red-200 bg-white text-red-700 hover:bg-red-50'
                  : 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}>
                {label}
              </button>
            ))}
          </div>
        )}

        {view.goes_to && (
          <p className="flex items-start gap-1.5 text-xs text-slate-500 border-t border-slate-200 pt-3">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            Changes to this employment record are made by {view.goes_to}.
          </p>
        )}
      </div>

      {!view.detailed && (
        <p className="text-xs text-slate-500">Their history, and any resignation not yet accepted, are shown to HR, the person they report to and the Super Admin.</p>
      )}

      {view.history.length > 0 && (
        <div>
          <p className="flex items-center gap-1.5 text-xs font-semibold text-gray-500 mb-2"><History className="w-3.5 h-3.5" /> History</p>
          <ol className="space-y-2 border-l-2 border-gray-100 pl-3">
            {history.map((e) => (
              <li key={e.id} className="text-xs">
                <p className="text-gray-800">{describeEvent(e)}</p>
                <p className="text-gray-400">{formatDay(e.effective_date)}{e.by ? ` · by ${e.by}` : ''}</p>
                {e.note && <p className="text-gray-500 italic">“{e.note}”</p>}
              </li>
            ))}
          </ol>
          {view.history.length > 4 && (
            <button onClick={() => setAllHistory((v) => !v)} aria-expanded={allHistory} className="mt-2 flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
              {allHistory ? <>Show less <ChevronUp className="w-3.5 h-3.5" /></> : <>Show all {view.history.length} <ChevronDown className="w-3.5 h-3.5" /></>}
            </button>
          )}
        </div>
      )}

      {dialog && STEPS.some(([kind]) => kind === dialog) && <StepDialog kind={dialog} view={view} onClose={() => setDialog(null)} />}
      {dialog === 'accept' && openResignation && (
        <AcceptResignationDialog resignation={openResignation} name={view.full_name} onClose={() => setDialog(null)} />
      )}
      {dialog === 'cancel' && openResignation && (
        <CancelResignationDialog resignationId={openResignation.id} name={view.full_name} accepted={openResignation.status === 'accepted'} onClose={() => setDialog(null)} />
      )}
    </section>
  )
}

function Fact({ label, value }) {
  return (
    <div>
      <dt className="text-slate-400">{label}</dt>
      <dd className="font-medium text-slate-800">{value}</dd>
    </div>
  )
}
