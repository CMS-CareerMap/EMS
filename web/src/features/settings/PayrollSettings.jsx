import { useMemo, useState } from 'react'
import { Plus, Trash2, Edit2, X, History, Info } from 'lucide-react'
import {
  usePayrollSettings, useSavePayroll, usePayrollHistory, usePtSlabs, useSetPtTable, usePfComponents, useSetPfComponent,
} from '../../hooks/useSettings'
import { toast } from 'sonner'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn, addDays } from '../../lib/dates'
import DataState from '../../components/DataState'
import { Section, Field, SaveBar, Toggle, inpSm } from './ui'
import { MONTHS, formatDay } from './format'

/**
 * The Payroll Config tab.
 *
 * The version this replaces could not be opened: it read a PT field the server
 * never sends and called .toLocaleString() on nothing, which took the whole
 * Settings page down. Behind that, Pay Day offered "Last working day" to a
 * field that stores a day number, Payslip lock was an on/off switch for a day
 * number, the PF ceiling switch the client asked for was missing, and the PT
 * section was two slabs for one state that were never saved.
 *
 * Rates are a POLICY with dates. Saving on a later day starts a new period and
 * leaves the old one exactly as it was, so a payslip from last month is still
 * explained by last month's rates.
 */

const FIELDS = [
  ['pf_employee', 'pfEmployeeRate'],
  ['pf_employer', 'pfEmployerRate'],
  ['pf_restrict_to_ceiling', 'pfRestrictToCeiling'],
  ['pf_wage_ceiling', 'pfWageCeiling'],
  ['eps_wage_ceiling', 'epsWageCeiling'],
  ['wages_share_enabled', 'wagesShareEnabled'],
  ['wages_share_percent', 'wagesSharePercent'],
  ['esi_employee', 'esiEmployeeRate'],
  ['esi_employer', 'esiEmployerRate'],
  ['esi_threshold', 'esiThreshold'],
  ['pay_day', 'payDay'],
  ['payslip_lock', 'payslipLockDay'],
  ['fiscal_year_start_month', 'fiscalYearStartMonth'],
  ['lop_basis', 'lopBasis'],
  ['sandwich_rule', 'sandwichRule'],
  ['tds_enabled', 'tdsEnabled'],
]

const DAYS = Array.from({ length: 28 }, (_, i) => i + 1)

/** What one day of pay is, for each basis the server knows. */
const LOP_BASES = [
  {
    value: 'calendar_days',
    label: 'Monthly pay ÷ days in the month',
    hint: 'A day is a 30th of September and a 31st of October — always exactly one day of that month.',
  },
  {
    value: 'fixed_30',
    label: 'Monthly pay ÷ 30, every month',
    hint: 'Every month counts as 30 days, February included. A full month is always the full salary.',
  },
  {
    value: 'working_days',
    label: 'Monthly pay ÷ working days in the month',
    hint: 'Days in the month less weekly offs and holidays, so a day costs more in a month with more holidays.',
  },
]

/** A form value as the server wants it: numbers as numbers, blank as null. */
function asValue(key, value) {
  if (key === 'pf_restrict_to_ceiling' || key === 'sandwich_rule' || key === 'tds_enabled' || key === 'wages_share_enabled') return Boolean(value)
  if (key === 'lop_basis') return value || null
  if (value === '' || value == null) return null
  return Number(value)
}

export default function PayrollSettings() {
  const settings = usePayrollSettings()
  const history = usePayrollHistory()
  const canEdit = useAuthStore((state) => state.can('settings:update'))

  // The rates form only once the stored rates are here: a form drawn over a
  // failed load would offer blanks that Save could write over them. PT has its
  // own request, so it does not wait for this one.
  return (
    <div className="space-y-6">
      <DataState query={settings} loading="Loading payroll settings…">
        {(policy) => <PolicyForm policy={policy} history={history} canEdit={canEdit} />}
      </DataState>

      <PfComponents canEdit={canEdit} />

      <PtTables canEdit={canEdit} />
    </div>
  )
}

