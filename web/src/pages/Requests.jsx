import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Paperclip, CheckCircle, XCircle, Inbox } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../components/Dialog'
import ConfirmDialog from '../components/ConfirmDialog'
import DataState from '../components/DataState'
import { useAuthStore } from '../stores/authStore'

import { useDownload } from '../hooks/useDownload'
import { useQuery } from '@tanstack/react-query'
import { useAllRequests, useAttachToRequest, useMyRequests, useRequestAction, useWaitingRequests } from '../hooks/useRequests'
import { api, saveFromApi } from '../api/http'
import { prepareUpload } from '../lib/prepareUpload'
import NewRequestDialog from '../features/requests/NewRequestDialog'
import { REQUEST_TYPES, STATUS, statusOf, summaryOf, typeLabel } from '../lib/requests'
import { formatDayOf } from '../lib/dates'

/**
 * Requests (client §28–29): one place for everything besides leave — an
 * attendance correction, working from home or on duty, a profile change.
 *
 *   My requests   what the caller asked, and its answer
 *   To decide     what waits for the caller — the person they report to, or HR
 *   All requests  HR's view, within its reach
 *
 * The open tab is in the address (?tab=decide), so a notice's link lands on it.
 */
export default function Requests() {
  const profile = useAuthStore((state) => state.profile)
  const can = useAuthStore((state) => state.can)
  // As the server's reach: profile changes need the personal-details right as well.
  const seesAll = can('attendance:update') || (can('employee:update') && can('employee:identity:read')) || can('leave:balance:manage')
  const waiting = useWaitingRequests()
  const tabs = [
    ...(profile && can('leave:apply') ? [['mine', 'My requests']] : []),
    ['decide', `To decide${waiting.data?.length ? ` (${waiting.data.length})` : ''}`],
    ...(seesAll ? [['all', 'All requests']] : []),
  ]
  const [params, setParams] = useSearchParams()
  const tab = tabs.find(([id]) => id === params.get('tab'))?.[0] ?? tabs[0][0]
  // A link to a new request of some kind ("?new=profile_change") opens the form — once per link.
  // One's own, like leave: sent by somebody on the staff from a login that may apply for leave.
  const asks = Boolean(profile) && can('leave:apply')
  const newType = asks ? params.get('new') : null
  const [creating, setCreating] = useState(false)
  const [followed, setFollowed] = useState(null)
  if (newType !== followed) {
    setFollowed(newType)
    if (newType) setCreating(true)
  }

  const closeNew = () => {
    setCreating(false)
    if (newType) setParams((p) => { p.delete('new'); return p }, { replace: true })
  }

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Requests</h2>
          <p className="text-sm text-gray-500 mt-0.5">Attendance corrections, working from home or on duty, overtime, leave encashment and changes to your details</p>
        </div>
        {asks && (
          <button onClick={() => setCreating(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            <Plus className="w-4 h-4" /> New request
          </button>
        )}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-gray-200" role="tablist">
        {tabs.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={tab === id} onClick={() => setParams({ tab: id }, { replace: true })}
            className={`px-4 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px ${tab === id ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'mine' && <Mine />}
      {tab === 'decide' && <ToDecide query={waiting} />}
      {tab === 'all' && <All />}

      {creating && <NewRequestDialog initialType={newType ?? 'attendance_correction'} initialDate={params.get('date')} onClose={closeNew} />}
    </div>
  )
}

function Mine() {
  const query = useMyRequests()
  const action = useRequestAction()
  const [withdrawing, setWithdrawing] = useState(null)
  return (
    <>
      <DataState query={query} empty={<Empty text="You have not sent any requests." />}>
        {(rows) => <List rows={rows} actions={(r) => (r.may.withdraw || r.may.attach) && (
          <div className="flex gap-2">
            {r.may.attach && <AttachButton request={r} />}
            {r.may.withdraw && <button onClick={() => setWithdrawing(r)} className="px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50">Withdraw</button>}
          </div>
        )} />}
      </DataState>
      {withdrawing && (
        <ConfirmDialog title={`Withdraw ${withdrawing.number}?`} confirmLabel="Withdraw it" onClose={() => setWithdrawing(null)}
          onConfirm={() => action.mutateAsync({ id: withdrawing.id, action: 'withdraw' }).then(() => toast.success(`${withdrawing.number} is withdrawn`))}>
          <p>{typeLabel(withdrawing.type)}: {summaryOf(withdrawing)}</p>
        </ConfirmDialog>
      )}
    </>
  )
}

function ToDecide({ query }) {
  const [deciding, setDeciding] = useState(null)
  return (
    <>
      <DataState query={query} empty={<Empty text="Nothing is waiting for you." />}>
        {(rows) => <List rows={rows} showWho actions={(r) => r.may.decide && (
          <div className="flex gap-2">
            <button onClick={() => setDeciding({ r, verdict: 'approve' })} className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-medium">
              <CheckCircle className="w-3.5 h-3.5" /> {r.may.as_backup ? 'Approve (standing in)' : 'Approve'}
            </button>
            <button onClick={() => setDeciding({ r, verdict: 'reject' })} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium">
              <XCircle className="w-3.5 h-3.5" /> Reject
            </button>
          </div>
        )} />}
      </DataState>
      {deciding && <DecisionDialog request={deciding.r} verdict={deciding.verdict} onClose={() => setDeciding(null)} />}
    </>
  )
}

function All() {
  const [type, setType] = useState('')
  const [status, setStatus] = useState('pending')
  const query = useAllRequests({ type: type || undefined, status: status || undefined })
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select aria-label="Kind" className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All kinds</option>
          {REQUEST_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Status" className="border border-gray-300 rounded-lg px-3 py-2 text-sm bg-white" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {Object.entries(STATUS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
        </select>
      </div>
      <DataState query={query} empty={<Empty text="No requests match." />}>
        {(rows) => <List rows={rows} showWho />}
      </DataState>
    </div>
  )
}

/** Adds the supporting file to a request that waits — one per request. */
function AttachButton({ request }) {
  const attach = useAttachToRequest()
  const limit = useQuery({ queryKey: ['requests', 'upload-limit'], queryFn: async () => (await api.get('/requests/upload-limit')).data, staleTime: 5 * 60_000 })
  async function choose(e) {
    const picked = e.target.files?.[0]
    e.target.value = ''
    if (!picked) return
    let file
    try {
      file = await prepareUpload(picked, limit.data?.max_upload_mb ?? 2)
    } catch (err) {
      toast.error(err.message)
      return
    }
    const done = await attach.mutateAsync({ id: request.id, file }).then(() => true, () => false)
    if (done) toast.success(`File added to ${request.number}`)
  }
  return (
    <label className={`flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50 cursor-pointer ${attach.isPending ? 'opacity-60 pointer-events-none' : ''}`}>
      <Paperclip className="w-3.5 h-3.5" /> {attach.isPending ? 'Adding…' : 'Add a file'}
      <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={choose} aria-label={`Add a file to ${request.number}`} />
    </label>
  )
}

function Empty({ text }) {
  return (
    <div className="flex flex-col items-center py-12 text-gray-400">
      <Inbox className="w-8 h-8 mb-2" />
      <p className="text-sm">{text}</p>
    </div>
  )
}

/** One card per request: what it asks, why, and where it stands. */
function List({ rows, showWho = false, actions = () => null }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const { busy, start } = useDownload()
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const s = statusOf(r.status)
        return (
          <li key={r.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col sm:flex-row sm:items-start gap-3">
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs text-gray-500">{r.number}</span>
                <span className="text-sm font-semibold text-gray-900">{typeLabel(r.type)}</span>
                <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.cls}`}>{s.label}</span>
              </div>
              {showWho && <p className="text-sm text-gray-700">{r.full_name}<span className="text-gray-400"> · {r.department ?? r.employee_code}</span></p>}
              <p className="text-sm text-gray-700 break-words">{summaryOf(r)}</p>
              <p className="text-xs text-gray-500 italic break-words">“{r.reason}”</p>
              <p className="text-xs text-gray-400">
                Sent {formatDayOf(r.submitted_at, timezone)}
                {r.status === 'pending' && r.decided_by_whom ? ` · goes to ${r.decided_by_whom}` : ''}
                {r.decided_by ? ` · ${s.label.toLowerCase()} by ${r.decided_by}` : ''}
                {r.decision_note ? ` — “${r.decision_note}”` : ''}
              </p>
              {r.attachment && (
                <button onClick={() => start(r.id, () => saveFromApi(`/requests/${r.id}/attachment`))} disabled={busy === r.id}
                  className="flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700 disabled:opacity-60">
                  <Paperclip className="w-3.5 h-3.5" /> {r.attachment.name}
                </button>
              )}
            </div>
            <div className="shrink-0">{actions(r)}</div>
          </li>
        )
      })}
    </ul>
  )
}

