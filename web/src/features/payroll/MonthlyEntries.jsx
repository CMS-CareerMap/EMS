import { useMemo, useState } from 'react'
import { Plus, Pencil, Trash2, Loader2, Info } from 'lucide-react'
import { toast } from 'sonner'
import { useMonthlyEntries, useSetMonthlyEntry, useDeleteMonthlyEntry, usePayrollRuns } from '../../hooks/usePayroll'
import { usePayrollComponents } from '../../hooks/useSalary'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn } from '../../lib/dates'
import { usePayrollPeople } from './people'
import Dialog, { inputCls } from '../../components/Dialog'
import { DataRows, QueryError } from '../../components/DataState'
import { optionsNote } from '../../lib/optionsNote'
import { money, monthLabel, recentMonths, monthAfter, monthValue, parseMonthValue, RUN_STATUS } from './format'
import { Avatar } from '../../components/ui/bits'
import { btn, card, field, th } from '../../components/ui/styles'

/**
 * Amounts entered for one month — the client's Incentive — per employee.
 *
 * HR enters them; the next payroll run for the month picks them up. An amount
 * is SET, not added to: entering ₹5,000 twice leaves ₹5,000, not ₹10,000.
 */
export default function MonthlyEntries() {
  const can = useAuthStore((s) => s.can)
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const today = calendarDayIn(timezone)
  const months = useMemo(() => {
    const back = recentMonths(today, 12)
    return [monthAfter(back[0]), ...back]
  }, [today])

  const [selectedValue, setSelectedValue] = useState(() => monthValue(months[1]))
  const selected = parseMonthValue(selectedValue)
  const label = monthLabel(selected.year, selected.month)

  const components = usePayrollComponents()
  const monthly = (components.data ?? []).filter((c) => c.entry === 'monthly')
  const entriesQuery = useMonthlyEntries(selected.year, selected.month)
  const entries = { ...entriesQuery, data: entriesQuery.data?.rows }
  const entryList = entries.data ?? []
  // People whose amounts go to somebody above them (Day 22), and whom to ask.
  const blocked = entriesQuery.data?.blocked ?? new Map()
  const canSeeRuns = can('payroll:structure:read')
  const runs = usePayrollRuns({ enabled: canSeeRuns })
  const run = (runs.data ?? []).find((r) => r.year === selected.year && r.month === selected.month)
  const closed = Boolean(run && run.status !== 'draft')
  // Whether the month is closed is not known until the runs have answered, so
  // nothing is offered for editing before then — an open-looking month that
  // is really approved would only earn a refusal.
  const locked = closed || (canSeeRuns && !runs.isSuccess)
  // The components and the runs only shape the hints above the table; a
  // failure is said once there, rather than as "no component" or an open month.
  const failures = [components, runs].filter((q) => q.isError)
  const failed = failures[0]

  const [editing, setEditing] = useState(null)
  const [removing, setRemoving] = useState(null)

  return (
    <div className="space-y-4">
      <div className={`${card} p-4 flex flex-wrap items-end justify-between gap-4`}>
        <label className="space-y-1.5 w-full sm:w-auto">
          <span className="block text-xs font-semibold text-gray-600">Month</span>
          <select value={selectedValue} onChange={(e) => setSelectedValue(e.target.value)} className={`${field} w-full sm:w-auto`}>
            {months.map((m) => <option key={monthValue(m)} value={monthValue(m)}>{monthLabel(m.year, m.month)}</option>)}
          </select>
        </label>
        {monthly.length > 0 && (
          <button onClick={() => setEditing({})} disabled={locked} className={`${btn.primary} w-full sm:w-auto`}>
            <Plus className="w-4 h-4" aria-hidden="true" /> Add {monthly.length === 1 ? monthly[0].label.toLowerCase() : 'an amount'}
          </button>
        )}
      </div>

      {failed && (
        <div className={card}>
          <QueryError error={failed.error} onRetry={() => failures.forEach((q) => q.refetch())} retrying={failures.some((q) => q.isFetching)} compact />
        </div>
      )}
      {!runs.isError && run && run.status === 'draft' && (
        <Hint>A draft payroll for {label} exists. Recalculate it after changing these amounts, or approval will ask you to.</Hint>
      )}
      {!runs.isError && closed && (
        <Hint>The {label} payroll is {RUN_STATUS[run.status].label.toLowerCase()}, so its amounts are closed. Reopen the payroll to change them.</Hint>
      )}
      {components.isSuccess && monthly.length === 0 && (
        <Hint>This company has no pay component entered month by month.</Hint>
      )}

      <div className={`${card} overflow-hidden`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-160 text-sm">
            <thead>
              <tr>
                <th className={th}>Employee</th>
                <th className={th}>Component</th>
                <th className={`${th} text-right`}>Amount</th>
                <th className={th}>Note</th>
                <th className={th} aria-label="Change" />
              </tr>
            </thead>
            <tbody>
              <DataRows query={entries} colSpan={5} empty={`Nothing entered for ${label}.`}>
              {(list) => list.map((entry) => (
                <tr key={entry.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={entry.full_name} size="sm" />
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">{entry.full_name}</p>
                        <p className="text-xs text-gray-400 font-mono">{entry.employee_code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{entry.component_label}</td>
                  <td className="px-4 py-3 text-right font-bold text-gray-900 tabular-nums">{money(entry.amount)}</td>
                  <td className="px-4 py-3 text-gray-500">{entry.note || '—'}</td>
                  <td className="px-4 py-3">
                    {!locked && (blocked.has(entry.employee_id) ? (
                      <p className="text-right text-xs text-gray-400 italic">Goes to {blocked.get(entry.employee_id).ask}</p>
                    ) : (
                      <div className="flex justify-end gap-1">
                        <button onClick={() => setEditing(entry)} aria-label={`Change ${entry.full_name}'s ${entry.component_label}`}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-gray-700 hover:bg-gray-100"><Pencil className="w-4 h-4" /></button>
                        <button onClick={() => setRemoving(entry)} aria-label={`Remove ${entry.full_name}'s ${entry.component_label}`}
                          className="p-1.5 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50"><Trash2 className="w-4 h-4" /></button>
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
              </DataRows>
            </tbody>
          </table>
        </div>
      </div>

      {editing && <EntryDialog entry={editing} entries={entryList} blocked={blocked} month={selected} components={monthly} onClose={() => setEditing(null)} />}
      {removing && <RemoveDialog entry={removing} onClose={() => setRemoving(null)} />}
    </div>
  )
}

function Hint({ children }) {
  return (
    <p className="flex gap-2 text-sm text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
      <Info className="w-4 h-4 shrink-0 mt-0.5 text-gray-400" /> {children}
    </p>
  )
}

function EntryDialog({ entry, entries, blocked, month, components, onClose }) {
  const staff = usePayrollPeople()
  const save = useSetMonthlyEntry()
  const existing = Boolean(entry.id)
  const [employeeId, setEmployeeId] = useState(entry.employee_id ?? '')
  const [componentCode, setComponentCode] = useState(entry.component_code ?? components[0]?.code ?? '')
  const [amount, setAmount] = useState(entry.amount ? String(entry.amount) : '')
  const [note, setNote] = useState(entry.note ?? '')
  const label = monthLabel(month.year, month.month)

  async function handleSubmit(e) {
    e.preventDefault()
    const ok = await save.mutateAsync({
      employeeId, componentCode, year: month.year, month: month.month, amount: Number(amount), note: note.trim() || null,
    }).then(() => true, () => false)
    if (ok) {
      toast.success(`Saved for ${label}`)
      onClose()
    }
  }

  const component = components.find((c) => c.code === componentCode)
  // Saving SETS the amount: one already there is replaced, not added to.
  const replacing = !existing && entries.find((e) => e.employee_id === employeeId && e.component_code === componentCode)

  return (
    <Dialog title={`${existing ? 'Change' : 'Add'} ${component?.label.toLowerCase() ?? 'amount'} — ${label}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Employee</span>
          {existing ? (
            <input className={inputCls} value={`${entry.full_name} (${entry.employee_code})`} disabled />
          ) : (
            <select className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required disabled={staff.isLoading}>
              <option value="">{optionsNote(staff, 'Choose a person')}</option>
              {/* Somebody whose amount goes up the company tree is offered, but cannot be chosen. */}
              {staff.people.map((p) => (
                <option key={p.id} value={p.id} disabled={blocked.has(p.id)}>
                  {p.name} ({p.code}){blocked.has(p.id) ? ` — goes to ${blocked.get(p.id).ask}` : ''}
                </option>
              ))}
            </select>
          )}
        </label>
        {components.length > 1 && (
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-600">Component</span>
            <select className={inputCls} value={componentCode} onChange={(e) => setComponentCode(e.target.value)} disabled={existing}>
              {components.map((c) => <option key={c.code} value={c.code}>{c.label}</option>)}
            </select>
          </label>
        )}
        {replacing && (
          <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-2.5">
            {replacing.full_name} already has {money(replacing.amount)} for {label}. Saving replaces it.
          </p>
        )}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Amount for {label} (₹)</span>
          <input className={inputCls} type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} required />
        </label>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Note <span className="text-gray-400 font-normal">(optional)</span></span>
          <input className={inputCls} value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="For example: Q2 sales target" />
        </label>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" onClick={onClose} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={save.isPending} className={btn.primary}>
            {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function RemoveDialog({ entry, onClose }) {
  const remove = useDeleteMonthlyEntry()
  const label = monthLabel(entry.year, entry.month)
  async function handle() {
    const ok = await remove.mutateAsync({ id: entry.id, year: entry.year, month: entry.month }).then(() => true, () => false)
    if (ok) {
      toast.success('Removed')
      onClose()
    }
  }
  return (
    <Dialog title={`Remove ${entry.full_name}'s ${entry.component_label.toLowerCase()}?`} onClose={onClose}>
      <p className="text-sm text-gray-600">{money(entry.amount)} for {label} will no longer be paid.</p>
      <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
        <button onClick={onClose} className={btn.secondary}>Keep it</button>
        <button onClick={handle} disabled={remove.isPending} className={btn.danger}>Remove</button>
      </div>
    </Dialog>
  )
}
