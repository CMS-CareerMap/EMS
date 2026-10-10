import { btn, field } from '../../components/ui/styles'
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { X, CalendarDays, AlertCircle, Loader2, Split, Home } from 'lucide-react'
import { useLeaveBalances, usePreviewLeave } from '../../hooks/useLeave'
import { EscapeCloses } from '../../hooks/useEscape'
import DataState from '../../components/DataState'
import { formatDay } from '../../lib/dates'
import { typeColourOf } from '../../lib/leaveTypes'

/**
 * Applying for leave.
 *
 * The old version could not have worked against the server. Its leave types
 * were a hardcoded list — 'casual', 'sick' — where the server needs the id of a
 * type the company actually configured, so every request arrived with no leave
 * type and was refused. It counted days itself, with Saturday and Sunday
 * written in, when the company's weekly off is a setting. And it showed a
 * "max" per type that was a number somebody typed into this file.
 *
 * Now the types are the company's own, read with the person's balance for each,
 * and the day count is the server's preview — the same arithmetic the request
 * will be charged with — shown before anything is submitted.
 */

const EMPTY = { leave_type_id: '', from_date: '', to_date: '', reason: '', first_part: 'full', last_part: 'full' }

/**
 * Which days are half, and which half (client §37): one day can be the first
 * or the second half; a longer leave can start from the second half of its
 * first day and end with the first half of its last.
 */
function halvesOf(form, allowed) {
  const dates = []
  const sessions = {}
  if (!allowed || !form.from_date || !form.to_date || form.to_date < form.from_date) return { dates, sessions }
  if (form.from_date === form.to_date) {
    if (form.first_part !== 'full') {
      dates.push(form.from_date)
      sessions[form.from_date] = form.first_part
    }
    return { dates, sessions }
  }
  if (form.first_part === 'second_half') {
    dates.push(form.from_date)
    sessions[form.from_date] = 'second_half'
  }
  if (form.last_part === 'first_half') {
    dates.push(form.to_date)
    sessions[form.to_date] = 'first_half'
  }
  return { dates, sessions }
}

function isComplete(form) {
  return Boolean(form.leave_type_id && form.from_date && form.to_date && form.to_date >= form.from_date)
}

/** What a type offers in the list: what is left of it — or, unpaid with no limit, that it is cut from pay. */
function optionLabel(b) {
  if (b.unlimited) return `${b.name} — unpaid, no limit`
  return `${b.name} — ${b.available} day${b.available !== 1 ? 's' : ''} available${b.is_paid === false ? ' (unpaid)' : ''}`
}

/** "12 Jan" or "12 – 14 Jan 2027": a part's days. */
const span = (from, to) => (from === to ? formatDay(from) : `${formatDay(from, { year: false })} – ${formatDay(to)}`)

