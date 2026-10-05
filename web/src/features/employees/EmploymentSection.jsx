import { useState } from 'react'
import { History, ChevronDown, ChevronUp, Info } from 'lucide-react'
import DataState from '../../components/DataState'
import { Chip } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
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

/** The stage's colour, in the chip tones. */
const STAGE_TONE = {
  joining_soon: 'info', onboarding: 'brand', probation: 'warn', confirmed: 'ok',
  resigned: 'warn', notice_period: 'leave', exit_due: 'bad', left: 'gray',
}

function Employment({ view }) {
  const [dialog, setDialog] = useState(null)
  const [allHistory, setAllHistory] = useState(false)
  const stage = stageOf(view.stage)
  const r = view.resignation
  const openResignation = r && ['submitted', 'accepted'].includes(r.status) ? r : null
  const steps = STEPS.filter(([, may]) => view.may[may])
  const history = allHistory ? view.history : view.history.slice(0, 4)
  const withHistory = view.history.length > 0

  return (
    // Not a named section of its own: the profile's "Employment" card around it names it.
    <div className={`grid grid-cols-1 gap-6 ${withHistory ? 'lg:grid-cols-5' : ''}`}>
      <div className={`space-y-4 min-w-0 ${withHistory ? 'lg:col-span-3' : ''}`}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={STAGE_TONE[view.stage] ?? 'gray'}>{stage.label}</Chip>
          {view.stage === 'probation' && view.probation_end_date && (
            <span className="text-xs text-gray-500">ends {formatDay(view.probation_end_date)}</span>
          )}
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
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
          <div className="border-t border-gray-100 pt-4">
            <p className="text-xs font-bold text-gray-500 mb-2">Onboarding</p>
            <OnboardingChecklist facts={view.onboarding} />
          </div>
        )}

        {openResignation && (
          <div className="rounded-xl bg-amber-50 border border-amber-100 p-3.5 space-y-1.5 text-xs">
            <p className="text-sm font-bold text-gray-900">
              Resignation · {resignationStatusLabel(openResignation.status)}
              {openResignation.on_behalf && <span className="text-xs font-normal text-gray-500"> · recorded by {openResignation.submitted_by ?? 'HR'}</span>}
            </p>
            <p className="text-gray-700">“{openResignation.reason}”</p>
            <p className="text-gray-500">
              Handed in {formatDay(openResignation.submitted_on)} · asked to leave {formatDay(openResignation.requested_last_day)}
              {openResignation.status === 'accepted' && ` · accepted by ${openResignation.decided_by ?? '—'}, last day ${formatDay(openResignation.last_working_day)}`}
            </p>
            {openResignation.status === 'submitted' && openResignation.decided_by_whom && !view.may.accept_resignation && (
              <p className="text-gray-500">Goes to {openResignation.decided_by_whom} to accept.</p>
            )}
            {(view.may.accept_resignation || view.may.cancel_resignation) && (
              <div className="flex flex-wrap gap-2 pt-1.5">
                {view.may.accept_resignation && (
                  <button onClick={() => setDialog('accept')} className={btn.primarySm}>
                    {view.may.accept_as_backup ? 'Accept (standing in)' : 'Accept'}
                  </button>
                )}
                {view.may.cancel_resignation && (
                  <button onClick={() => setDialog('cancel')} className={btn.secondarySm}>
                    Call off
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {view.may.exit_from && (
          <p className="text-xs text-gray-500">Their last working day is {formatDay(view.may.exit_from)}. The exit is completed on or after it, unless they are relieved early.</p>
        )}

        {steps.length > 0 && (
          <div className="flex flex-wrap gap-2 border-t border-gray-100 pt-4">
            {steps.map(([kind, , label]) => (
              <button key={kind} onClick={() => setDialog(kind)} className={kind === 'exit' ? btn.dangerSm : btn.secondarySm}>
                {label}
              </button>
            ))}
          </div>
        )}

        {view.goes_to && (
          <p className="flex items-start gap-1.5 text-xs text-gray-500">
            <Info className="w-3.5 h-3.5 shrink-0 mt-px" />
            Changes to this employment record are made by {view.goes_to}.
          </p>
        )}

        {!view.detailed && (
          <p className="text-xs text-gray-500">Their history, and any resignation not yet accepted, are shown to whoever looks after their employment record, the person they report to and the Super Admin.</p>
        )}
      </div>

      {withHistory && (
        <div className="lg:col-span-2 min-w-0 lg:border-l lg:border-gray-100 lg:pl-6">
          <p className="flex items-center gap-1.5 text-xs font-bold text-gray-500 mb-3"><History className="w-3.5 h-3.5" /> History</p>
          <ol className="space-y-3 border-l-2 border-brand-100 pl-3.5">
            {history.map((e) => (
              <li key={e.id} className="relative text-xs">
                <span aria-hidden="true" className="absolute -left-4.75 top-1 w-2 h-2 rounded-full bg-logo" />
                <p className="text-[13px] font-medium text-gray-900">{describeEvent(e)}</p>
                <p className="text-gray-500">{formatDay(e.effective_date)}{e.by ? ` · by ${e.by}` : ''}</p>
                {e.note && <p className="text-gray-500 italic">“{e.note}”</p>}
              </li>
            ))}
          </ol>
          {view.history.length > 4 && (
            <button onClick={() => setAllHistory((v) => !v)} aria-expanded={allHistory} className="mt-3 flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
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
    </div>
  )
}

function Fact({ label, value }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-semibold text-gray-500">{label}</dt>
      <dd className="text-sm font-semibold text-gray-900 mt-0.5">{value}</dd>
    </div>
  )
}