function PolicyForm({ policy, history, canEdit }) {
  const savePayroll = useSavePayroll()

  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const form = draft ?? policy

  function set(key, value) {
    setDraft({ ...form, [key]: value })
    setSaved(false)
  }

  // Only what actually changed. Saving an unchanged form on a later day would
  // otherwise open a new period identical to the last — noise in the history.
  const changes = Object.fromEntries(
    FIELDS.filter(([key]) => asValue(key, form[key]) !== asValue(key, policy[key]))
      .map(([key, body]) => [body, asValue(key, form[key])]),
  )
  const changed = Object.keys(changes).length > 0

  async function handleSave() {
    const ok = await savePayroll.mutateAsync(changes).then(() => true, () => false)
    if (ok) {
      setDraft(null)
      setSaved(true)
    }
  }

  // Counted only from an answer. When the history could not be read the link
  // still shows, and opening it shows why.
  const earlier = history.data ? history.data.length - 1 : null

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200">
        <Info className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
        <div className="text-xs text-slate-600 space-y-1">
          <p>
            These rates have been in force since <span className="font-semibold">{formatDay(policy.effective_from)}</span>.
            Saving on a later day starts a new period from that day; the rates before it stay as they were for payslips already issued.
          </p>
          {(history.isError || earlier > 0) && (
            <button type="button" onClick={() => setShowHistory((v) => !v)} className="inline-flex items-center gap-1 font-semibold text-blue-600 hover:text-blue-800">
              <History className="w-3.5 h-3.5" /> {showHistory ? 'Hide' : 'Show'} earlier rates{earlier > 0 ? ` (${earlier})` : ''}
            </button>
          )}
        </div>
      </div>

      {showHistory && (
        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100 bg-white">
          <DataState query={history} compact>
            {(periods) => periods.map((p) => (
            <div key={p.id} className="px-4 py-2.5 flex items-center justify-between text-sm">
              <span className="font-medium text-gray-800">{formatDay(p.effective_from)} — {p.effective_to ? formatDay(p.effective_to) : 'now'}</span>
              <span className="text-xs text-gray-500">PF {p.pf_employee}% / {p.pf_employer}% · ESI {p.esi_employee}% / {p.esi_employer}% up to ₹{Number(p.esi_threshold).toLocaleString('en-IN')} · pay day {p.pay_day} · wages rule {p.wages_share_enabled ? `${p.wages_share_percent}%` : 'off'}</span>
            </div>
            ))}
          </DataState>
        </div>
      )}

      <Section title="Provident Fund (PF)" desc="Percentages of PF wages — Basic, DA and any component marked as counting for PF.">
        <Field label="Employee Contribution">
          <PercentInput value={form.pf_employee} onChange={(v) => set('pf_employee', v)} disabled={!canEdit} />
        </Field>
        <Field label="Employer Contribution" hint="Split by payroll into pension (EPS) and provident fund (EPF)">
          <PercentInput value={form.pf_employer} onChange={(v) => set('pf_employer', v)} disabled={!canEdit} />
        </Field>
        <Field label="Restrict to the Wage Ceiling" hint="On: contributions are worked out on PF wages up to the ceiling — ₹3,000 a month at 12% of ₹25,000. Off: on full PF wages.">
          <Toggle checked={Boolean(form.pf_restrict_to_ceiling)} onChange={(v) => set('pf_restrict_to_ceiling', v)} disabled={!canEdit} label="Restrict PF to the wage ceiling" />
        </Field>
        <Field label="Wage Ceiling" hint="The statutory EPF ceiling — ₹25,000 from 17 Sep 2026, ₹15,000 before. Kept as a setting so a revision is not a code change.">
          <MoneyInput value={form.pf_wage_ceiling} onChange={(v) => set('pf_wage_ceiling', v)} disabled={!canEdit} />
        </Field>
        <Field label="Pension (EPS) Ceiling" hint="The employer's pension share is 8.33% of PF wages up to this — ₹1,250 a month at ₹15,000, ₹2,083 at ₹25,000. The rest of the employer's share goes to EPF. Confirm the figure with your accountant.">
          <MoneyInput value={form.eps_wage_ceiling} onChange={(v) => set('eps_wage_ceiling', v)} disabled={!canEdit} />
        </Field>
      </Section>

      <Section title="Labour Codes: Wages Rule" desc="Under the Code on Wages, what is left out of wages (HRA, conveyance, commission and the like) may not be more than a set share of the whole pay; the excess counts as wages. On, PF wages are at least that share of what each person earned in the month. Confirm with your accountant before turning it on.">
        <Field label="Apply the Wages Rule" hint="Off: PF is worked out on the components marked as counting for PF, as before. Saved after the 1st, a change applies from the next month’s payroll: each month is worked out on the rules in force on its first day (a joiner’s, on their first day).">
          <Toggle checked={Boolean(form.wages_share_enabled)} onChange={(v) => set('wages_share_enabled', v)} disabled={!canEdit} label="Apply the Labour Codes wages rule" />
        </Field>
        <Field label="Minimum Share of Wages" hint={`One half by law, unless the government notifies another share. At ${form.wages_share_percent || 50}%, somebody earning ₹30,000 with a Basic of ₹10,000 pays PF on ₹${Math.max(10000, Math.round(30000 * (Number(form.wages_share_percent) || 50) / 100)).toLocaleString('en-IN')}.`}>
          <PercentInput value={form.wages_share_percent} step="1" min="1" onChange={(v) => set('wages_share_percent', v)} disabled={!canEdit} label="Minimum share of wages in percent" />
        </Field>
      </Section>

      <Section title="ESI (Employee State Insurance)" desc="Coverage is decided on the wage rate at the start of each six-month contribution period, and holds until it ends.">
        <Field label="Employee Contribution" hint="% of gross paid">
          <PercentInput value={form.esi_employee} step="0.01" onChange={(v) => set('esi_employee', v)} disabled={!canEdit} />
        </Field>
        <Field label="Employer Contribution" hint="% of gross paid">
          <PercentInput value={form.esi_employer} step="0.01" onChange={(v) => set('esi_employer', v)} disabled={!canEdit} />
        </Field>
        <Field label="Wage Threshold" hint="Covered when the monthly wage RATE is at or below this at the period's start">
          <MoneyInput value={form.esi_threshold} onChange={(v) => set('esi_threshold', v)} disabled={!canEdit} />
        </Field>
      </Section>

      <Section title="Payroll Schedule" desc="Day numbers stop at 28 so every month has them — a 30th silently does not exist in February.">
        <Field label="Pay Day">
          <select className={inpSm} value={form.pay_day ?? ''} onChange={(e) => set('pay_day', e.target.value)} disabled={!canEdit}>
            {DAYS.map((d) => <option key={d} value={d}>{d} of the month</option>)}
          </select>
        </Field>
        <Field label="Lock Payslips On" hint="After this day of the following month, a month's payslips cannot be edited">
          <select className={inpSm} value={form.payslip_lock ?? ''} onChange={(e) => set('payslip_lock', e.target.value)} disabled={!canEdit}>
            <option value="">Not locked automatically</option>
            {DAYS.map((d) => <option key={d} value={d}>{d} of the month</option>)}
          </select>
        </Field>
        <Field label="Financial Year Starts" hint="For reports. Income tax always runs April to March, whatever this says.">
          <select className={inpSm} value={form.fiscal_year_start_month ?? ''} onChange={(e) => set('fiscal_year_start_month', e.target.value)} disabled={!canEdit}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </Field>
      </Section>

      <Section title="Loss of Pay" desc="How an unpaid day is counted. Weekly offs and holidays inside someone's employment are paid — unless the sandwich rule below takes them.">
        <Field label="One Day's Pay" hint={LOP_BASES.find((b) => b.value === form.lop_basis)?.hint}>
          <select className={`${inpSm} w-full sm:w-auto max-w-full`} value={form.lop_basis ?? 'calendar_days'} onChange={(e) => set('lop_basis', e.target.value)} disabled={!canEdit}>
            {LOP_BASES.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
          </select>
        </Field>
        <Field label="Sandwich Rule" hint="On: a weekly off or holiday between two days of loss of pay is unpaid too — absent Saturday and Monday costs the Sunday as well.">
          <Toggle checked={Boolean(form.sandwich_rule)} onChange={(v) => set('sandwich_rule', v)} disabled={!canEdit} label="Apply the sandwich rule" />
        </Field>
      </Section>

      <Section title="Income Tax (TDS)" desc="Whether salary has income tax deducted through payroll.">
        <Field label="Deduct TDS through payroll" hint="Off: no Income Tax line on payslips, and no TDS amounts are asked for before a run. Turn it on once anybody's taxable income crosses the limit — TDS on salary is then compulsory.">
          <Toggle checked={Boolean(form.tds_enabled)} onChange={(v) => set('tds_enabled', v)} disabled={!canEdit} label="Deduct TDS through payroll" />
        </Field>
      </Section>

      {canEdit && <SaveBar onSave={handleSave} saving={savePayroll.isPending} saved={saved} disabled={!changed} />}
    </div>
  )
}

