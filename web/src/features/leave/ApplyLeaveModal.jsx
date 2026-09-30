import { useState } from 'react'
import { X, CalendarDays, AlertCircle, Loader2 } from 'lucide-react'
import { useLeaveBalances, usePreviewLeave } from '../../hooks/useLeave'
import DataState from '../../components/DataState'

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

const EMPTY = { leave_type_id: '', from_date: '', to_date: '', reason: '' }

function isComplete(form) {
  return Boolean(form.leave_type_id && form.from_date && form.to_date && form.to_date >= form.from_date)
}

export default function ApplyLeaveModal({ open, onClose, onSave, saving }) {
  const balanceQuery = useLeaveBalances()
  // A list that failed offers nothing to choose — not the types it held before.
  const balances = balanceQuery.isError ? [] : balanceQuery.data ?? []
  const preview = usePreviewLeave()

  const [form, setForm] = useState(EMPTY)
  const [errors, setErrors] = useState({})

  if (!open) return null

  // The first type is the default until somebody chooses — derived, not stored,
  // so it is right the moment the list arrives.
  const typeId = form.leave_type_id || balances[0]?.leave_type_id || ''
  const current = { ...form, leave_type_id: typeId }
  const selected = balances.find((b) => b.leave_type_id === typeId)

  function set(field, value) {
    const next = { ...current, [field]: value }
    setForm(next)
    setErrors((e) => ({ ...e, [field]: '' }))

    // Asked as soon as the question is complete, so the cost is on screen
    // before the Submit button is.
    if (field !== 'reason' && isComplete(next)) {
      preview.mutate({
        leave_type_id: next.leave_type_id,
        from_date: next.from_date,
        to_date: next.to_date,
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

  async function handleSubmit(e) {
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
      reason: current.reason.trim(),
    }).then(() => true, () => false)

    if (saved) close()
  }

  const result = preview.data
  const problem = result?.problem

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg">

        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">Apply for Leave</h2>
            <p className="text-sm text-gray-400 mt-0.5">Submit a new leave request</p>
          </div>
          <button onClick={close} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
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
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 bg-white">
                {balances.map((b) => (
                  <option key={b.leave_type_id} value={b.leave_type_id}>
                    {b.name} — {b.available} day{b.available !== 1 ? 's' : ''} available
                  </option>
                ))}
              </select>
            </DataState>
            {errors.leave_type_id && <p className="text-xs text-red-500">{errors.leave_type_id}</p>}
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-600">From Date <span className="text-red-400">*</span></label>
              <input type="date" value={current.from_date} onChange={(e) => set('from_date', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900
                  ${errors.from_date ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
              {errors.from_date && <p className="text-xs text-red-500">{errors.from_date}</p>}
            </div>
            <div className="space-y-1.5">
              <label className="text-sm font-medium text-gray-600">To Date <span className="text-red-400">*</span></label>
              <input type="date" value={current.to_date} min={current.from_date} onChange={(e) => set('to_date', e.target.value)}
                className={`w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900
                  ${errors.to_date ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
              {errors.to_date && <p className="text-xs text-red-500">{errors.to_date}</p>}
            </div>
          </div>

          {/* The server's count — weekly offs and holidays already taken out */}
          {preview.isPending && (
            <p className="text-sm text-gray-400 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Counting working days…</p>
          )}
          {result && !preview.isPending && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 px-3 py-2.5 bg-blue-50 border border-blue-100 rounded-lg">
                <CalendarDays className="w-4 h-4 text-blue-500 shrink-0" />
                <p className="text-sm text-blue-700 font-medium">
                  {result.days} working day{result.days !== 1 ? 's' : ''} · {selected?.name}
                  <span className="font-normal text-blue-600"> · {result.balance.available} available</span>
                </p>
              </div>
              {problem && (
                <div className="flex items-start gap-2 px-3 py-2.5 bg-amber-50 border border-amber-200 rounded-lg">
                  <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
                  <p className="text-sm text-amber-800">{problem.message}</p>
                </div>
              )}
            </div>
          )}

          {/* Reason */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-600">Reason <span className="text-red-400">*</span></label>
            <textarea rows={3} value={current.reason} onChange={(e) => set('reason', e.target.value)}
              placeholder="Briefly describe the reason for your leave…"
              className={`w-full border rounded-lg px-3 py-2.5 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent
                placeholder:text-gray-400 text-gray-900 ${errors.reason ? 'border-red-400 bg-red-50' : 'border-gray-300'}`} />
            {errors.reason && <p className="text-xs text-red-500">{errors.reason}</p>}
          </div>

          <div className="flex justify-end gap-3 pt-1">
            <button type="button" onClick={close}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">
              Cancel
            </button>
            <button type="submit" disabled={saving || Boolean(problem) || balances.length === 0}
              className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium transition-colors flex items-center gap-2">
              {saving && <Loader2 className="w-4 h-4 animate-spin" />}
              Submit Request
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
