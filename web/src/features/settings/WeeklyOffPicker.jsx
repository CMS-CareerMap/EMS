import { useState } from 'react'
import { CalendarOff, CalendarClock, Info } from 'lucide-react'
import { useWorkWeek, useSaveWorkWeek, useCancelWorkWeek } from '../../hooks/useSettings'
import DataState from '../../components/DataState'
import Dialog from '../../components/Dialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import { btn } from '../../components/ui/styles'
import { formatDay } from '../../lib/dates'

/**
 * Which days the company is closed — and from when (client, 25 Oct 2026).
 *
 * It lives on the Leave tab because this is where somebody looks for it:
 * "which days are we off" is a question about leave, not about PF rates.
 *
 * A change says from when: today, the 1st of next month, or — while this
 * month's payroll is open — the 1st of this month, for a company setting its
 * week for the first time. Every day goes by the week in force on it, so the
 * leave count, the calendars, the home page and payroll always agree. Months
 * before this one are never changed.
 */

/** Monday first, as a week is read; the numbers are the server's (Sunday = 0). */
const DAYS = [
  { value: 1, label: 'Mon', full: 'Monday' },
  { value: 2, label: 'Tue', full: 'Tuesday' },
  { value: 3, label: 'Wed', full: 'Wednesday' },
  { value: 4, label: 'Thu', full: 'Thursday' },
  { value: 5, label: 'Fri', full: 'Friday' },
  { value: 6, label: 'Sat', full: 'Saturday' },
  { value: 0, label: 'Sun', full: 'Sunday' },
]

/** "Saturday and Sunday", Monday first; "no weekly off" for none. */
function weekdaysText(days) {
  const names = DAYS.filter((d) => days.includes(d.value)).map((d) => d.full)
  if (names.length === 0) return 'no weekly off'
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

export default function WeeklyOffPicker() {
  const week = useWorkWeek()
  // Only the real week: a failed load drawn as "no weekly offs" would invite saving over it.
  return (
    <DataState query={week} loading="Loading working days…" compact>
      {(w) => <Week week={w} />}
    </DataState>
  )
}

function Week({ week }) {
  const [changing, setChanging] = useState(false)
  const [cancelling, setCancelling] = useState(null)
  const [notice, setNotice] = useState('')
  const cancel = useCancelWorkWeek()
  const current = week.current.weekly_off_days

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5" aria-label="The week in force today">
        {DAYS.map((d) => {
          const off = current.includes(d.value)
          return (
            <span key={d.value} title={`${d.full}: ${off ? 'weekly off' : 'working day'}`}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium border ${off ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-white border-gray-200 text-gray-600'}`}>
              {d.label}<span className="sr-only">{off ? ', weekly off' : ', working day'}</span>
            </span>
          )
        })}
      </div>

      <p className="text-xs text-gray-500 flex items-start gap-1.5">
        <CalendarOff className="w-3.5 h-3.5 shrink-0 mt-0.5" aria-hidden="true" />
        <span>
          {current.length === 0
            ? 'No weekly offs — every day counts as a working day, so leave is charged for weekends too.'
            : <>Closed on <strong className="text-gray-700">{weekdaysText(current)}</strong>: a {7 - current.length}-day week. Leave is not charged for these days.</>}
          {week.current.from && <> In force since {formatDay(week.current.from)}.</>}
        </span>
      </p>

      {week.scheduled.map((s) => (
        <div key={s.from} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-brand-200 bg-brand-50/60 px-3 py-2 text-sm">
          <CalendarClock className="w-4 h-4 text-brand-600 shrink-0" aria-hidden="true" />
          <span className="flex-1 min-w-0 text-gray-700">
            From <strong>{formatDay(s.from)}</strong>: {weekdaysText(s.weekly_off_days)}.
          </span>
          <button type="button" onClick={() => setCancelling(s)} className={btn.dangerSm}>Cancel this change</button>
        </div>
      ))}

      {notice && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <Info className="w-4 h-4 shrink-0" aria-hidden="true" /><span className="flex-1">{notice}</span>
        </p>
      )}

      <button type="button" onClick={() => { setNotice(''); setChanging(true) }} className={btn.secondary}>Change weekly offs</button>

      {changing && <ChangeDialog week={week} onClose={() => setChanging(false)} onSaved={(text) => { setChanging(false); setNotice(text) }} />}
      {cancelling && (
        <ConfirmDialog title="Cancel this change?" confirmLabel="Cancel the change" danger
          onConfirm={() => cancel.mutateAsync(cancelling.from).then(() => setNotice(''))}
          onClose={() => setCancelling(null)}>
          The weekly offs will not change to {weekdaysText(cancelling.weekly_off_days)} on {formatDay(cancelling.from)}. The week in force stays as it is.
        </ConfirmDialog>
      )}
    </div>
  )
}

