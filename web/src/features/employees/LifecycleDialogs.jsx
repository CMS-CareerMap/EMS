import { cloneElement, useId, useState } from 'react'
import { toast } from 'sonner'
import { AlertTriangle, CheckCircle2, CircleDashed } from 'lucide-react'
import Dialog, { inputCls } from '../../components/Dialog'
import { useAuthStore } from '../../stores/authStore'
import { useEmployees, useMasterData } from '../../hooks/useEmployees'
import { useLifecycleStep, useResign, useResignationAction } from '../../hooks/useLifecycle'
import { addDays, calendarDayIn, formatDay } from '../../lib/dates'
import { EXIT_REASONS, PROBATION_MONTHS_MAX, addMonths } from '../../lib/lifecycle'
import { optionsNote } from '../../lib/optionsNote'

/**
 * The employee lifecycle's dialogs (client §43). Each sends one step and
 * closes only once the server has taken it; a refusal is the app-wide toast,
 * with the dialog left open and everything still in it.
 */

function useToday() {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  return calendarDayIn(timezone)
}

/** A labelled field; its hint is the field's description, not part of its name. */
function Field({ label, hint, children }) {
  const hintId = useId()
  return (
    <div className="space-y-1.5">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-gray-700">{label}</span>
        {hint ? cloneElement(children, { 'aria-describedby': hintId }) : children}
      </label>
      {hint && <p id={hintId} className="text-xs text-gray-500">{hint}</p>}
    </div>
  )
}

function Buttons({ onClose, busy, label, danger = false, disabled = false }) {
  return (
    <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
      <button type="button" onClick={onClose} disabled={busy}
        className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">
        Cancel
      </button>
      <button type="submit" disabled={busy || disabled}
        className={`px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
        {busy ? 'Working…' : label}
      </button>
    </div>
  )
}

/** A form inside the app's dialog, which waits for the save before closing. */
function StepForm({ title, onClose, onSubmit, busy, label, danger, disabled, children }) {
  const submit = async (e) => {
    e.preventDefault()
    const done = await onSubmit().then(() => true, () => false)
    if (done) onClose()
  }
  return (
    <Dialog title={title} onClose={busy ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        {children}
        <Buttons onClose={onClose} busy={busy} label={label} danger={danger} disabled={disabled} />
      </form>
    </Dialog>
  )
}

const note = (text) => (text.trim() ? text.trim() : null)

// ─── HR's steps on somebody ──────────────────────────────────────────────────

const STEP_TITLES = {
  onboarding: 'Complete onboarding',
  probation: 'Extend probation',
  confirm: 'Confirm after probation',
  transfer: 'Transfer',
  promote: 'Promote',
  resignation: 'Record a resignation',
  exit: 'Complete the exit',
}

/** One of HR's steps on `view` — the person's lifecycle as the server sent it. */
export function StepDialog({ kind, view, onClose }) {
  const step = useLifecycleStep()
  const send = (body, message) =>
    step.mutateAsync({ employeeId: view.employee_id, step: kind, body }).then(() => toast.success(message))
  const props = { view, onClose, send, busy: step.isPending, title: `${STEP_TITLES[kind]} — ${view.full_name}` }
  switch (kind) {
    case 'onboarding': return <OnboardingForm {...props} />
    case 'probation': return <ProbationForm {...props} />
    case 'confirm': return <ConfirmForm {...props} />
    case 'transfer': return <TransferForm {...props} />
    case 'promote': return <PromoteForm {...props} />
    case 'resignation': return <RecordResignationForm {...props} />
    case 'exit': return <ExitForm {...props} />
    default: return null
  }
}

function Check({ done, children }) {
  return (
    <li className="flex items-start gap-2 text-sm">
      {done ? <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" /> : <CircleDashed className="w-4 h-4 text-gray-400 shrink-0 mt-0.5" />}
      <span className={done ? 'text-gray-700' : 'text-gray-500'}>{children}</span>
    </li>
  )
}

/** What onboarding asks of a person, as the server found it. Shown, not enforced: HR decides. */
export function OnboardingChecklist({ facts }) {
  return (
    <ul className="space-y-1.5">
      <Check done={facts.login_active}>{facts.login_active ? 'Has signed in' : facts.login_invited ? 'Invited — has not set a password yet' : 'No login yet'}</Check>
      <Check done={facts.required_documents === 0 || facts.verified_documents === facts.required_documents}>
        {facts.required_documents === 0 ? 'No documents are required' : `${facts.verified_documents} of ${facts.required_documents} required documents verified`}
      </Check>
      <Check done={facts.bank_status === 'verified'}>
        {facts.bank_status === 'verified' ? 'Bank account checked' : facts.bank_status ? 'Bank account recorded, not checked yet' : 'No bank account yet'}
      </Check>
      <Check done={facts.pan_recorded}>{facts.pan_recorded ? 'PAN recorded' : 'No PAN yet'}</Check>
      <Check done={facts.has_manager}>{facts.has_manager ? 'Reports to somebody' : 'Reports to nobody yet'}</Check>
    </ul>
  )
}

function OnboardingForm({ view, onClose, send, busy, title }) {
  const [text, setText] = useState('')
  return (
    <StepForm title={title} onClose={onClose} busy={busy} label="Complete onboarding"
      onSubmit={() => send({ note: note(text) }, `${view.full_name}'s onboarding is complete`)}>
      {view.onboarding && <OnboardingChecklist facts={view.onboarding} />}
      <p className="text-sm text-gray-600">
        {view.probation_end_date || view.date_of_joining
          ? `Their probation then runs until ${view.probation_end_date ? formatDay(view.probation_end_date) : `${view.settings.probation_months} months after joining`}.`
          : 'Their probation then has no end date until one is set with “Extend probation”.'}
        {' '}Anything still open above can be finished afterwards.
      </p>
      <Field label="Note (optional)">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </Field>
    </StepForm>
  )
}

function ProbationForm({ view, onClose, send, busy, title }) {
  const today = useToday()
  const [date, setDate] = useState('')
  const [text, setText] = useState('')
  return (
    <StepForm title={title} onClose={onClose} busy={busy} label="Extend probation"
      disabled={!date || date === view.probation_end_date || text.trim().length < 3}
      onSubmit={() => send({ probationEndDate: date, note: text.trim() }, `${view.full_name}'s probation now ends on ${formatDay(date)}`)}>
      <p className="text-sm text-gray-600">
        {view.probation_end_date ? `It ends on ${formatDay(view.probation_end_date)} now.` : 'It has no end date now.'}
      </p>
      <Field label="New end of probation">
        <input type="date" className={inputCls} value={date} min={today} max={addMonths(today, PROBATION_MONTHS_MAX)} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label="Why" hint="They are told, in these words.">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} minLength={3} maxLength={500} required />
      </Field>
    </StepForm>
  )
}

