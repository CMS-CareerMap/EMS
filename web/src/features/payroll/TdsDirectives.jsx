import { useMemo, useState } from 'react'
import { Plus, Loader2, Info } from 'lucide-react'
import { toast } from 'sonner'
import { useTdsDirectives, useSetTdsDirective } from '../../hooks/usePayroll'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn } from '../../lib/dates'
import { usePayrollPeople } from './people'
import Dialog, { inputCls } from '../../components/Dialog'
import DataState from '../../components/DataState'
import { optionsNote } from '../../lib/optionsNote'
import { btn, card, field, th } from '../../components/ui/styles'
import {
  money, formatDay, monthLabel, financialYearOf, financialYearLabel, monthValue, parseMonthValue,
} from './format'

/**
 * Income tax (TDS), as the company works it out — this screen records it, it
 * does not calculate it.
 *
 * Off by default: the client deducts no income tax through payroll. When it is
 * off this says so and records nothing, because a directive that no payroll
 * run reads would look like tax was being deducted when it is not.
 */
export default function TdsDirectives() {
  const can = useAuthStore((s) => s.can)
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const today = calendarDayIn(timezone)
  const currentFy = financialYearOf(Number(today.slice(0, 4)), Number(today.slice(5, 7)))
  const years = [currentFy + 1, currentFy, currentFy - 1]
  const [fy, setFy] = useState(currentFy)
  const tds = useTdsDirectives(fy)
  const [adding, setAdding] = useState(false)

  // Only from an answer: a request that failed must not read as "TDS is off".
  const enabled = tds.isSuccess && tds.data.tdsEnabled
  const canManage = can('payroll:structure:manage')

  return (
    <div className="space-y-4">
      <div className={`${card} p-4 flex flex-wrap items-end justify-between gap-4`}>
        <label className="space-y-1.5">
          <span className="block text-xs font-semibold text-gray-600">Financial year</span>
          <select value={fy} onChange={(e) => setFy(Number(e.target.value))} className={field}>
            {years.map((y) => <option key={y} value={y}>{financialYearLabel(y)} (April – March)</option>)}
          </select>
        </label>
        {enabled && canManage && (
          <button onClick={() => setAdding(true)} className={btn.primary}>
            <Plus className="w-4 h-4" /> Set monthly TDS
          </button>
        )}
      </div>

      <DataState query={tds}>
        {({ directives, tdsEnabled }) => (
        <>
        {!tdsEnabled && (
          <div className="flex gap-3 rounded-xl border border-brand-200 bg-brand-50 p-4 text-sm text-brand-900">
            <Info className="w-5 h-5 shrink-0 text-brand-600" />
            <div className="space-y-1">
              <p className="font-semibold">Income tax (TDS) is not deducted through payroll</p>
              <p>Payslips carry no income tax line, and nothing entered here would be used. If the company starts deducting TDS, a super admin turns it on under Settings → Payroll Config; each person's monthly amount is then recorded here.</p>
            </div>
          </div>
        )}

        {(tdsEnabled || directives.length > 0) && (
          <div className={`${card} overflow-hidden`}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-160 text-sm">
                <thead>
                  <tr>
                    <th className={th}>Employee</th>
                    <th className={th}>From</th>
                    <th className={`${th} text-right`}>Each month</th>
                    <th className={th}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {directives.length === 0 && (
                    <tr><td colSpan={4} className="px-4 py-10 text-center text-gray-400">No TDS recorded for {financialYearLabel(fy)}.</td></tr>
                  )}
                  {directives.map((d) => (
                    <tr key={d.id} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-medium text-gray-900">{d.full_name}</p>
                        <p className="text-xs text-gray-400 font-mono">{d.employee_code}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-700">{formatDay(d.effective_from)}</td>
                      <td className="px-4 py-3 text-right font-medium text-gray-900">{money(d.monthly_amount)}</td>
                      <td className="px-4 py-3 text-gray-500">{d.reason || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
        </>
        )}
      </DataState>

      {adding && <DirectiveDialog fy={fy} onClose={() => setAdding(false)} />}
    </div>
  )
}

function DirectiveDialog({ fy, onClose }) {
  const staff = usePayrollPeople()
  const save = useSetTdsDirective()
  // April of the year to March of the next.
  const months = useMemo(() => Array.from({ length: 12 }, (_, i) => {
    const month = ((i + 3) % 12) + 1
    return { year: month >= 4 ? fy : fy + 1, month }
  }), [fy])
  const [employeeId, setEmployeeId] = useState('')
  const [from, setFrom] = useState(monthValue(months[0]))
  const [amount, setAmount] = useState('')
  const [reason, setReason] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    const { year, month } = parseMonthValue(from)
    const ok = await save.mutateAsync({
      employeeId, year, month, monthlyAmount: Number(amount), reason: reason.trim() || null,
    }).then(() => true, () => false)
    if (ok) {
      toast.success('TDS recorded')
      onClose()
    }
  }

  return (
    <Dialog title={`Monthly TDS — ${financialYearLabel(fy)}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-gray-700">Employee</span>
          <select className={inputCls} value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} required disabled={staff.isLoading}>
            <option value="">{optionsNote(staff, 'Choose a person')}</option>
            {/* Tax on one's own pay, or a fellow salary-enterer's, goes up the company tree (Day 22). */}
            {staff.people.map((p) => (
              <option key={p.id} value={p.id} disabled={Boolean(p.salaryGoesTo)}>
                {p.name} ({p.code}){p.salaryGoesTo ? ` — goes to ${p.salaryGoesTo}` : ''}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold text-gray-700">From</span>
            <select className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)}>
              {months.map((m) => <option key={monthValue(m)} value={monthValue(m)}>{monthLabel(m.year, m.month)}</option>)}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-semibold text-gray-700">Each month (₹)</span>
            <input className={inputCls} type="number" min="0" step="1" value={amount} onChange={(e) => setAmount(e.target.value)} required />
          </label>
        </div>
        <label className="block space-y-1.5">
          <span className="text-sm font-semibold text-gray-700">Reason <span className="text-gray-400 font-normal">(needed for ₹0)</span></span>
          <input className={inputCls} value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)}
            required={amount !== '' && Number(amount) === 0} placeholder="For example: income below the taxable limit" />
        </label>
        <p className="text-xs text-gray-500">It holds from that month until a later entry replaces it, and ends with the financial year.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={save.isPending} className={btn.primary}>
            {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}