function ChangeDialog({ week, onClose, onSaved }) {
  const save = useSaveWorkWeek()
  const last = week.scheduled.at(-1)
  // Start from the week as it will be once every saved change has begun.
  const [days, setDays] = useState(() => [...(last ? last.weekly_off_days : week.current.weekly_off_days)])
  const starts = [
    { key: 'today', from: week.starts.today, label: 'From today', note: 'Today and every day after it.' },
    { key: 'next', from: week.starts.next_month, label: 'From the 1st of next month', note: 'This month stays as it is.' },
    week.starts.this_month
      ? { key: 'this', from: week.starts.this_month, label: 'From the 1st of this month', note: 'For a week being set for the first time: the days of this month already gone change too.' }
      : null,
  ].filter(Boolean)
  const [start, setStart] = useState('next')
  const chosen = starts.find((s) => s.key === start) ?? starts[0]

  function toggle(value) {
    setDays((d) => (d.includes(value) ? d.filter((x) => x !== value) : [...d, value]))
  }

  async function submit(e) {
    e.preventDefault()
    const saved = await save.mutateAsync({ weeklyOffDays: [...days].sort((a, b) => a - b), from: chosen.from }).catch(() => null)
    if (!saved) return
    const leave = saved.approved_leave_affected
    onSaved(leave > 0
      ? `Saved. ${leave === 1 ? '1 approved leave request covers' : `${leave} approved leave requests cover`} a day that changed. Leave already approved was counted on the week as it stood and has not been changed — correct a balance in Leave → Team Balances if it should be.`
      : '')
  }

  return (
    <Dialog title="Change weekly offs" onClose={save.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <fieldset>
          <legend className="text-sm font-medium text-gray-700 mb-2">Closed on</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d) => {
              const off = days.includes(d.value)
              const wouldCloseEverything = !off && days.length === 6
              return (
                <button key={d.value} type="button" onClick={() => toggle(d.value)} disabled={wouldCloseEverything} aria-pressed={off}
                  title={wouldCloseEverything ? 'The company cannot be closed every day' : `${d.full}: ${off ? 'weekly off' : 'working day'}`}
                  className={`px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${off ? 'bg-amber-50 border-amber-300 text-amber-900' : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
                  {d.label}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-gray-500">{days.length === 0 ? 'No weekly off: every day is a working day.' : `${weekdaysText(days)} off: a ${7 - days.length}-day week.`}</p>
        </fieldset>

        <fieldset>
          <legend className="text-sm font-medium text-gray-700 mb-2">Starting</legend>
          <div className="space-y-2">
            {starts.map((s) => (
              <label key={s.key} className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 cursor-pointer ${start === s.key ? 'border-brand-400 bg-brand-50/60' : 'border-gray-200 hover:bg-gray-50'}`}>
                <input type="radio" name="start" value={s.key} checked={start === s.key} onChange={() => setStart(s.key)} className="mt-1" />
                <span className="text-sm">
                  <span className="font-semibold text-gray-900">{s.label}</span> <span className="text-gray-500">— {formatDay(s.from)}</span>
                  <span className="block text-xs text-gray-500">{s.note}</span>
                </span>
              </label>
            ))}
          </div>
          {week.this_month_closed && <p className="mt-2 text-xs text-gray-500">{week.this_month_closed}</p>}
          {week.scheduled.length > 0 && (
            <p className="mt-2 text-xs text-amber-800">A change already saved for a day after the one chosen is replaced by this one.</p>
          )}
        </fieldset>

        <p className="text-xs text-gray-500">Every day before {formatDay(chosen.from)} keeps the week it had. Leave already approved is not recounted.</p>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={save.isPending} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={save.isPending} className={btn.primary}>{save.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  )
}