/**
 * Which earnings PF is worked out on. Each switch saves on its own, as the
 * document checklist's do: it is one decision, not part of the rates form.
 */
function PfComponents({ canEdit }) {
  const components = usePfComponents()
  const setPf = useSetPfComponent()

  async function change(component, countsForPf) {
    const ok = await setPf.mutateAsync({ id: component.id, countsForPf }).then(() => true, () => false)
    if (ok) toast.success(`${component.label} ${countsForPf ? 'now counts' : 'no longer counts'} as PF wages. Recalculate any draft payroll.`)
  }

  return (
    <Section title="What Counts as PF Wages" desc="The earnings PF is worked out on: Basic and DA to start. Under the Labour Codes an allowance paid to everybody, such as Special Allowance, may count too. By law HRA and conveyance are not wages. Ask your accountant. A payroll calculated after a change follows it — recalculate any draft — and a month past draft keeps what it was paid on. Pension (EPS) membership recorded on an employee's record does not change with it.">
      <DataState query={components} compact>
        {(rows) => (
          <div className="divide-y divide-gray-100">
            {rows.map((c) => (
              <div key={c.id} className="flex items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-gray-800">{c.label}</p>
                  <p className="text-xs text-gray-400">{c.entry === 'monthly' ? 'Entered each month' : 'On the salary'}</p>
                </div>
                <label className="flex items-center gap-2 text-xs text-gray-600 shrink-0">
                  <Toggle checked={c.counts_for_pf} disabled={!canEdit || setPf.isPending} onChange={(v) => change(c, v)} label={`${c.label} counts as PF wages`} />
                  PF wages
                </label>
              </div>
            ))}
            {!canEdit && <p className="py-3 text-xs text-gray-500">Set by the Super Admin.</p>}
          </div>
        )}
      </DataState>
    </Section>
  )
}