export default function ApplyLeaveModal({ open, onClose, onSave, saving, initialDates = null }) {
  const balanceQuery = useLeaveBalances()
  // A list that failed offers nothing to choose — not the types it held before.
  // Paid types first, as before; unpaid ones (Loss of Pay) after them.
  const balances = balanceQuery.isError ? [] : [...(balanceQuery.data ?? [])].sort((a, b) => Number(a.is_paid === false) - Number(b.is_paid === false))
  const preview = usePreviewLeave()

  // Opened from an absent day (client, 10 Oct 2026): on its dates already.
  const [form, setForm] = useState(() => (initialDates ? { ...EMPTY, ...initialDates } : EMPTY))
  const [errors, setErrors] = useState({})
  // …and what they would cost is asked as soon as the types are in, once — as
  // choosing the dates by hand would ask it.
  const askedFirst = useRef(false)
  const firstType = balances[0]?.leave_type_id
  useEffect(() => {
    if (askedFirst.current || !initialDates || !firstType) return
    askedFirst.current = true
    preview.mutate({ leave_type_id: firstType, from_date: initialDates.from_date, to_date: initialDates.to_date, half_day_dates: [], half_day_sessions: {} })
  }, [firstType, initialDates, preview])

  if (!open) return null

  // The first type is the default until somebody chooses — derived, not stored,
  // so it is right the moment the list arrives.
  const typeId = form.leave_type_id || balances[0]?.leave_type_id || ''
  const current = { ...form, leave_type_id: typeId }
  const selected = balances.find((b) => b.leave_type_id === typeId)
  const halfDaysFor = (id) => balances.find((b) => b.leave_type_id === id)?.half_day_allowed !== false
  const halves = halvesOf(current, halfDaysFor(typeId))

  function set(field, value) {
    const next = { ...current, [field]: value }
    setForm(next)
    setErrors((e) => ({ ...e, [field]: '' }))

    // Asked as soon as the question is complete, so the cost is on screen
    // before the Submit button is.
    if (field !== 'reason' && isComplete(next)) {
      const halves = halvesOf(next, halfDaysFor(next.leave_type_id))
      preview.mutate({
        leave_type_id: next.leave_type_id,
        from_date: next.from_date,
        to_date: next.to_date,
        half_day_dates: halves.dates,
        half_day_sessions: halves.sessions,
      })
    } else if (field !== 'reason') {
      preview.reset()
    }
  }

  function close() {
    setForm(EMPTY)
    setErrors({})
    preview.reset()
    onClose()
  }

  function validate() {
    const e = {}
    if (!typeId) e.leave_type_id = 'Required'
    if (!current.from_date) e.from_date = 'Required'
    if (!current.to_date) e.to_date = 'Required'
    else if (current.from_date && current.to_date < current.from_date) e.to_date = 'Must be after start date'
    if (current.reason.trim().length < 3) e.reason = 'Give a reason, even a short one'
    return e
  }

  /**
   * Sent whole — or, with `offer`, as the preview offered (client, 9 Oct 2026):
   * the days the balance covers, and the rest as unpaid leave. The days it
   * covered go with it: a balance changed since is refused by the server, and
   * the offer is asked for again, so what is on screen is what is applied for.
   */
  async function handleSubmit(e, offer = null) {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }

    // No employee id and no day count. The server knows who is asking, and it
    // counts the days itself — a number sent from here would be a claim the
    // balance believed.
    //
    // Closed only once the request is saved. Closing first, as before, threw
    // away what was typed whenever the server said no.
    const saved = await onSave({
      leave_type_id: typeId,
      from_date: current.from_date,
      to_date: current.to_date,
      half_day_dates: halves.dates,
      half_day_sessions: halves.sessions,
      reason: current.reason.trim(),
      ...(offer ? { rest_leave_type_id: offer.rest_leave_type_id, covered_days: offer.parts.find((p) => p.leave_type_id === typeId)?.days ?? 0 } : {}),
    }).then(() => true, () => false)

    if (saved) close()
    else if (offer) preview.mutate({ leave_type_id: typeId, from_date: current.from_date, to_date: current.to_date, half_day_dates: halves.dates, half_day_sessions: halves.sessions })
  }

  const result = preview.data
  const problem = result?.problem
  const offer = result?.offer ?? null

  return (
    // Scrolls when taller than a phone's screen, rather than cutting off its buttons.
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-gray-950/45 backdrop-blur-[2px] p-3 sm:p-4 overflow-y-auto"
      role="dialog" aria-modal="true" aria-label="Apply for Leave">
      <EscapeCloses onClose={onClose} />
      <div className="bg-white rounded-2xl shadow-[0_30px_70px_-20px_rgba(26,16,41,0.5)] w-full max-w-lg my-4">

        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Apply for Leave</h2>
            <p className="text-sm text-gray-400 mt-0.5">Submit a new leave request</p>
          </div>
          <button onClick={close} aria-label="Close" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">

          {/* Leave type — the company's own, with what is left of each */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-600">Leave Type <span className="text-red-400">*</span></label>
            {/* The balances are the choices: failed, they show the error and a
                way to try again, not an empty list or zero days. */}
            <DataState query={balanceQuery} compact
              loading={<span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading leave types…</span>}
              empty={
                <p className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  No leave types are set up for you yet. Ask HR to configure them.
                </p>
              }>
              <select value={typeId} onChange={(e) => set('leave_type_id', e.target.value)}
                aria-label="Leave type" className={`w-full ${field}`}>
                {balances.map((b) => (
                  <option key={b.leave_type_id} value={b.leave_type_id}>{optionLabel(b)}</option>
                ))}
              </select>
            </DataState>
            {errors.leave_type_id && <p className="text-xs text-red-500">{errors.leave_type_id}</p>}
            {/* Working from home is a request, not leave (client, 9 Oct 2026). */}
            <p className="text-xs text-gray-500 flex items-start gap-1.5">
              <Home className="w-3.5 h-3.5 mt-px shrink-0 text-gray-400" aria-hidden="true" />
              <span>
                Working from home? That is a request, not leave:{' '}
                <Link to="/requests?new=work_from_home" onClick={close} className="font-semibold text-brand-600 hover:underline">Requests → Work from home</Link>.
              </span>
            </p>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-600">From Date <span className="text-red-400">*</span></label>
              <input type="date" value={current.from_date} onChange={(e) => set('from_date', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-gray-900
                  ${errors.from_date ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
              {errors.from_date && <p className="text-xs text-red-500">{errors.from_date}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-600">To Date <span className="text-red-400">*</span></label>
              <input type="date" value={current.to_date} min={current.from_date} onChange={(e) => set('to_date', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-gray-900
                  ${errors.to_date ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
              {errors.to_date && <p className="text-xs text-red-500">{errors.to_date}</p>}
            </div>
          </div>

          {/* Full day, or which half (client §37) — where the type allows half days. */}
          {isComplete(current) && halfDaysFor(typeId) && (
            current.from_date === current.to_date ? (
              <label className="block space-y-1.5">
                <span className="text-sm font-medium text-gray-600">Day</span>
                <select value={current.first_part} onChange={(e) => set('first_part', e.target.value)} className={`w-full ${field}`}>
                  <option value="full">Full day</option>
                  <option value="first_half">First half</option>
                  <option value="second_half">Second half</option>
                </select>
              </label>
            ) : (
              <div className="grid grid-cols-2 gap-4">
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-gray-600">First day</span>
                  <select value={current.first_part === 'second_half' ? 'second_half' : 'full'} onChange={(e) => set('first_part', e.target.value)} className={`w-full ${field}`}>
                    <option value="full">Full day</option>
                    <option value="second_half">From the second half</option>
                  </select>
                </label>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium text-gray-600">Last day</span>
                  <select value={current.last_part} onChange={(e) => set('last_part', e.target.value)} className={`w-full ${field}`}>
                    <option value="full">Full day</option>
                    <option value="first_half">Until the first half</option>
                  </select>
                </label>
              </div>
            )
          )}

          {/* The server's count — weekly offs and holidays already taken out */}
          {preview.isPending && (
            <p className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Counting working days…</p>
          )}
          {result && !preview.isPending && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-3 py-2.5 bg-brand-50 border border-brand-100 rounded-lg">
                <CalendarDays className="w-4 h-4 text-brand-500 shrink-0" />
                <p className="text-sm text-brand-700 font-medium">
                  {result.days} day{result.days !== 1 ? 's' : ''} of leave · {selected?.name}
                  <span className="font-normal text-brand-600">
                    {result.unlimited ? ' · unpaid: these days are cut from pay' : ` · ${result.balance.available} available`}
                  </span>
                </p>
              </div>
              {/* Why it cannot go as it is — "earned a month at a time" — even when the rest is offered as unpaid below. */}
              {problem && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-800">{problem.message}</p>
                </div>
              )}
              {/* The balance runs out: the rest as unpaid leave, in one application. */}
              {offer && (
                <section aria-label="Apply in parts" className="px-3 py-3 bg-amber-50 border border-amber-200 rounded-lg space-y-2.5">
                  <p className="flex items-start gap-2 text-sm text-amber-900">
                    <Split className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" aria-hidden="true" />
                    <span>{offer.message}</span>
                  </p>
                  <ul className="space-y-1.5">
                    {offer.parts.map((p) => (
                      <li key={p.leave_type_id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
                        <span className={`inline-flex items-center min-h-5.5 py-0.5 px-2.5 rounded-full text-[11.5px] font-semibold ${typeColourOf(p.leave_type, p.is_paid)}`}>{p.leave_type_name}</span>
                        <span className="text-gray-700 tabular-nums">{span(p.from_date, p.to_date)} · {p.days} day{p.days === 1 ? '' : 's'}</span>
                      </li>
                    ))}
                  </ul>
                  <button type="button" onClick={(e) => handleSubmit(e, offer)} disabled={saving} className={`${btn.primary} w-full sm:w-auto`}>
                    {saving && <Loader2 className="w-4 h-4 animate-spin" />}
                    Apply like this
                  </button>
                </section>
              )}
            </div>
          )}

          {/* Reason */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-600">Reason <span className="text-red-400">*</span></label>
            <textarea rows={3} value={current.reason} onChange={(e) => set('reason', e.target.value)}
              placeholder="Briefly describe the reason for your leave…"
              className={`w-full border rounded-lg px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent
                placeholder:text-gray-400 text-gray-900 ${errors.reason ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
            {errors.reason && <p className="text-xs text-red-500">{errors.reason}</p>}
          </div>

          <div className="flex flex-wrap justify-end gap-3 pt-1">
            <button type="button" onClick={close}
              className={btn.secondary}>
              Cancel
            </button>
            <button type="submit" disabled={saving || Boolean(problem) || balances.length === 0}
              className={btn.primary}>
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Submit Request
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
