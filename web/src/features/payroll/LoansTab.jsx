import { useState } from 'react'
import { Plus, Trash2, Ban } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import ConfirmDialog from '../../components/ConfirmDialog'
import DataState from '../../components/DataState'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn } from '../../lib/dates'
import { optionsNote } from '../../lib/optionsNote'
import { useLoans, useRecordLoan, useCloseLoan, useDeleteLoan } from '../../hooks/usePayrollExtras'
import { usePayrollPeople } from './people'
import { money, monthLabel, parseMonthValue } from './format'

const STATUS = {
  active: { label: 'Being recovered', cls: 'bg-blue-100 text-blue-700' },
  repaid: { label: 'Repaid', cls: 'bg-emerald-100 text-emerald-700' },
  closed: { label: 'Closed', cls: 'bg-gray-100 text-gray-600' },
}

/**
 * Loans and salary advances (client §40): lent once, recovered from pay a
 * fixed amount a month. What is left is worked out from the payslips, so a
 * payroll recalculated twice recovers once.
 */
export default function LoansTab() {
  const can = useAuthStore((s) => s.can)
  const canManage = can('payroll:structure:manage')
  const query = useLoans()
  const close = useCloseLoan()
  const remove = useDeleteLoan()
  const [adding, setAdding] = useState(false)
  const [closing, setClosing] = useState(null)
  const [removing, setRemoving] = useState(null)
  const [note, setNote] = useState('')

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-gray-600 max-w-3xl">
          Each month’s installment is deducted on the payslip — never more than the month pays. Close one repaid in cash or written off; nothing more is recovered.
        </p>
        {canManage && (
          <button onClick={() => setAdding(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
            <Plus className="w-4 h-4" /> Record a loan or advance
          </button>
        )}
      </div>

      <DataState query={query} empty="No loans or advances recorded.">
        {(rows) => (
          <ul className="space-y-3">
            {rows.map((l) => {
              const s = STATUS[l.status]
              return (
                <li key={l.id} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-gray-900">{l.full_name}</span>
                      <span className="text-xs text-gray-400 font-mono">{l.employee_code}</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${s.cls}`}>{s.label}</span>
                    </div>
                    <p className="text-sm text-gray-700">
                      {l.kind === 'loan' ? 'Loan' : 'Salary advance'} of {money(l.amount)} · {money(l.installment)} a month from {monthLabel(l.start_year, l.start_month)}
                    </p>
                    <p className="text-xs text-gray-500">
                      Recovered {money(l.recovered)}{l.in_draft > 0 ? ` (+ ${money(l.in_draft)} in a draft payroll)` : ''} · left {money(l.left)}
                      {l.note ? ` · ${l.note}` : ''}{l.closed_note ? ` · closed: ${l.closed_note}` : ''}
                    </p>
                  </div>
                  {canManage && l.status === 'active' && (
                    <div className="flex gap-2 shrink-0">
                      <button onClick={() => { setClosing(l); setNote('') }} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-gray-300 text-xs font-medium text-gray-700 hover:bg-gray-50"><Ban className="w-3.5 h-3.5" /> Close</button>
                      {l.recovered === 0 && l.in_draft === 0 && (
                        <button onClick={() => setRemoving(l)} aria-label={`Remove ${l.full_name}'s ${l.kind}`} className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600"><Trash2 className="w-4 h-4" /></button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </DataState>

      {adding && <LoanDialog onClose={() => setAdding(false)} />}
      {closing && (
        <ConfirmDialog title={`Close ${closing.full_name}'s ${closing.kind === 'loan' ? 'loan' : 'advance'}?`} confirmLabel="Close it" disabled={note.trim().length < 3}
          onConfirm={() => close.mutateAsync({ id: closing.id, note: note.trim() }).then(() => toast.success('Closed — nothing more will be recovered'))}
          onClose={() => setClosing(null)}>
          <p>{money(closing.left)} is still owed. Nothing more is recovered once it is closed.</p>
          <label className="block space-y-1.5 mt-3">
            <span className="text-sm font-medium text-gray-700">Why</span>
            <input className={inputCls} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Repaid in cash, written off…" />
          </label>
        </ConfirmDialog>
      )}
      {removing && (
        <ConfirmDialog title="Remove this record?" confirmLabel="Remove" danger
          onConfirm={() => remove.mutateAsync({ id: removing.id }).then(() => toast.success('Removed'))}
          onClose={() => setRemoving(null)}>
          <p>For one recorded by mistake: nothing has been recovered of it yet.</p>
        </ConfirmDialog>
      )}
    </div>
  )
}

function LoanDialog({ onClose }) {
  const record = useRecordLoan()
  const people = usePayrollPeople()
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const today = calendarDayIn(timezone)
  const [f, setF] = useState({ employeeId: '', kind: 'advance', amount: '', installment: '', start: today.slice(0, 7), note: '' })
  const set = (key, value) => setF({ ...f, [key]: value })
  const months = f.amount && f.installment ? Math.ceil(Number(f.amount) / Number(f.installment)) : null

  async function submit(e) {
    e.preventDefault()
    const { year, month } = parseMonthValue(f.start)
    const done = await record
      .mutateAsync({ employeeId: f.employeeId, kind: f.kind, amount: Number(f.amount), installment: Number(f.installment), startYear: year, startMonth: month, note: f.note.trim() || null })
      .then(() => true, () => false)
    if (done) {
      toast.success('Recorded — it is recovered from the payroll of that month')
      onClose()
    }
  }

  return (
    <Dialog title="Record a loan or salary advance" onClose={record.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-700">Employee</span>
          <select className={inputCls} value={f.employeeId} onChange={(e) => set('employeeId', e.target.value)} required>
            <option value="">Choose…</option>
            {people.people.map((p) => <option key={p.id} value={p.id} disabled={Boolean(p.salaryGoesTo)}>{p.name} ({p.code}){p.salaryGoesTo ? ` — goes to ${p.salaryGoesTo}` : ''}</option>)}
          </select>
          {optionsNote(people) && <span className="block text-xs text-gray-500">{optionsNote(people)}</span>}
        </label>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Kind</span>
            <select className={inputCls} value={f.kind} onChange={(e) => set('kind', e.target.value)}>
              <option value="advance">Salary advance</option>
              <option value="loan">Loan</option>
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">First month recovered</span>
            <input type="month" className={inputCls} value={f.start} onChange={(e) => set('start', e.target.value)} required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Amount (₹)</span>
            <input type="number" min="1" step="0.01" className={inputCls} value={f.amount} onChange={(e) => set('amount', e.target.value)} required />
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium text-gray-700">Recovered each month (₹)</span>
            <input type="number" min="1" step="0.01" max={f.amount || undefined} className={inputCls} value={f.installment} onChange={(e) => set('installment', e.target.value)} required />
          </label>
        </div>
        {months !== null && Number.isFinite(months) && <p className="text-xs text-gray-500">Recovered over {months} month{months === 1 ? '' : 's'}.</p>}
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-700">Note (optional)</span>
          <input className={inputCls} value={f.note} onChange={(e) => set('note', e.target.value)} maxLength={500} />
        </label>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={record.isPending} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={record.isPending} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60">{record.isPending ? 'Saving…' : 'Record'}</button>
        </div>
      </form>
    </Dialog>
  )
}
