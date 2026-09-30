import { createElement, useMemo, useState } from 'react'
import {
  Play, RefreshCw, Trash2, CheckCircle2, Undo2, BadgeIndianRupee, Loader2,
  AlertTriangle, XCircle, Eye, Download, Landmark,
} from 'lucide-react'
import { toast } from 'sonner'
import {
  usePayrollRuns, usePayrollRun, useRunReadiness, useCreateRun, useRecalculateRun,
  useDiscardRun, useApproveRun, useReopenRun, useMarkRunPaid, downloadRunPayslip,
} from '../../hooks/usePayroll'
import { usePayrollComponents } from '../../hooks/useSalary'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn } from '../../lib/dates'
import { ApiError } from '../../api/http'
import PayslipModal from './PayslipModal'
import Dialog from '../../components/Dialog'
import DataState from '../../components/DataState'
import BankFilePanel from './BankFilePanel'
import { money, days, formatDay, monthLabel, recentMonths, monthValue, RUN_STATUS, LOP_BASIS } from './format'
import { useDownload } from '../../hooks/useDownload'

/**
 * The Payroll Runs tab: one month at a time, from draft to paid.
 *
 * Everything shown is the server's. Before a run exists the month's READINESS
 * is shown — who is in it, their loss of pay, and anything that would stop the
 * run — so problems are fixed before the run, not discovered by it.
 */
