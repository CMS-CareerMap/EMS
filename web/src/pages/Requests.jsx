import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Paperclip, CheckCircle, XCircle, Inbox, Undo2 } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../components/Dialog'
import ConfirmDialog from '../components/ConfirmDialog'
import DataState from '../components/DataState'
import PageHeader from '../components/ui/PageHeader'
import { TabPanel } from '../components/ui/Tabs'
import { Avatar, Card, Chip, EmptyState, IconBox } from '../components/ui/bits'
import { btn, card, field } from '../components/ui/styles'
import { useAuthStore } from '../stores/authStore'

import { useDownload } from '../hooks/useDownload'
import { useQuery } from '@tanstack/react-query'
import { useAllRequests, useAttachToRequest, useMyRequests, useRequestAction, useWaitingRequests } from '../hooks/useRequests'
import { api, saveFromApi } from '../api/http'
import { prepareUpload } from '../lib/prepareUpload'
import NewRequestDialog from '../features/requests/NewRequestDialog'
import { REQUEST_TYPES, STATUS, statusOf, summaryOf, typeLabel } from '../lib/requests'
import { REQUEST_TONE, kindOf } from '../lib/requestKinds'
import { formatDayOf } from '../lib/dates'

/**
 * Requests (client §28–29): one place for everything besides leave — an
 * attendance correction, working from home or on duty, overtime, leave
 * encashment, a profile change.
 *
 *   My requests   what the caller asked, and its answer
 *   To decide     what waits for the caller — the person they report to, or HR
 *   All requests  HR's view, within its reach
 *
 * The open tab is in the address (?tab=decide), so a notice's link lands on it.
 * "?new=choose" opens a new request on the kinds; "?new=<kind>" on that form.
 */
export default function Requests() {
  const profile = useAuthStore((state) => state.profile)
  const can = useAuthStore((state) => state.can)
  // As the server's reach: profile changes need the personal-details right as well.
  const seesAll = can('attendance:update') || (can('employee:update') && can('employee:identity:read')) || can('leave:balance:manage')
  const waiting = useWaitingRequests()
  const tabs = [
    ...(profile && can('leave:apply') ? [{ key: 'mine', label: 'My requests' }] : []),
    { key: 'decide', label: 'To decide', count: waiting.data?.length ?? 0 },
    ...(seesAll ? [{ key: 'all', label: 'All requests' }] : []),
  ]
  const [params, setParams] = useSearchParams()
  const tab = tabs.find((t) => t.key === params.get('tab'))?.key ?? tabs[0].key
  // A link to a new request ("?new=choose", "?new=profile_change") opens the form — once per link.
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
    if (newType) setParams((p) => { p.delete('new'); p.delete('date'); return p }, { replace: true })
  }

  return (
    <>
      <PageHeader
        title="Requests"
        subtitle="Attendance corrections, working from home or on duty, overtime, leave encashment and changes to your details"
        actions={asks && (
          <button onClick={() => setCreating(true)} className={btn.primary}>
            <Plus className="w-4 h-4" aria-hidden="true" /> New request
          </button>
        )}
        tabs={tabs}
        tab={tab}
        onTab={(key) => setParams({ tab: key }, { replace: true })}
        panelId="requests-panel"
      />

      <TabPanel id="requests-panel" tab={tabs.length > 1 ? tab : null}>
        {tab === 'mine' && <Mine />}
        {tab === 'decide' && <ToDecide query={waiting} />}
        {tab === 'all' && <All />}
      </TabPanel>

      {creating && <NewRequestDialog initialType={newType ?? 'choose'} initialDate={params.get('date')} onClose={closeNew} />}
    </>
  )
}

