import { cloneElement, useId, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import DataState from '../../components/DataState'
import { api } from '../../api/http'
import { useAuthStore } from '../../stores/authStore'
import { useMyDetails, useSubmitRequest } from '../../hooks/useRequests'
import { useMyWorkplace } from '../../hooks/usePunch'
import { useLeaveBalances } from '../../hooks/useLeave'
import { addDays, calendarDayIn, formatDay } from '../../lib/dates'
import { prepareUpload } from '../../lib/prepareUpload'
import { PROFILE_FIELDS, REQUEST_TYPES, minutesLabel, typeLabel } from '../../lib/requests'
import { kindOf } from '../../lib/requestKinds'
import { IconBox } from '../../components/ui/bits'
import { btn, fileInput } from '../../components/ui/styles'
import { ChevronLeft } from 'lucide-react'

/**
 * A new request (client §28–29). One form, its fields following the kind:
 * a day and the times for a correction, the days for working from home or on
 * duty, a day of recorded overtime, days of leave to encash, the details to
 * change for a profile change. A file in support is
 * optional, and a photo bigger than the company allows is made smaller first.
 */

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

/**
 * `initialType` is a kind to start on, or "choose" — then the dialog opens on
 * the kinds, each with what it is for, and the form follows the one picked.
 */
export default function NewRequestDialog({ initialType = 'choose', initialDate = null, onClose }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const today = calendarDayIn(timezone)
  const submit = useSubmitRequest()
  const known = REQUEST_TYPES.some(([key]) => key === initialType)
  // A link with a kind this app does not have opens the choice rather than a form for nothing.
  const [choosing, setChoosing] = useState(!known)
  const [type, setType] = useState(known ? initialType : 'attendance_correction')
  const [date, setDate] = useState(initialDate ?? addDays(today, -1))
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [fromDate, setFromDate] = useState(today)
  const [toDate, setToDate] = useState(today)
  const [changes, setChanges] = useState({})
  const [otMinutes, setOtMinutes] = useState('')
  const [leaveTypeId, setLeaveTypeId] = useState('')
  const [encashDays, setEncashDays] = useState('')
  const [reason, setReason] = useState('')
  const [file, setFile] = useState(null)
  const [problem, setProblem] = useState('')
  const [busy, setBusy] = useState(false)
  const details = useMyDetails({ enabled: type === 'profile_change' })
  const can = useAuthStore((state) => state.can)
  // Asked only of a login that checks in; one that does not is offered no overtime.
  const workplace = useMyWorkplace({ enabled: can('attendance:punch') })
  // Overtime is offered only where the company pays it (Settings → Payroll Config).
  const kinds = REQUEST_TYPES.filter(([key]) => key !== 'overtime' || workplace.data?.overtime_enabled || type === 'overtime')
  const overtimeDays = useOvertimeDays(today, type === 'overtime')
  // Asked only for an encashment, and only of somebody whose role reads leave.
  const balances = useLeaveBalances({ enabled: type === 'leave_encashment' && can('leave:read') })
  const encashable = (balances.data ?? []).filter((b) => b.encashable)
  const limit = useQuery({ queryKey: ['requests', 'upload-limit'], queryFn: async () => (await api.get('/requests/upload-limit')).data, staleTime: 5 * 60_000 })

  const body = () => {
    if (type === 'attendance_correction') return { type, date, checkIn: checkIn || null, checkOut: checkOut || null, reason: reason.trim() }
    if (type === 'work_from_home' || type === 'on_duty') return { type, fromDate, toDate, reason: reason.trim() }
    if (type === 'overtime') return { type, date, minutes: otMinutes ? Number(otMinutes) : null, reason: reason.trim() }
    if (type === 'leave_encashment') return { type, leaveTypeId, days: Number(encashDays), reason: reason.trim() }
    // Only what was changed is sent; the server compares with the record again.
    const current = details.data ?? {}
    const changed = Object.fromEntries(Object.entries(changes).filter(([key, value]) => (value || null) !== (current[key] ?? null)).map(([key, value]) => [key, value || null]))
    return { type, changes: changed, reason: reason.trim() }
  }

  const ready =
    reason.trim().length >= 3 &&
    (type === 'attendance_correction' ? Boolean(date && (checkIn || checkOut))
      : type === 'profile_change' ? Object.keys(body().changes ?? {}).length > 0
      : type === 'overtime' ? overtimeDays.days.some((d) => d.date === date)
      : type === 'leave_encashment' ? Boolean(leaveTypeId && Number(encashDays) > 0)
      : Boolean(fromDate && toDate))

  async function handleSubmit(e) {
    e.preventDefault()
    setProblem('')
    setBusy(true)
    let prepared = null
    try {
      if (file) prepared = await prepareUpload(file, limit.data?.max_upload_mb ?? 2)
    } catch (err) {
      setProblem(err.message)
      setBusy(false)
      return
    }
    const sent = await submit.mutateAsync({ body: body(), file: prepared }).then((r) => r, () => null)
    setBusy(false)
    if (!sent) return
    toast.success(sent.status === 'approved' ? `${sent.number} is recorded` : `${sent.number} is sent to ${sent.decided_by_whom ?? 'whoever decides it'}`)
    if (sent.fileProblem) toast.warning(sent.fileProblem)
    onClose()
  }

  if (choosing) {
    return (
      <Dialog title="New request" onClose={onClose}>
        <p className="text-sm text-gray-600">What do you need?</p>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2.5" aria-label="Kinds of request">
          {kinds.map(([key, label]) => {
            const kind = kindOf(key)
            return (
              <li key={key}>
                <button type="button" onClick={() => { setType(key); setChoosing(false) }}
                  className="w-full h-full text-left flex items-start gap-3 p-3.5 rounded-xl border border-gray-200 hover:border-brand-300 hover:bg-brand-50/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 transition-colors">
                  <IconBox icon={kind.icon} tone={kind.tone} />
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-gray-900">{label}</span>
                    <span className="block text-xs text-gray-500 mt-0.5">{kind.hint}</span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </Dialog>
    )
  }

  return (
    <Dialog title={typeLabel(type)} onClose={busy ? () => {} : onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <button type="button" onClick={() => setChoosing(true)} disabled={busy} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
          <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />All kinds of request
        </button>
        {type === 'attendance_correction' && (
          <>
            <p className="text-sm text-gray-600">For a day your check-in or check-out is missing or wrong. Give the time you need corrected; a time left empty stays as recorded.</p>
            <Field label="Day">
              <input type="date" className={inputCls} value={date} max={today} onChange={(e) => setDate(e.target.value)} required />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Check-in">
                <input type="time" className={inputCls} value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
              </Field>
              <Field label="Check-out">
                <input type="time" className={inputCls} value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
              </Field>
            </div>
          </>
        )}

        {(type === 'work_from_home' || type === 'on_duty') && (
          <>
            <p className="text-sm text-gray-600">
              {type === 'work_from_home'
                ? 'Once approved, you check in from home on these days without the office location.'
                : 'For company work away from the office — a client visit, business travel. Once approved, you check in from wherever you are.'}
            </p>
            <div className="grid grid-cols-2 gap-3">
              <Field label="From">
                <input type="date" className={inputCls} value={fromDate} min={today} onChange={(e) => { setFromDate(e.target.value); if (toDate < e.target.value) setToDate(e.target.value) }} required />
              </Field>
              <Field label="To">
                <input type="date" className={inputCls} value={toDate} min={fromDate} max={addDays(fromDate, 30)} onChange={(e) => setToDate(e.target.value)} required />
              </Field>
            </div>
          </>
        )}

        {type === 'overtime' && (
          <>
            <p className="text-sm text-gray-600">Overtime is the time worked past your shift’s hours, counted when you check out. Claim a day that recorded it; once approved, it is paid with that month’s salary — or the next one, if that month’s payroll is already approved.</p>
            {workplace.data && !workplace.data.overtime_enabled ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">The company does not pay overtime. Ask HR if you think it should.</p>
            ) : overtimeDays.loading ? (
              <p className="text-sm text-gray-400">Loading your days…</p>
            ) : overtimeDays.error ? (
              <p role="alert" className="text-sm text-rose-700">Your attendance could not be loaded: {overtimeDays.error.message}</p>
            ) : overtimeDays.days.length === 0 ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">No overtime is recorded this month or last. If a day’s times are wrong, ask for an attendance correction first.</p>
            ) : (
              <>
                <Field label="Day">
                  <select className={inputCls} value={overtimeDays.days.some((d) => d.date === date) ? date : ''} onChange={(e) => { setDate(e.target.value); setOtMinutes('') }} required>
                    <option value="">Choose a day…</option>
                    {overtimeDays.days.map((d) => <option key={d.date} value={d.date}>{formatDay(d.date, { weekday: true })} — {minutesLabel(d.minutes)} recorded</option>)}
                  </select>
                </Field>
                <Field label="Minutes to claim" hint="Leave it empty to claim all that was recorded.">
                  <input type="number" min="1" max={overtimeDays.days.find((d) => d.date === date)?.minutes ?? 1440} className={inputCls} value={otMinutes} onChange={(e) => setOtMinutes(e.target.value)} placeholder="All of it" />
                </Field>
              </>
            )}
          </>
        )}

        {type === 'leave_encashment' && (
          <>
            <p className="text-sm text-gray-600">Turn unused leave into pay. Once approved, the days come off your balance and are paid with this month’s salary — or the next one, if this month’s payroll is already approved.</p>
            {!can('leave:read') ? (
              <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">Your balances are not shown to this login. Send it from your employee login.</p>
            ) : (
            <DataState query={balances} compact>
              {() => encashable.length === 0 ? (
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">None of your leave can be encashed. HR sets which leave types can.</p>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <Field label="Leave type">
                    <select className={inputCls} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} required>
                      <option value="">Choose…</option>
                      {encashable.map((b) => <option key={b.leave_type_id} value={b.leave_type_id}>{b.name} — {b.available} available</option>)}
                    </select>
                  </Field>
                  <Field label="Days">
                    <input type="number" min="0.5" step="0.5" max={encashable.find((b) => b.leave_type_id === leaveTypeId)?.available ?? undefined} className={inputCls} value={encashDays} onChange={(e) => setEncashDays(e.target.value)} required />
                  </Field>
                </div>
              )}
            </DataState>
            )}
          </>
        )}

        {type === 'profile_change' && (
          <DataState query={details} compact>
            {(current) => (
              <div className="space-y-3">
                <p className="text-sm text-gray-600">Change what needs changing; it is approved before your record is updated.</p>
                {PROFILE_FIELDS.map(([key, label]) => (
                  <Field key={key} label={label}>
                    {key === 'address' ? (
                      <textarea rows={2} className={inputCls} value={changes[key] ?? current[key] ?? ''} onChange={(e) => setChanges({ ...changes, [key]: e.target.value })} maxLength={500} />
                    ) : (
                      <input
                        type={key === 'dateOfBirth' ? 'date' : key === 'personalEmail' ? 'email' : 'text'}
                        className={inputCls}
                        value={changes[key] ?? current[key] ?? ''}
                        max={key === 'dateOfBirth' ? today : undefined}
                        onChange={(e) => setChanges({ ...changes, [key]: e.target.value })}
                      />
                    )}
                  </Field>
                ))}
              </div>
            )}
          </DataState>
        )}

        <Field label="Reason">
          <textarea rows={2} className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={1000} required />
        </Field>
        <Field label="Supporting file (optional)" hint={`A PDF or a photo, up to ${limit.data?.max_upload_mb ?? 2} MB — a bigger photo is made smaller.`}>
          <input type="file" accept=".pdf,image/jpeg,image/png,image/webp" className={fileInput} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </Field>
        {problem && <p role="alert" className="text-sm text-rose-700">{problem}</p>}

        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={busy} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={busy || !ready} className={btn.primary}>
            {busy ? 'Sending…' : 'Send request'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}

/**
 * The caller's days with overtime recorded, this month and last — the days
 * an overtime claim can be for.
 */
function useOvertimeDays(today, enabled) {
  const profileId = useAuthStore((state) => state.profile?.id)
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  const last = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
  // Only the caller's own rows — never the whole company's month to keep one person's.
  const ask = (y, m) => ({
    queryKey: ['attendance', 'mine', y, m],
    queryFn: async () => (await api.get(`/attendance?year=${y}&month=${m}&employeeId=${profileId}`)).data,
    enabled: enabled && Boolean(profileId),
  })
  const now = useQuery(ask(year, month))
  const before = useQuery(ask(last.year, last.month))
  const rows = [...(now.data ?? []), ...(before.data ?? [])]
  const days = rows
    .filter((r) => r.overtime_minutes > 0)
    .map((r) => ({ date: r.date, minutes: r.overtime_minutes }))
    .sort((a, b) => b.date.localeCompare(a.date))
  return { days, loading: now.isLoading || before.isLoading, error: now.error ?? before.error }
}
