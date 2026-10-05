import { useMemo, useState } from 'react'
import { Search, IndianRupee, Loader2, AlertCircle, History, Info } from 'lucide-react'
import { useSalaryRoster, useSalaryHistory, usePayrollComponents, useSetSalary } from '../../hooks/useSalary'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn, addDays, formatDay } from '../../lib/dates'
import DataState, { DataRows } from '../../components/DataState'
import Dialog, { inputCls } from '../../components/Dialog'
import { Avatar, Chip } from '../../components/ui/bits'
import { btn, card, field, th } from '../../components/ui/styles'
import { monthLabel } from './format'

/** "2026-10-15" → "October 2026". */
const monthOf = (day) => monthLabel(Number(day.slice(0, 4)), Number(day.slice(5, 7)))
/** The 1st of the month after the day's. */
const firstOfMonthAfter = (day) => addDays(`${day.slice(0, 7)}-28`, 7).slice(0, 7) + '-01'

/**
 * The Salary Structure tab: who is paid what, from the server.
 *
 * Each row is what is stored, or "No salary recorded", which is the list
 * Accounts works through before the first payroll run can pay anybody. (It
 * replaced a table that showed an ESTIMATE for everybody — CTC divided by
 * twelve and split by fixed percentages — labelled as their salary.)
 */

function money(value) {
  return value == null ? '—' : '₹' + Number(value).toLocaleString('en-IN')
}