function Mine() {
  const query = useMyRequests()
  const action = useRequestAction()
  const [withdrawing, setWithdrawing] = useState(null)
  return (
    <>
      <DataState query={query} empty={<Empty title="You have not sent any requests." />}>
        {(rows) => <List rows={rows} actions={(r) => (r.may.withdraw || r.may.attach) && (
          <>
            {r.may.attach && <AttachButton request={r} />}
            {r.may.withdraw && (
              <button onClick={() => setWithdrawing(r)} className={btn.secondarySm}>
                <Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> Withdraw
              </button>
            )}
          </>
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
      <DataState query={query} empty={<Empty title="Nothing is waiting for you." />}>
        {(rows) => <List rows={rows} showWho actions={(r) => r.may.decide && (
          <>
            <button onClick={() => setDeciding({ r, verdict: 'approve' })} className={btn.okSm}>
              <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" /> {r.may.as_backup ? 'Approve (standing in)' : 'Approve'}
            </button>
            <button onClick={() => setDeciding({ r, verdict: 'reject' })} className={btn.dangerSm}>
              <XCircle className="w-3.5 h-3.5" aria-hidden="true" /> Reject
            </button>
          </>
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
    <div className="space-y-4">
      <div className={`${card} px-4 py-3 flex flex-wrap gap-2.5 items-center`}>
        <select aria-label="Kind" className={`${field} flex-1 sm:flex-none`} value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">All kinds</option>
          {REQUEST_TYPES.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
        </select>
        <select aria-label="Status" className={`${field} flex-1 sm:flex-none`} value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Any status</option>
          {Object.entries(STATUS).map(([key, s]) => <option key={key} value={key}>{s.label}</option>)}
        </select>
        {query.isSuccess && <span className="text-xs font-medium text-gray-500 sm:ml-auto">{query.data.length} request{query.data.length === 1 ? '' : 's'}</span>}
      </div>
      <DataState query={query} empty={<Empty title="No requests match." />}>
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
    <label className={`${btn.secondarySm} cursor-pointer focus-within:ring-2 focus-within:ring-brand-500 ${attach.isPending ? 'opacity-60 pointer-events-none' : ''}`}>
      <Paperclip className="w-3.5 h-3.5" aria-hidden="true" /> {attach.isPending ? 'Adding…' : 'Add a file'}
      <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" className="sr-only" onChange={choose} aria-label={`Add a file to ${request.number}`} />
    </label>
  )
}

function Empty({ title }) {
  return <Card><EmptyState icon={Inbox} title={title} /></Card>
}

/** One card per request: what it asks, why, and where it stands. */
function List({ rows, showWho = false, actions = () => null }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const { busy, start } = useDownload()
  return (
    <ul className="space-y-3">
      {rows.map((r) => {
        const s = statusOf(r.status)
        const kind = kindOf(r.type)
        const buttons = actions(r)
        return (
          <li key={r.id} className={`${card} p-4 flex items-start gap-3`}>
            <IconBox icon={kind.icon} tone={kind.tone} size="lg" />
            <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-start gap-3">
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-bold text-gray-900">{typeLabel(r.type)}</span>
                <span className="font-mono text-xs text-gray-400">{r.number}</span>
                <Chip tone={REQUEST_TONE[r.status] ?? 'gray'}>{s.label}</Chip>
              </div>
              {showWho && (
                <p className="flex items-center gap-2 text-sm text-gray-700">
                  <Avatar name={r.full_name} size="xs" />
                  <span className="font-semibold">{r.full_name}</span>
                  <span className="text-gray-400">· {r.department ?? r.employee_code}</span>
                </p>
              )}
              <p className="text-sm text-gray-700 wrap-break-word">{summaryOf(r)}</p>
              <p className="text-xs text-gray-500 italic wrap-break-word">“{r.reason}”</p>
              <p className="text-xs text-gray-400">
                Sent {formatDayOf(r.submitted_at, timezone)}
                {r.status === 'pending' && r.decided_by_whom ? ` · goes to ${r.decided_by_whom}` : ''}
                {r.decided_by ? ` · ${s.label.toLowerCase()} by ${r.decided_by}` : ''}
                {r.decision_note ? ` — “${r.decision_note}”` : ''}
              </p>
              {r.attachment && (
                <button onClick={() => start(r.id, () => saveFromApi(`/requests/${r.id}/attachment`))} disabled={busy === r.id}
                  className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800 disabled:opacity-60">
                  <Paperclip className="w-3.5 h-3.5" aria-hidden="true" /> {r.attachment.name}
                </button>
              )}
            </div>
            {buttons && <div className="shrink-0 flex flex-wrap gap-2 sm:justify-end *:flex-1 sm:*:flex-none">{buttons}</div>}
            </div>
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
          <span className="text-sm font-semibold text-gray-700">{reject ? 'Why (they are told)' : 'Note (optional)'}</span>
          <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required={reject} minLength={reject ? 3 : undefined} />
        </label>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={action.isPending} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={action.isPending || (reject && note.trim().length < 3)} className={reject ? btn.danger : btn.primary}>
            {action.isPending ? 'Working…' : reject ? 'Reject' : 'Approve'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
