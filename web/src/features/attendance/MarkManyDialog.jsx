import { useState } from 'react'
import { ArrowRight } from 'lucide-react'
import Dialog from '../../components/Dialog'
import { Chip } from '../../components/ui/bits'
import { btn, field } from '../../components/ui/styles'
import { STATUS } from '../../lib/attendance'
import { formatDay } from '../../lib/dates'
import { useMarkMany } from '../../hooks/useAttendance'

/**
 * Mark the people ticked (client, 25 Oct 2026) — the morning the app was down,
 * an office shut for the rain. ONLY those ticked; each is marked as marking
 * them one by one would, with the reason kept on every day. Before saving it
 * says, person by person, what their day is and what it will be. A day with a
 * check-in is never in the list: its times are its evidence, and it is opened
 * on its own.
 */

/** "On leave" is applied for and approved, never typed over a day in bulk. */
const CHOICES = ['present', 'half_day', 'absent', 'holiday', 'weekly_off']

export default function MarkManyDialog({ date, people: ticked, onClose, onDone }) {
  const mark = useMarkMany()
  // The people as they were when it opened: the roster refreshes underneath, and somebody who
  // checked in meanwhile must still be named in the answer, not dropped from it.
  const [people] = useState(ticked)
  const [status, setStatus] = useState('present')
  const [note, setNote] = useState('')
  const [result, setResult] = useState(null)
  const nameOf = new Map(people.map((p) => [p.id, p.full_name]))

  async function submit(e) {
    e.preventDefault()
    const done = await mark.mutateAsync({ date, employeeIds: people.map((p) => p.id), status, note: note.trim() }).catch(() => null)
    if (!done) return
    if (done.refused.length === 0) onDone(done.marked.length)
    else setResult(done)
  }

  if (result) {
    return (
      <Dialog title="Marked, with some left out" onClose={() => onDone(result.marked.length)}>
        <p className="text-sm text-gray-700">{result.marked.length} marked {STATUS[status].label.toLowerCase()} on {formatDay(date)}. These were not:</p>
        <ul className="divide-y divide-gray-100 rounded-lg border border-gray-200">
          {result.refused.map((r) => (
            <li key={r.employee_id} className="px-3 py-2 text-sm">
              <p className="font-semibold text-gray-900">{nameOf.get(r.employee_id) ?? 'Somebody'}</p>
              <p className="text-xs text-gray-600">{r.reason}</p>
            </li>
          ))}
        </ul>
        <div className="flex justify-end"><button type="button" onClick={() => onDone(result.marked.length)} className={btn.primary}>Done</button></div>
      </Dialog>
    )
  }

  return (
    <Dialog title={`Mark ${people.length} ${people.length === 1 ? 'person' : 'people'} — ${formatDay(date)}`} onClose={mark.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-700">Mark as</span>
          <select value={status} onChange={(e) => setStatus(e.target.value)} className={`w-full ${field}`}>
            {CHOICES.map((s) => <option key={s} value={s}>{STATUS[s].label}</option>)}
          </select>
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-700">Why</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} required minLength={3}
            placeholder="The app was down this morning" className={`w-full ${field}`} />
          <span className="block text-xs text-gray-500">Kept on every day marked, and in the audit log.</span>
        </label>

        <div>
          <p className="text-sm font-medium text-gray-700 mb-1.5">Only these people</p>
          <ul className="max-h-64 overflow-y-auto divide-y divide-gray-100 rounded-lg border border-gray-200" aria-label="The people to mark">
            {people.map((p) => {
              const now = p.status ? STATUS[p.status] : null
              return (
                <li key={p.id} className="px-3 py-2 flex items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0 truncate font-semibold text-gray-900">{p.full_name}</span>
                  {now ? <Chip tone={now.tone}>{now.label}</Chip> : <Chip tone="gray" dot={false}>Not marked</Chip>}
                  <ArrowRight className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-label="becomes" />
                  <Chip tone={STATUS[status].tone}>{STATUS[status].label}</Chip>
                </li>
              )
            })}
          </ul>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} disabled={mark.isPending} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={mark.isPending || note.trim().length < 3} className={btn.primary}>
            {mark.isPending ? 'Marking…' : `Mark ${people.length} ${people.length === 1 ? 'person' : 'people'}`}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