export default function RunsTab() {
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const today = calendarDayIn(timezone)
  const runs = usePayrollRuns()
  const list = useMemo(() => runs.data ?? [], [runs.data])
  // The last thirteen months, and every older month that has a run — a run
  // from two years ago must still be one click away.
  const months = useMemo(() => {
    const recent = recentMonths(today, 13)
    const shown = new Set(recent.map(monthValue))
    const older = list
      .filter((r) => !shown.has(monthValue(r)))
      .map((r) => ({ year: r.year, month: r.month }))
      .sort((a, b) => b.year - a.year || b.month - a.month)
    return [...recent, ...older]
  }, [today, list])
  // Until somebody picks a month: the latest one still to be paid, which is
  // the one there is work to do on — else this month.
  const [picked, setPicked] = useState(null)
  const unfinished = months.find((m) => list.some((r) => r.year === m.year && r.month === m.month && r.status !== 'paid'))
  const selected = picked ?? unfinished ?? months[0]

  const runFor = (m) => list.find((r) => r.year === m.year && r.month === m.month)
  const run = runFor(selected)

  // Until the list of runs is in, every month would read "No run" and offer to
  // run a payroll that may already exist.
  return (
    <DataState query={runs}>
      {() => (
      <div className="space-y-5">
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2">Month</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {months.map((m) => {
              const r = runFor(m)
              const active = m.year === selected.year && m.month === selected.month
              return (
                <button key={`${m.year}-${m.month}`} onClick={() => setPicked(m)}
                  className={`shrink-0 rounded-lg border px-3 py-2 text-left transition-colors ${active ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <p className={`text-sm font-semibold ${active ? 'text-blue-700' : 'text-gray-800'}`}>{monthLabel(m.year, m.month)}</p>
                  <p className="text-[11px] text-gray-500">{r ? RUN_STATUS[r.status]?.label : 'No run'}</p>
                </button>
              )
            })}
          </div>
        </div>

        {run ? <RunDetail key={run.id} runId={run.id} /> : <Readiness key={`${selected.year}-${selected.month}`} year={selected.year} month={selected.month} />}
      </div>
      )}
    </DataState>
  )
}

// ── Before a run: what it would find ────────────────────────────────────────

function Readiness({ year, month }) {
  const can = useAuthStore((s) => s.can)
  const readiness = useRunReadiness(year, month)
  const isFetching = readiness.isFetching
  const createRun = useCreateRun()

  async function handleCreate() {
    const ok = await createRun.mutateAsync({ year, month }).then(() => true, () => false)
    if (ok) toast.success(`Payroll for ${monthLabel(year, month)} calculated as a draft`)
  }

  return (
    <DataState query={readiness} loading={`Checking ${monthLabel(year, month)}…`}>
    {(data) => (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-base font-semibold text-gray-900">
            {monthLabel(year, month)} — no payroll run yet
            {isFetching && <span className="ml-2 text-xs font-normal text-gray-400">Checking again…</span>}
          </p>
          <p className="text-sm text-gray-500 mt-0.5">
            {data.employees.length} {data.employees.length === 1 ? 'person' : 'people'} in this month
            {data.tds_enabled === false ? ' · income tax (TDS) is not deducted' : ''}
          </p>
        </div>
        {can('payroll:run:create') && (
          <button onClick={handleCreate} disabled={data.blocked || createRun.isPending || isFetching}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium">
            {createRun.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
            Run payroll
          </button>
        )}
      </div>

      <Notices blockers={data.blockers} warnings={data.warnings} />

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-180 text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Employee</th>
                <th className="px-4 py-3 text-left">Employed</th>
                <th className="px-4 py-3 text-right">Loss of pay</th>
                <th className="px-4 py-3 text-right">No attendance</th>
                {data.tds_enabled && <th className="px-4 py-3 text-right">TDS</th>}
                <th className="px-4 py-3 text-left">Monthly entries</th>
              </tr>
            </thead>
            <tbody>
              {data.employees.length === 0 && (
                <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Nobody was employed in this month.</td></tr>
              )}
              {data.employees.map((e) => (
                <tr key={e.employee_id} className="border-b border-gray-100 last:border-0">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900">{e.full_name}</p>
                    <p className="text-xs text-gray-400 font-mono">{e.employee_code}</p>
                  </td>
                  <td className="px-4 py-3 text-gray-600">{formatDay(e.employment_from)} – {formatDay(e.employment_to)}</td>
                  <td className="px-4 py-3 text-right text-gray-700">{e.lop_days === null ? '—' : days(e.lop_days)}</td>
                  <td className={`px-4 py-3 text-right ${e.unmarked_days > 0 ? 'text-amber-700 font-medium' : 'text-gray-400'}`}>{e.unmarked_days}</td>
                  {data.tds_enabled && <td className="px-4 py-3 text-right">{e.tds === null ? <span className="text-red-600">Missing</span> : money(e.tds)}</td>}
                  <td className="px-4 py-3 text-gray-600">
                    {e.entries.length === 0 ? '—' : e.entries.map((x) => `${x.label} ${money(x.amount)}`).join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    )}
    </DataState>
  )
}

function Notices({ blockers = [], warnings = [] }) {
  if (blockers.length === 0 && warnings.length === 0) return null
  return (
    <div className="space-y-3">
      {blockers.length > 0 && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4">
          <p className="flex items-center gap-2 text-sm font-semibold text-red-800">
            <XCircle className="w-4 h-4" /> {blockers.length === 1 ? 'One thing stops' : `${blockers.length} things stop`} this payroll
          </p>
          <ul className="mt-2 space-y-1 text-sm text-red-700 list-disc pl-5">
            {blockers.map((b) => <li key={`${b.code}-${b.employee_id}`}>{b.message}</li>)}
          </ul>
        </div>
      )}
      {warnings.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
          <ul className="space-y-1 text-sm text-amber-800">
            {warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" /> {w}</li>)}
          </ul>
        </div>
      )}
    </div>
  )
}

// ── A run ───────────────────────────────────────────────────────────────────

const STEPS = ['draft', 'approved', 'paid']

function RunDetail({ runId }) {
  const run = usePayrollRun(runId)
  return (
    <DataState query={run} loading="Loading the run…">
      {(data) => <RunView run={data} />}
    </DataState>
  )
}

function RunView({ run }) {
  const can = useAuthStore((s) => s.can)
  const recalculate = useRecalculateRun()
  const [dialog, setDialog] = useState(null)
  const [viewing, setViewing] = useState(null)
  const { busy: downloading, start: startDownload } = useDownload()

  const label = monthLabel(run.year, run.month)
  const step = STEPS.indexOf(run.status)
  const status = RUN_STATUS[run.status]

  async function handleRecalculate() {
    const ok = await recalculate.mutateAsync(run.id).then(() => true, () => false)
    if (ok) toast.success(`${label} recalculated from the records as they stand`)
  }

  const handlePdf = (slip) => startDownload(slip.id, () => downloadRunPayslip(run.id, slip.id))

  const canCreate = can('payroll:run:create')
  const canApprove = can('payroll:run:approve')
  const canBank = canCreate && can('employee:bank:read')

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-3">
              <p className="text-base font-semibold text-gray-900">{label} payroll</p>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${status.cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${status.dot}`} />{status.label}
              </span>
            </div>
            <div className="flex items-center gap-2 mt-3">
              {STEPS.map((s, i) => (
                <div key={s} className="flex items-center gap-2">
                  <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${i <= step ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}`}>
                    {i < step ? '✓' : i + 1}
                  </div>
                  <span className={`text-xs ${i <= step ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>{RUN_STATUS[s].label}</span>
                  {i < STEPS.length - 1 && <div className={`w-8 h-0.5 ${i < step ? 'bg-blue-600' : 'bg-gray-200'}`} />}
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {run.status === 'draft' && canCreate && (
              <>
                <ActionButton onClick={handleRecalculate} busy={recalculate.isPending} icon={RefreshCw} label="Recalculate" />
                <ActionButton onClick={() => setDialog('discard')} icon={Trash2} label="Discard" tone="danger" />
              </>
            )}
            {run.status === 'draft' && canApprove && (
              <ActionButton onClick={() => setDialog('approve')} icon={CheckCircle2} label="Approve" tone="primary" />
            )}
            {run.status === 'approved' && canApprove && (
              <ActionButton onClick={() => setDialog('reopen')} icon={Undo2} label="Reopen" />
            )}
            {run.status === 'approved' && canCreate && (
              <ActionButton onClick={() => setDialog('paid')} icon={BadgeIndianRupee} label="Mark as paid" tone="primary" />
            )}
            {run.status !== 'draft' && canBank && (
              <ActionButton onClick={() => setDialog('bank')} icon={Landmark} label="Bank file" />
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 pt-4 border-t border-gray-100">
          <Figure label="Employees" value={run.employee_count} />
          <Figure label="Gross" value={money(run.gross_earnings)} />
          <Figure label="Deductions" value={money(run.total_deductions)} />
          <Figure label="Net pay" value={money(run.net_payable)} strong />
          <Figure label="Employer PF" value={money(run.employer_pf)} />
          <Figure label="Employer ESI" value={money(run.employer_esi)} />
        </div>

        <div className="text-xs text-gray-500 space-y-0.5">
          <p>Calculated {new Date(run.calculated_at).toLocaleString('en-IN')} · a day's pay on {LOP_BASIS[run.lop_basis] ?? run.lop_basis}{run.sandwich_rule ? ' · sandwich rule on' : ''}</p>
          {run.approved_at && (
            <p>Approved {new Date(run.approved_at).toLocaleString('en-IN')}{run.assumed_days ? ` · ${run.assumed_days} day${run.assumed_days === 1 ? '' : 's'} with no attendance accepted as paid` : ''}</p>
          )}
          {run.paid_on && <p>Paid on {formatDay(run.paid_on)}</p>}
        </div>
      </div>

      <Notices warnings={run.warnings} />

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-190 text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Employee</th>
                <th className="px-4 py-3 text-right">Paid days</th>
                <th className="px-4 py-3 text-right">Loss of pay</th>
                <th className="px-4 py-3 text-right">Gross</th>
                <th className="px-4 py-3 text-right">Deductions</th>
                <th className="px-4 py-3 text-right">Net pay</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {run.payslips.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-10 text-center text-gray-400">This run has no payslips.</td></tr>
              )}
              {run.payslips.map((slip) => (
                <tr key={slip.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="font-medium text-gray-900 flex items-center gap-1.5">
                      {slip.full_name}
                      {slip.warnings.length > 0 && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" aria-label={`${slip.warnings.length} warnings`} />}
                    </p>
                    <p className="text-xs text-gray-400 font-mono">{slip.employee_code}</p>
                  </td>
                  <td className="px-4 py-3 text-right">{days(slip.paid_days)} / {slip.employment_days}</td>
                  <td className="px-4 py-3 text-right">{days(slip.lop_days)}</td>
                  <td className="px-4 py-3 text-right">{money(slip.gross_earnings)}</td>
                  <td className="px-4 py-3 text-right text-red-600">{money(slip.total_deductions)}</td>
                  <td className={`px-4 py-3 text-right font-semibold ${slip.net_payable < 0 ? 'text-red-600' : 'text-gray-900'}`}>{money(slip.net_payable)}</td>
                  <td className="px-4 py-3">
                    <div className="flex justify-end gap-1.5">
                      <button onClick={() => setViewing(slip.id)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-medium">
                        <Eye className="w-3.5 h-3.5" /> View
                      </button>
                      <button onClick={() => handlePdf(slip)} disabled={downloading === slip.id} aria-label={`PDF for ${slip.full_name}`}
                        className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-xs font-medium disabled:opacity-50">
                        {downloading === slip.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} PDF
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {viewing && <PayslipModal runId={run.id} payslipId={viewing} runStatus={run.status} onClose={() => setViewing(null)} />}
      {dialog === 'approve' && <ApproveDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === 'discard' && <DiscardDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === 'reopen' && <ReopenDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === 'paid' && <MarkPaidDialog run={run} onClose={() => setDialog(null)} />}
      {dialog === 'bank' && <BankFilePanel run={run} onClose={() => setDialog(null)} />}
    </div>
  )
}

function ActionButton({ onClick, icon, label, tone = 'plain', busy = false }) {
  const tones = {
    plain: 'border border-gray-300 bg-white hover:bg-gray-50 text-gray-700',
    primary: 'bg-blue-600 hover:bg-blue-700 text-white',
    danger: 'border border-red-200 bg-white hover:bg-red-50 text-red-600',
  }
  return (
    <button onClick={onClick} disabled={busy} className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium disabled:opacity-60 ${tones[tone]}`}>
      {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : createElement(icon, { className: 'w-4 h-4' })} {label}
    </button>
  )
}

function Figure({ label, value, strong = false }) {
  return (
    <div>
      <p className="text-xs text-gray-500">{label}</p>
      <p className={`mt-0.5 ${strong ? 'text-lg font-bold text-gray-900' : 'text-base font-semibold text-gray-800'}`}>{value}</p>
    </div>
  )
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

/** The figures approval compares, in words. A component shows by its code. */
const FIELD_LABELS = {
  grossEarnings: 'gross',
  pfWages: 'PF wages',
  employeePf: 'PF',
  employeeEsi: 'ESI',
  professionalTax: 'professional tax',
  tds: 'TDS',
  otherDeductions: 'other deductions',
  totalDeductions: 'total deductions',
  netPayable: 'net pay',
  employerPf: 'employer PF',
  employerEps: 'employer EPS',
  employerEpf: 'employer EPF',
  employerEsi: 'employer ESI',
  lopDays: 'loss of pay days',
  paidDays: 'paid days',
  payableDays: 'payable days',
  // Deduction lines, by their codes.
  PF: 'PF',
  ESI: 'ESI',
  PT: 'professional tax',
  TDS: 'TDS',
}

/** A figure in words; an earning line by its component's own name, as the payslip prints it. */
function fieldLabel(field, components) {
  return FIELD_LABELS[field] ?? components.find((c) => c.code === field)?.label.toLowerCase() ?? field
}

const CHANGE_LABELS = {
  added: 'now in this month',
  removed: 'no longer in this month',
}

/**
 * Approving: the server checks the figures are still what the records say, and
 * asks about the days paid for on no record. Both answers come back here —
 * the days to accept, or who changed — rather than as a passing toast.
 */
function ApproveDialog({ run, onClose }) {
  const approve = useApproveRun()
  const recalculate = useRecalculateRun()
  const components = usePayrollComponents()
  const [reply, setReply] = useState(null)
  const label = monthLabel(run.year, run.month)

  async function send(confirmAssumedDays) {
    try {
      await approve.mutateAsync({ id: run.id, confirmAssumedDays })
      toast.success(`${label} approved`)
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'BUSINESS_RULE') setReply(err)
    }
  }

  async function handleRecalculate() {
    const ok = await recalculate.mutateAsync(run.id).then(() => true, () => false)
    if (ok) {
      setReply(null)
      toast.success(`${label} recalculated — check the figures, then approve`)
    }
  }

  const assumed = reply?.details?.employees ?? []
  const changed = reply?.details?.changed ?? []

  return (
    <Dialog title={`Approve ${label}`} onClose={onClose}>
      {!reply && (
        <>
          <p className="text-sm text-gray-600">
            Approving signs these figures off: {run.employee_count} payslips, net pay {money(run.net_payable)}.
            The month is then closed to changes in attendance, leave, salaries and the rest until it is reopened.
          </p>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Cancel</button>
            <button onClick={() => send(false)} disabled={approve.isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
              {approve.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Approve
            </button>
          </div>
        </>
      )}

      {reply && assumed.length > 0 && (
        <>
          <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">{reply.message}</p>
          <div className="max-h-64 overflow-y-auto divide-y divide-gray-100 border border-gray-200 rounded-lg">
            {assumed.map((a) => (
              <div key={a.employee_id} className="px-3 py-2 text-sm">
                <p className="font-medium text-gray-900">{a.full_name} <span className="text-xs text-gray-400 font-mono">{a.employee_code}</span></p>
                {a.unmarked_days.length > 0 && <p className="text-xs text-gray-600">No attendance: {a.unmarked_days.map(formatDay).join(', ')}</p>}
                {a.days_not_yet_happened.length > 0 && <p className="text-xs text-gray-600">Not yet happened: {a.days_not_yet_happened.map(formatDay).join(', ')}</p>}
                {a.marked_on_leave_without_request.length > 0 && <p className="text-xs text-gray-600">On leave with no request: {a.marked_on_leave_without_request.map(formatDay).join(', ')}</p>}
              </div>
            ))}
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Check them first</button>
            <button onClick={() => send(true)} disabled={approve.isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
              {approve.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Approve, accepting {reply.details.assumed_days} {reply.details.assumed_days === 1 ? 'day' : 'days'}
            </button>
          </div>
        </>
      )}

      {reply && changed.length > 0 && (
        <>
          <p className="text-sm text-red-800 bg-red-50 border border-red-200 rounded-lg p-3">{reply.message}</p>
          {/* An earning is named by its component; without the list it would show as a bare code. */}
          <DataState query={components} compact>
            {(list) => (
              <ul className="text-sm text-gray-700 list-disc pl-5 space-y-0.5">
                {changed.map((c) => (
                  <li key={c.employee_id}>
                    {c.full_name}: {c.change === 'changed' ? c.fields.map((f) => fieldLabel(f, list)).join(', ') : CHANGE_LABELS[c.change] ?? c.change}
                  </li>
                ))}
              </ul>
            )}
          </DataState>
          <div className="flex justify-end">
            <button onClick={handleRecalculate} disabled={recalculate.isPending}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
              {recalculate.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />} Recalculate now
            </button>
          </div>
        </>
      )}

      {reply && assumed.length === 0 && changed.length === 0 && (
        <p className="text-sm text-red-700">{reply.message}</p>
      )}
    </Dialog>
  )
}

function DiscardDialog({ run, onClose }) {
  const discard = useDiscardRun()
  const label = monthLabel(run.year, run.month)
  async function handle() {
    const ok = await discard.mutateAsync(run.id).then(() => true, () => false)
    if (ok) {
      toast.success(`The ${label} draft was discarded`)
      onClose()
    }
  }
  return (
    <Dialog title={`Discard the ${label} draft?`} onClose={onClose}>
      <p className="text-sm text-gray-600">Its payslips are deleted. Nothing else changes, and the month can be run again.</p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Keep it</button>
        <button onClick={handle} disabled={discard.isPending} className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60">Discard</button>
      </div>
    </Dialog>
  )
}

function ReopenDialog({ run, onClose }) {
  const reopen = useReopenRun()
  const label = monthLabel(run.year, run.month)
  async function handle() {
    const ok = await reopen.mutateAsync(run.id).then(() => true, () => false)
    if (ok) {
      toast.success(`${label} is a draft again`)
      onClose()
    }
  }
  return (
    <Dialog title={`Reopen ${label}?`} onClose={onClose}>
      <p className="text-sm text-gray-600">
        The approval is withdrawn and the month opens for changes again. It has to be approved again before it can be paid.
      </p>
      <div className="flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Cancel</button>
        <button onClick={handle} disabled={reopen.isPending} className="px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">Reopen</button>
      </div>
    </Dialog>
  )
}

function MarkPaidDialog({ run, onClose }) {
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const today = calendarDayIn(timezone)
  const markPaid = useMarkRunPaid()
  const [paidOn, setPaidOn] = useState(today)
  const label = monthLabel(run.year, run.month)
  const monthStart = `${run.year}-${String(run.month).padStart(2, '0')}-01`

  async function handle(e) {
    e.preventDefault()
    const ok = await markPaid.mutateAsync({ id: run.id, paidOn }).then(() => true, () => false)
    if (ok) {
      toast.success(`${label} marked as paid — payslips are ready for everybody`)
      onClose()
    }
  }

  return (
    <Dialog title={`Mark ${label} as paid`} onClose={onClose}>
      <form onSubmit={handle} className="space-y-4">
        <p className="text-sm text-gray-600">
          Record this once the salaries have been credited. Every payslip is then saved as a PDF that cannot change,
          and each employee can download theirs.
        </p>
        <label className="block space-y-1.5">
          <span className="text-sm font-medium text-gray-600">Credited on</span>
          <input type="date" value={paidOn} min={monthStart} max={today} onChange={(e) => setPaidOn(e.target.value)} required
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Cancel</button>
          <button type="submit" disabled={markPaid.isPending}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-60">
            {markPaid.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Mark as paid
          </button>
        </div>
      </form>
    </Dialog>
  )
}