function DecisionDialog({ request, verdict, onClose }) {
  const action = useRequestAction()
  const [note, setNote] = useState('')
  const reject = verdict === 'reject'
  const submit = async (e) => {
    e.preventDefault()
    const done = await action.mutateAsync({ id: request.id, action: verdict, note: note.trim() }).then(() => true, () => false)
    if (done) {
      toast.success(`${request.number} is ${reject ? 'rejected' : 'approved'}`)
      onClose()
    }
  }
  return (
    <Dialog title={`${reject ? 'Reject' : 'Approve'} ${request.number} — ${request.full_name}`} onClose={action.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-700">{typeLabel(request.type)}: {summaryOf(request)}</p>
        <p className="text-sm text-gray-500 italic">“{request.reason}”</p>
        {!reject && request.type === 'attendance_correction' && <p className="text-xs text-gray-500">Approving writes these times on their attendance for that day.</p>}
        {!reject && request.type === 'profile_change' && <p className="text-xs text-gray-500">Approving updates their record with these details.</p>}
        {!reject && request.type === 'overtime' && <p className="text-xs text-gray-500">Approving pays these minutes at the company’s overtime rate, with that month’s salary — or the next one still open.</p>}
        {!reject && request.type === 'leave_encashment' && <p className="text-xs text-gray-500">Approving takes these days off their balance and pays them with the first payroll still open — this month’s, unless it is already approved.</p>}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-700">{reject ? 'Why (they are told)' : 'Note (optional)'}</span>
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required={reject} minLength={reject ? 3 : undefined} />
        </label>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={action.isPending} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={action.isPending || (reject && note.trim().length < 3)}
            className={`px-4 py-2 text-sm font-medium text-white rounded-lg disabled:opacity-60 ${reject ? 'bg-red-600 hover:bg-red-700' : 'bg-emerald-600 hover:bg-emerald-700'}`}>
            {action.isPending ? 'Working…' : reject ? 'Reject' : 'Approve'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