function ConfirmForm({ view, onClose, send, busy, title }) {
  const today = useToday()
  const [date, setDate] = useState(view.probation_end_date && view.probation_end_date < today ? view.probation_end_date : today)
  const [text, setText] = useState('')
  return (
    <StepForm title={title} onClose={onClose} busy={busy} label="Confirm" disabled={!date}
      onSubmit={() => send({ confirmedOn: date, note: note(text) }, `${view.full_name} is confirmed`)}>
      <p className="text-sm text-gray-600">
        Probation {!view.probation_end_date ? 'has no end date' : view.probation_end_date < today ? `ended on ${formatDay(view.probation_end_date)}` : `ends on ${formatDay(view.probation_end_date)}`}.
      </p>
      <Field label="Confirmed from">
        <input type="date" className={inputCls} value={date} min={view.date_of_joining ?? undefined} max={today} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label="Note (optional)">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </Field>
    </StepForm>
  )
}

function TransferForm({ view, onClose, send, busy, title }) {
  const today = useToday()
  // Who somebody reports to is the company tree: the Super Admin's.
  const setsTree = useAuthStore((state) => state.can('role:manage'))
  const lists = useMasterData()
  const people = useEmployees({ enabled: setsTree })
  const currentManager = view.reporting_manager_id ?? ''
  const [department, setDepartment] = useState(view.department_id ?? '')
  const [manager, setManager] = useState(currentManager)
  const [date, setDate] = useState(today)
  const [text, setText] = useState('')
  const departmentChanged = department !== (view.department_id ?? '')
  const managerChanged = setsTree && manager !== currentManager

  const body = {
    ...(departmentChanged ? { departmentId: department || null } : {}),
    ...(managerChanged ? { reportingManagerId: manager || null } : {}),
    effectiveDate: date,
    note: note(text),
  }
  return (
    <StepForm title={title} onClose={onClose} busy={busy} label="Transfer" disabled={!date || (!departmentChanged && !managerChanged)}
      onSubmit={() => send(body, `${view.full_name} is transferred`)}>
      <Field label="Department">
        <select className={inputCls} value={department} onChange={(e) => setDepartment(e.target.value)} disabled={lists.isLoading}>
          <option value="">{optionsNote(lists, 'No department')}</option>
          {lists.data?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      {setsTree ? (
        <Field label="Reports to" hint="Their waiting leave and resignation go to this person from now on.">
          <select className={inputCls} value={manager} onChange={(e) => setManager(e.target.value)} disabled={!people.data}>
            <option value="">{optionsNote(people, 'Nobody above')}</option>
            {(people.data ?? []).filter((p) => p.id !== view.employee_id).map((p) => (
              <option key={p.id} value={p.id}>{p.full_name}{p.designation ? ` — ${p.designation}` : ''}</option>
            ))}
          </select>
        </Field>
      ) : (
        <p className="text-xs text-gray-500">Who they report to is changed by the Super Admin, on Settings → Company Tree.</p>
      )}
      <Field label="From">
        <input type="date" className={inputCls} value={date} min={view.date_of_joining ?? undefined} max={today} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label="Note (optional)">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </Field>
    </StepForm>
  )
}

function PromoteForm({ view, onClose, send, busy, title }) {
  const today = useToday()
  const lists = useMasterData()
  const [designation, setDesignation] = useState('')
  const [date, setDate] = useState(today)
  const [text, setText] = useState('')
  const name = lists.data?.designations.find((d) => d.id === designation)?.name
  return (
    <StepForm title={title} onClose={onClose} busy={busy} label="Promote" disabled={!designation || !date}
      onSubmit={() => send({ designationId: designation, effectiveDate: date, note: note(text) }, `${view.full_name} is now ${name}`)}>
      <Field label="New designation">
        <select className={inputCls} value={designation} onChange={(e) => setDesignation(e.target.value)} disabled={lists.isLoading} required>
          <option value="">{optionsNote(lists, 'Choose one')}</option>
          {lists.data?.designations.filter((d) => d.id !== view.designation_id).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </Field>
      <Field label="From">
        <input type="date" className={inputCls} value={date} min={view.date_of_joining ?? undefined} max={today} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label="Note (optional)" hint="A change of salary that goes with it is entered by Accounts, under Payroll → Salary structure.">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </Field>
    </StepForm>
  )
}

function RecordResignationForm({ view, onClose, send, busy, title }) {
  const today = useToday()
  const [reason, setReason] = useState('')
  const [submitted, setSubmitted] = useState(today)
  const [lastDay, setLastDay] = useState('')
  const notice = view.settings.notice_period_days
  return (
    <StepForm title={title} onClose={onClose} busy={busy} label="Record resignation" disabled={reason.trim().length < 3 || !submitted}
      onSubmit={() => send({ reason: reason.trim(), submittedOn: submitted, requestedLastDay: lastDay || null }, `${view.full_name}'s resignation is recorded`)}>
      <p className="text-sm text-gray-600">For a resignation handed in on paper or by email. The person they report to accepts it, as with their own.</p>
      <Field label="Reason they gave">
        <textarea className={inputCls} rows={2} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} required />
      </Field>
      <Field label="Handed in on">
        <input type="date" className={inputCls} value={submitted} min={view.date_of_joining ?? undefined} max={today} onChange={(e) => setSubmitted(e.target.value)} required />
      </Field>
      <Field label="Last working day they asked for (optional)" hint={`Left empty: ${notice} days' notice — ${formatDay(addDays(submitted || today, notice))}.`}>
        <input type="date" className={inputCls} value={lastDay} min={submitted || undefined} onChange={(e) => setLastDay(e.target.value)} />
      </Field>
    </StepForm>
  )
}

function ExitForm({ view, onClose, send, busy, title }) {
  const today = useToday()
  const open = view.resignation && ['submitted', 'accepted'].includes(view.resignation.status)
  const [reason, setReason] = useState(open ? 'resigned' : '')
  const [date, setDate] = useState(view.last_working_date && view.last_working_date <= today ? view.last_working_date : today)
  const [text, setText] = useState('')
  // Somebody who was to join and is not coming: no working day to record.
  const neverJoined = view.stage === 'joining_soon'
  return (
    <StepForm title={title} onClose={onClose} busy={busy} label="Complete the exit" danger disabled={!reason || (!neverJoined && !date)}
      onSubmit={() => send(
        { reason, lastWorkingDate: neverJoined ? null : date, note: note(text) },
        neverJoined ? `${view.full_name} will not join: their record is closed` : `${view.full_name} has left the company`,
      )}>
      <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        {neverJoined ? (
          <div className="space-y-1">
            <p>They were to join on {formatDay(view.date_of_joining)}. This closes their record with no last working day, and closes every login of theirs. It cannot be undone here.</p>
          </div>
        ) : (
          <div className="space-y-1">
            <p>This closes every login of theirs and moves them off the employee list. It cannot be undone here.</p>
            {view.may.exit_from && (
              <p>Their last working day is {formatDay(view.may.exit_from)}. Completing the exit now relieves them early: pay stops on the day you enter below.</p>
            )}
            <p>Payroll pays their last month up to the last working day. Enter any final incentive before completing the exit.</p>
          </div>
        )}
      </div>
      <Field label="Why they are leaving">
        <select className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} required>
          <option value="">Choose one</option>
          {EXIT_REASONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
      </Field>
      {!neverJoined && (
        <Field label="Last working day">
          <input type="date" className={inputCls} value={date} min={view.date_of_joining ?? undefined} max={today} onChange={(e) => setDate(e.target.value)} required />
        </Field>
      )}
      <Field label="Note (optional)">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </Field>
    </StepForm>
  )
}

// ─── A resignation ──────────────────────────────────────────────────────────

/** Accepting somebody's resignation — the person they report to. */
export function AcceptResignationDialog({ resignation, name, onClose }) {
  const action = useResignationAction()
  const [date, setDate] = useState(resignation.requested_last_day)
  const [text, setText] = useState('')
  return (
    <StepForm title={`Accept ${name}'s resignation`} onClose={onClose} busy={action.isPending} label="Accept" disabled={!date}
      onSubmit={() => action.mutateAsync({ id: resignation.id, action: 'accept', body: { lastWorkingDay: date, note: note(text) } })
        .then(() => toast.success(`Accepted. ${name}'s last working day is ${formatDay(date)}`))}>
      {resignation.reason && <p className="text-sm text-gray-700 bg-gray-50 border border-gray-200 rounded-lg p-3">“{resignation.reason}”</p>}
      <p className="text-sm text-gray-600">Handed in on {formatDay(resignation.submitted_on)}, asking to leave on {formatDay(resignation.requested_last_day)}.</p>
      <Field label="Last working day" hint="Payroll pays them up to this day. HR completes the exit on or after it.">
        <input type="date" className={inputCls} value={date} min={resignation.submitted_on} onChange={(e) => setDate(e.target.value)} required />
      </Field>
      <Field label="Note (optional)">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} maxLength={500} />
      </Field>
    </StepForm>
  )
}