export default function SalaryStructures() {
  const salaries = useSalaryRoster()
  const roster = useMemo(() => salaries.data ?? [], [salaries.data])
  const canManage = useAuthStore((state) => state.can('payroll:structure:manage'))
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return roster
    return roster.filter((e) => e.full_name.toLowerCase().includes(q) || e.employee_code.toLowerCase().includes(q))
  }, [roster, search])

  const missing = roster.filter((e) => !e.salary).length
  const action = (emp) => (
    <>
      <button onClick={() => setEditing(emp)} className={btn.softSm}>
        {canManage && emp.may_enter !== false ? (emp.salary ? 'Change' : 'Set salary') : 'History'}
      </button>
      {/* Own work goes up the company tree (Day 22): whom it goes to instead. */}
      {canManage && emp.may_enter === false && (
        <p className="text-xs text-gray-400 mt-1">Entered by {emp.entry_goes_to}</p>
      )}
    </>
  )

  return (
    <div className="space-y-4">
      {missing > 0 && salaries.isSuccess && (
        <div className="flex items-start gap-2.5 p-3 rounded-xl bg-amber-50 border border-amber-200">
          <AlertCircle className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-800">
            {missing} employee{missing !== 1 ? 's have' : ' has'} no salary recorded. A payroll run cannot pay them until one is set.
          </p>
        </div>
      )}

      <div className={`${card} overflow-hidden`}>
        <div className="px-4 py-3 flex items-center gap-3 border-b border-gray-200">
          <label className="relative flex-1">
            <span className="sr-only">Search by name or code</span>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
            <input type="text" placeholder="Search by name or code…" value={search} onChange={(e) => setSearch(e.target.value)} className={`w-full pl-9 ${field}`} />
          </label>
          <span className="text-xs font-medium text-gray-500 shrink-0">{salaries.isSuccess ? `${filtered.length} employees` : '—'}</span>
        </div>

        {/* A computer: the table. */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-190 text-sm">
            <thead>
              <tr>
                <th className={th}>Employee</th>
                <th className={th}>Department</th>
                <th className={th}>Joined</th>
                <th className={`${th} text-right`}>Gross / month</th>
                <th className={`${th} text-right`}>Annual CTC</th>
                <th className={th}>Since</th>
                <th className={th} aria-label="Salary" />
              </tr>
            </thead>
            <tbody>
              <DataRows query={salaries} colSpan={7} empty="No employees found." isEmpty={() => filtered.length === 0}>
              {() => filtered.map((emp) => (
                <tr key={emp.employee_id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={emp.full_name} size="sm" />
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">{emp.full_name}</p>
                        <p className="text-xs text-gray-400 font-mono">{emp.employee_code}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-gray-700">{emp.department || '—'}</td>
                  <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDay(emp.date_of_joining)}</td>
                  {emp.salary ? (
                    <>
                      <td className="px-4 py-3 text-right font-bold text-gray-900 tabular-nums">{money(emp.salary.gross_monthly)}</td>
                      <td className="px-4 py-3 text-right text-gray-700 tabular-nums">{money(emp.salary.ctc)}</td>
                      <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDay(emp.salary.effective_from)}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="px-4 py-3"><Chip tone="warn">No salary recorded</Chip></td>
                  )}
                  <td className="px-4 py-3 text-right">{action(emp)}</td>
                </tr>
              ))}
              </DataRows>
            </tbody>
          </table>
        </div>

        {/* A phone: a line a person, the pay under the name. */}
        <div className="md:hidden">
          <DataState query={salaries} empty="No employees found." isEmpty={() => filtered.length === 0}>
            {() => (
              <ul className="divide-y divide-gray-100" aria-label="Salaries">
                {filtered.map((emp) => (
                  <li key={emp.employee_id} className="px-4 py-3 flex items-center gap-3">
                    <Avatar name={emp.full_name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-900 truncate">{emp.full_name}</p>
                      {emp.salary
                        ? <p className="text-xs text-gray-500 tabular-nums">{money(emp.salary.gross_monthly)} / month · CTC {money(emp.salary.ctc)}</p>
                        : <Chip tone="warn" className="mt-1">No salary recorded</Chip>}
                    </div>
                    <div className="text-right shrink-0">{action(emp)}</div>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </div>
      </div>

      {editing && (
        <SalaryModal key={editing.employee_id} employee={editing} canManage={canManage && editing.may_enter !== false} onClose={() => setEditing(null)} />
      )}
    </div>
  )
}

/**
 * Setting a salary, with the history beside it.
 *
 * The date decides what happens, and the form says which before saving:
 * the same date as the current salary is a CORRECTION; a later one is a RAISE
 * that closes the current salary the day before; an earlier one is refused.
 */
function SalaryModal({ employee, canManage, onClose }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const catalogue = usePayrollComponents()
  const record = useSalaryHistory(employee.employee_id)
  const setSalary = useSetSalary()

  const current = employee.salary
  const today = calendarDayIn(timezone)
  const firstOfNextMonth = firstOfMonthAfter(today)

  // Fixed components only. Incentive and its kind are entered month by month
  // at payroll time, and the server refuses them on a salary.
  const fixed = (catalogue.data ?? []).filter((c) => c.entry === 'fixed')
  const monthly = (catalogue.data ?? []).filter((c) => c.entry === 'monthly')

  const [effectiveFrom, setEffectiveFrom] = useState(
    current ? firstOfNextMonth : (employee.date_of_joining ?? today),
  )
  const [ctc, setCtc] = useState(current ? String(current.ctc) : '')
  const [amounts, setAmounts] = useState(() =>
    Object.fromEntries((current?.components ?? []).map((c) => [c.code, String(c.amount)])),
  )

  const byCode = Object.fromEntries(fixed.map((c) => [c.code, c]))
  const value = (code) => Number(amounts[code] || 0)
  const earnings = fixed.filter((c) => c.type === 'earning').reduce((sum, c) => sum + value(c.code), 0)
  // The gross of the salary in force now — what a month changed inside is still paid on.
  const currentGross = (current?.components ?? []).filter((c) => byCode[c.code]?.type === 'earning').reduce((sum, c) => sum + Number(c.amount || 0), 0)
  const deductions = fixed.filter((c) => c.type === 'deduction').reduce((sum, c) => sum + value(c.code), 0)

  const mode = !current
    ? 'first'
    : effectiveFrom === current.effective_from
      ? 'correction'
      : effectiveFrom > current.effective_from
        ? 'raise'
        : 'earlier'

  const ctcNumber = Number(ctc || 0)
  // A CTC below the gross it contains is almost certainly a typo — a missing
  // zero. Said, not blocked: the company's definition of CTC is its own.
  const ctcBelowGross = ctc !== '' && ctcNumber < earnings * 12

  async function handleSave(e) {
    e.preventDefault()
    const components = Object.keys(byCode)
      .filter((code) => amounts[code] !== undefined && amounts[code] !== '')
      .map((code) => ({ code, amount: Number(amounts[code]) }))

    const saved = await setSalary
      .mutateAsync({ employeeId: employee.employee_id, effectiveFrom, ctc: ctcNumber, components })
      .then(() => true, () => false)
    if (saved) onClose()
  }

  return (
    <Dialog title={`Salary — ${employee.full_name}`} onClose={setSalary.isPending ? () => {} : onClose} wide>
      <p className="text-sm text-gray-500 -mt-1">{employee.employee_code} · joined {formatDay(employee.date_of_joining)}</p>

      {canManage && (
        <form onSubmit={handleSave} className="space-y-5">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="space-y-1.5 block">
              <span className="text-sm font-semibold text-gray-700">Starts from <span className="text-red-400">*</span></span>
              <input type="date" required value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inputCls} />
            </label>
            <label className="space-y-1.5 block">
              <span className="text-sm font-semibold text-gray-700">Annual CTC (₹) <span className="text-red-400">*</span></span>
              <input type="number" required min="0" step="1" value={ctc} onChange={(e) => setCtc(e.target.value)} placeholder="e.g. 480000" className={inputCls} />
            </label>
          </div>

          {/* What saving will do, in words, before it is done */}
          <div className={`text-sm rounded-lg px-3 py-2.5 border ${mode === 'earlier' ? 'bg-red-50 border-red-200 text-red-700' : 'bg-brand-50 border-brand-100 text-brand-800'}`}>
            {mode === 'first' && <>First salary, from {formatDay(effectiveFrom)}.</>}
            {mode === 'correction' && <>Correction — replaces the figures of the salary that started {formatDay(current.effective_from)}. Nothing else changes.</>}
            {mode === 'raise' && <>New salary from {formatDay(effectiveFrom)}. The current one ends {formatDay(addDays(effectiveFrom, -1))} and stays in the history unchanged.</>}
            {mode === 'earlier' && <>The current salary started {formatDay(current.effective_from)}. A new one cannot start before it — use that date to correct it, or a later date for a new salary.</>}
          </div>

          {/* A new salary inside a month: that month is paid on the current one,
              and its payslip gives what the days from then are owed, as arrears. */}
          {mode === 'raise' && effectiveFrom.slice(8) !== '01' && (
            <div className="text-sm rounded-lg px-3 py-2.5 border bg-amber-50 border-amber-200 text-amber-900 space-y-1.5" role="note">
              <p>
                It starts inside a month: {monthOf(effectiveFrom)} is still paid on the current salary.{' '}
                {earnings > currentGross
                  ? <>Its payslip says how much the days from {formatDay(effectiveFrom, { year: false })} are owed — to enter as Arrears for that month.</>
                  : earnings < currentGross
                    ? <>Its payslip says how much the days from {formatDay(effectiveFrom, { year: false })} are overpaid — to recover the month after.</>
                    : <>The gross is the same, so nothing is owed for those days.</>}
                {' '}Starting on the 1st avoids it.
              </p>
              <button type="button" onClick={() => setEffectiveFrom(firstOfMonthAfter(effectiveFrom))} className={btn.secondarySm}>
                Start on {formatDay(firstOfMonthAfter(effectiveFrom))} instead
              </button>
            </div>
          )}

          <div>
            <p className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2">
              <IndianRupee className="w-4 h-4 text-emerald-600" aria-hidden="true" /> Monthly components
            </p>
            {/* The totals too: without the components they would read ₹0 for somebody who is paid. */}
            <DataState query={catalogue} compact
              loading={<span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Loading components…</span>}>
              {() => (
              <div className="space-y-5">
                <div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {fixed.map((c) => (
                      <label key={c.code} className="space-y-1 block">
                        <span className="text-xs font-semibold text-gray-600">
                          {c.label}{c.type === 'deduction' && <span className="text-red-500"> (deduction)</span>}
                          {c.counts_for_pf && <span className="text-gray-400"> · PF</span>}
                        </span>
                        <input type="number" min="0" step="1" value={amounts[c.code] ?? ''}
                          onChange={(e) => setAmounts((a) => ({ ...a, [c.code]: e.target.value }))}
                          placeholder="0" className={inputCls} />
                      </label>
                    ))}
                  </div>
                  {monthly.length > 0 && (
                    <p className="text-xs text-gray-500 mt-2 flex items-start gap-1.5">
                      <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />
                      {monthly.map((c) => c.label).join(', ')} {monthly.length > 1 ? 'are' : 'is'} entered each month at payroll time, not here.
                    </p>
                  )}
                </div>

                <div className="grid grid-cols-3 gap-2 sm:gap-3 text-center">
                  <Stat label="Gross / month" value={money(earnings)} />
                  <Stat label="Deductions / month" value={money(deductions)} />
                  <Stat label="Gross / year" value={money(earnings * 12)} />
                </div>
              </div>
              )}
            </DataState>
          </div>

          {ctcBelowGross && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              The CTC is less than a year of gross pay ({money(earnings * 12)}). Check for a missing digit.
            </p>
          )}

          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <button type="button" onClick={onClose} disabled={setSalary.isPending} className={btn.secondary}>Cancel</button>
            <button type="submit" disabled={setSalary.isPending || mode === 'earlier' || earnings <= 0} className={btn.primary}>
              {setSalary.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              {mode === 'correction' ? 'Save correction' : 'Save salary'}
            </button>
          </div>
        </form>
      )}

      <div>
        <p className="text-sm font-bold text-gray-900 mb-2 flex items-center gap-2">
          <History className="w-4 h-4 text-gray-500" aria-hidden="true" /> History
        </p>
        <DataState query={record} compact empty="No salary has ever been recorded." isEmpty={(r) => r.history.length === 0}>
          {(r) => (
          <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
            {r.history.map((h) => (
              <div key={h.effective_from} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">
                    {formatDay(h.effective_from)} — {h.effective_to ? formatDay(h.effective_to) : 'now'}
                  </p>
                  <p className="text-xs text-gray-500 wrap-break-word">
                    {h.components.map((c) => `${c.label} ${money(c.amount)}`).join(' · ')}
                  </p>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-bold text-gray-900 tabular-nums">{money(h.gross_monthly)}/mo</p>
                  <p className="text-xs text-gray-400 tabular-nums">CTC {money(h.ctc)}</p>
                </div>
              </div>
            ))}
          </div>
          )}
        </DataState>
      </div>
    </Dialog>
  )
}

function Stat({ label, value }) {
  return (
    <div className="bg-gray-50 border border-gray-200 rounded-xl py-2.5 px-1">
      <p className="text-[11px] text-gray-500">{label}</p>
      <p className="text-sm font-bold text-gray-900 tabular-nums">{value}</p>
    </div>
  )
}