function PercentInput({ value, onChange, disabled, step = '0.01', min = '0', label }) {
  return (
    <div className="flex items-center gap-2">
      <input type="number" min={min} max="100" step={step} className={`${inpSm} w-28`} value={value ?? ''}
        onChange={(e) => onChange(e.target.value)} disabled={disabled} aria-label={label} />
      <span className="text-sm text-gray-500">%</span>
    </div>
  )
}

function MoneyInput({ value, onChange, disabled }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-sm text-gray-500">₹</span>
      <input type="number" min="0" step="1" className={`${inpSm} w-32`} value={value ?? ''}
        onChange={(e) => onChange(e.target.value)} disabled={disabled} />
      <span className="text-sm text-gray-400">/ month</span>
    </div>
  )
}

// ─── Professional tax ───────────────────────────────────────────────────────

const GENDER_LABEL = { any: 'Everyone', male: 'Men', female: 'Women' }
const GENDER_ORDER = { any: 0, male: 1, female: 2 }

/** The server sorts by amount across genders; read as a table, each gender's slabs belong together. */
function bySlab(a, b) {
  return (GENDER_ORDER[a.gender] ?? 9) - (GENDER_ORDER[b.gender] ?? 9) || a.min_gross - b.min_gross
}

/** A revision usually starts with a month, so the month being paid keeps one table. */
function firstOfNextMonth(day) {
  const [year, month] = day.split('-').map(Number)
  return month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`
}

function money(value) {
  return value == null ? '—' : `₹${Number(value).toLocaleString('en-IN')}`
}

/**
 * Every state's PT table, and a way to set one.
 *
 * Each slab says where it STARTS; the server works out where it ends, so a
 * table cannot have a gap. It refuses a table that could take more than
 * ₹2,500 a year — the constitutional cap — and says why.
 */
function PtTables({ canEdit }) {
  const ptSlabs = usePtSlabs()
  const slabs = ptSlabs.data
  const [adding, setAdding] = useState(false)

  const states = useMemo(() => {
    const byState = new Map()
    for (const slab of slabs ?? []) {
      if (!byState.has(slab.state)) byState.set(slab.state, [])
      byState.get(slab.state).push(slab)
    }
    return [...byState.entries()]
      .map(([state, rows]) => [state, [...rows].sort(bySlab)])
      .sort(([a], [b]) => a.localeCompare(b))
  }, [slabs])

  return (
    <Section title="Professional Tax (PT)" desc="Per state. An employee pays the table for the state recorded as where they work; women and men can have different slabs.">
      <div className="py-3 space-y-4">
        <DataState query={ptSlabs} compact empty="No state has a PT table yet.">
          {states.map(([state, rows]) => (
            <PtState key={state} state={state} rows={rows} canEdit={canEdit} />
          ))}
        </DataState>

        {adding && <PtState state="" rows={[]} canEdit={canEdit} startEditing onDone={() => setAdding(false)} />}

        {/* Only once the tables are known, so a state that already has one is seen before another is started for it. */}
        {canEdit && !adding && ptSlabs.isSuccess && (
          <button type="button" onClick={() => setAdding(true)}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-blue-600 hover:text-blue-800">
            <Plus className="w-4 h-4" /> Add a state
          </button>
        )}
      </div>
    </Section>
  )
}

function PtState({ state, rows, canEdit, startEditing = false, onDone }) {
  const [editing, setEditing] = useState(startEditing)
  const isNew = !state

  return (
    <div className="border border-gray-200 rounded-xl overflow-hidden">
      {editing ? (
        <PtEditor state={state} rows={rows} isNew={isNew}
          onClose={() => { setEditing(false); onDone?.() }} />
      ) : (
        <>
          <div className="flex items-center justify-between px-4 py-2.5 bg-gray-50 border-b border-gray-200">
            <div>
              <p className="text-sm font-semibold text-gray-900">{state}</p>
              <p className="text-xs text-gray-500">In force since {formatDay(rows[0]?.effective_from)}</p>
            </div>
            {canEdit && (
              <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800">
                <Edit2 className="w-3.5 h-3.5" /> Change
              </button>
            )}
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-2 text-left font-semibold">Applies to</th>
                <th className="px-4 py-2 text-left font-semibold">Monthly gross</th>
                <th className="px-4 py-2 text-left font-semibold">PT / month</th>
                <th className="px-4 py-2 text-left font-semibold">In February</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} className="border-t border-gray-100">
                  <td className="px-4 py-2 text-gray-700">{GENDER_LABEL[row.gender] ?? row.gender}</td>
                  <td className="px-4 py-2 text-gray-700">{money(row.min_gross)} {row.max_gross == null ? 'and above' : `to ${money(row.max_gross)}`}</td>
                  <td className="px-4 py-2 font-medium text-gray-900">{money(row.amount)}</td>
                  <td className="px-4 py-2 text-gray-600">{row.february_amount == null ? 'same' : money(row.february_amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  )
}

function PtEditor({ state, rows, isNew, onClose }) {
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const setTable = useSetPtTable()
  const today = calendarDayIn(timezone)
  const currentFrom = rows[0]?.effective_from ?? null

  const [name, setName] = useState(state)
  const [effectiveFrom, setEffectiveFrom] = useState(currentFrom ? firstOfNextMonth(today) : today)
  const [draft, setDraft] = useState(() =>
    rows.length > 0
      ? rows.map((r) => ({ gender: r.gender, from: String(r.min_gross), amount: String(r.amount), februaryAmount: r.february_amount == null ? '' : String(r.february_amount) }))
      : [{ gender: 'any', from: '0', amount: '0', februaryAmount: '' }],
  )
  const [error, setError] = useState('')

  const mode = !currentFrom ? 'first'
    : effectiveFrom === currentFrom ? 'correction'
    : effectiveFrom > currentFrom ? 'revision'
    : 'earlier'

  function update(i, key, value) {
    setDraft(draft.map((row, j) => (j === i ? { ...row, [key]: value } : row)))
  }

  async function handleSave() {
    setError('')
    const body = {
      state: name.trim(),
      effectiveFrom,
      slabs: draft.map((row) => ({
        gender: row.gender,
        from: Number(row.from || 0),
        amount: Number(row.amount || 0),
        februaryAmount: row.februaryAmount === '' ? null : Number(row.februaryAmount),
      })),
    }
    // The server's reasons, shown next to the table they are about, as well as
    // in the toast — "capped at ₹2,500" means little once the toast is gone.
    const ok = await setTable.mutateAsync(body).then(() => true, (err) => { setError(err.message); return false })
    if (ok) onClose()
  }

  return (
    <div className="p-4 space-y-3 bg-blue-50/30">
      <div className="flex items-center justify-between gap-3">
        {isNew ? (
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="State, e.g. Karnataka" className={`${inpSm} w-64`} maxLength={50} />
        ) : (
          <p className="text-sm font-semibold text-gray-900">{state}</p>
        )}
        <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400" title="Cancel"><X className="w-4 h-4" /></button>
      </div>

      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-gray-500 uppercase tracking-wider">
            <th className="py-1.5 text-left font-semibold">Applies to</th>
            <th className="py-1.5 text-left font-semibold">From gross (₹)</th>
            <th className="py-1.5 text-left font-semibold">PT / month (₹)</th>
            <th className="py-1.5 text-left font-semibold">February (₹, if different)</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {draft.map((row, i) => (
            <tr key={i}>
              <td className="py-1 pr-2">
                <select className={inpSm} value={row.gender} onChange={(e) => update(i, 'gender', e.target.value)}>
                  <option value="any">Everyone</option>
                  <option value="male">Men</option>
                  <option value="female">Women</option>
                </select>
              </td>
              <td className="py-1 pr-2"><input type="number" min="0" step="0.01" className={`${inpSm} w-32`} value={row.from} onChange={(e) => update(i, 'from', e.target.value)} /></td>
              <td className="py-1 pr-2"><input type="number" min="0" step="1" className={`${inpSm} w-24`} value={row.amount} onChange={(e) => update(i, 'amount', e.target.value)} /></td>
              <td className="py-1 pr-2"><input type="number" min="0" step="1" placeholder="same" className={`${inpSm} w-24`} value={row.februaryAmount} onChange={(e) => update(i, 'februaryAmount', e.target.value)} /></td>
              <td className="py-1">
                <button type="button" onClick={() => setDraft(draft.filter((_, j) => j !== i))} disabled={draft.length === 1}
                  className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500 disabled:opacity-30" title="Remove slab">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <button type="button" onClick={() => setDraft([...draft, { gender: draft[draft.length - 1]?.gender ?? 'any', from: '', amount: '', februaryAmount: '' }])}
        className="inline-flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-800">
        <Plus className="w-3.5 h-3.5" /> Add a slab
      </button>

      <p className="text-xs text-gray-500">
        Each slab runs from its amount up to where the next one starts. Every set of slabs starts at ₹0. A state with no PT is one slab from ₹0 charging ₹0.
      </p>

      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-sm text-gray-700 flex items-center gap-2">
          Starts from
          <input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className={inpSm} />
        </label>
        <span className={`text-xs ${mode === 'earlier' ? 'text-red-600' : 'text-gray-600'}`}>
          {mode === 'first' && 'This state\'s first table.'}
          {mode === 'correction' && `Correction — replaces the table that started ${formatDay(currentFrom)}.`}
          {mode === 'revision' && `New table from ${formatDay(effectiveFrom)}; the current one ends ${formatDay(addDays(effectiveFrom, -1))}.`}
          {mode === 'earlier' && `The current table started ${formatDay(currentFrom)}. A new one cannot start before it.`}
        </span>
      </div>

      {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700 hover:bg-gray-50">Cancel</button>
        <button type="button" onClick={handleSave} disabled={setTable.isPending || mode === 'earlier' || (isNew && name.trim().length < 2)}
          className="px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium">
          {setTable.isPending ? 'Saving…' : 'Save table'}
        </button>
      </div>
    </div>
  )
}