/** Calling a resignation off — they are staying. */
export function CancelResignationDialog({ resignationId, name, accepted, onClose }) {
  const action = useResignationAction()
  const [text, setText] = useState('')
  return (
    <StepForm title={`Call off ${name}'s resignation`} onClose={onClose} busy={action.isPending} label="Call it off" danger disabled={text.trim().length < 3}
      onSubmit={() => action.mutateAsync({ id: resignationId, action: 'cancel', body: { note: text.trim() } })
        .then(() => toast.success(`${name}'s resignation is called off`))}>
      <p className="text-sm text-gray-600">
        They stay on.{accepted ? ' The last working day the acceptance set is taken off again.' : ''}
      </p>
      <Field label="Why" hint="They are told, in these words.">
        <input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} minLength={3} maxLength={500} required />
      </Field>
    </StepForm>
  )
}

/** The person's own resignation. */
export function ResignDialog({ settings, onClose }) {
  const today = useToday()
  const resign = useResign()
  const [reason, setReason] = useState('')
  const [lastDay, setLastDay] = useState('')
  const notice = settings.notice_period_days
  return (
    <StepForm title="Hand in your resignation" onClose={onClose} busy={resign.isPending} label="Hand it in" danger disabled={reason.trim().length < 3}
      onSubmit={() => resign.mutateAsync({ reason: reason.trim(), requestedLastDay: lastDay || null }).then(() => toast.success('Your resignation is handed in'))}>
      <p className="text-sm text-gray-600">
        It goes to the person you report to, who accepts it and sets your last working day. Until then you can withdraw it.
      </p>
      <Field label="Reason">
        <textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} required />
      </Field>
      <Field label="Last working day you ask for (optional)" hint={`Left empty: the company's ${notice} days' notice — ${formatDay(addDays(today, notice))}.`}>
        <input type="date" className={inputCls} value={lastDay} min={today} onChange={(e) => setLastDay(e.target.value)} />
      </Field>
    </StepForm>
  )
}
