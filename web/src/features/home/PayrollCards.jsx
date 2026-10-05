import { Link } from 'react-router-dom'
import { AlertTriangle, CheckCircle2, Landmark, Plus, ShieldCheck, Wallet } from 'lucide-react'
import DataState from '../../components/DataState'
import { Avatar, Card, CardLink, Chip, EmptyState, IconBox } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { useRunReadiness } from '../../hooks/usePayroll'
import { useAuthStore } from '../../stores/authStore'
import { formatDay, formatDayOf } from '../../lib/dates'
import { money, monthLabel, RUN_STATUS } from '../payroll/format'

/**
 * The home page's payroll section, for whoever reads payroll: the newest run
 * and where it stands, salary accounts, the next month, amounts entered and
 * loans. Approving and paying stay on the Payroll page, where each step has
 * its checks; these cards say what is waiting and take you there.
 */

const STEPS = ['draft', 'approved', 'paid']

/** The newest run: its step, its figures, and what it waits for. */
export function PayrollRunCard({ summary, wide = false }) {
  const can = useAuthStore((state) => state.can)
  const timezone = useAuthStore((state) => state.organization?.timezone)
  return (
    <Card title="Payroll" subtitle={summary.data?.latest ? monthLabel(summary.data.latest.year, summary.data.latest.month) : 'Monthly runs'}
      action={<CardLink to="/payroll">Open payroll</CardLink>}>
      <DataState query={summary} compact>
        {(s) => {
          const run = s.latest
          if (!run) {
            return (
              <EmptyState icon={Wallet} title="No payroll run yet">
                {can('payroll:run:create') ? <Link to="/payroll" className={`${btn.primarySm} mt-2`}>Run payroll</Link> : 'Accounts runs the first month’s payroll.'}
              </EmptyState>
            )
          }
          const step = STEPS.indexOf(run.status)
          const figures = [['Gross', run.gross], ['Deductions', run.deductions], ['Employer PF', run.employer_pf], ['Employer ESI', run.employer_esi]]
          return (
            <div className="space-y-3.5">
              <ol className="flex items-center gap-2 text-xs font-bold text-gray-400" aria-label="Where this payroll stands">
                {STEPS.map((key, i) => (
                  <li key={key} className={`flex items-center gap-2 ${i <= step ? 'text-brand-700' : ''} ${i < STEPS.length - 1 ? 'flex-1' : ''}`} aria-current={i === step ? 'step' : undefined}>
                    <span className={`w-5.5 h-5.5 rounded-full grid place-items-center text-[11px] shrink-0 ${i <= step ? 'bg-logo text-white' : 'border-2 border-gray-200'}`}>{i + 1}</span>
                    {RUN_STATUS[key].label}
                    {i < STEPS.length - 1 && <span aria-hidden="true" className={`flex-1 h-0.5 rounded min-w-3 ${i < step ? 'bg-brand-300' : 'bg-gray-200'}`} />}
                  </li>
                ))}
              </ol>

              <div className="rounded-xl bg-logo-soft p-3.5 flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold text-gray-600">Net pay</p>
                  <p className={`${wide ? 'text-[28px]' : 'text-2xl'} font-extrabold tracking-tight text-gray-900 tabular-nums leading-tight`}>{money(run.net)}</p>
                </div>
                <p className="text-xs text-gray-600">{run.employees} employees · calculated {formatDayOf(run.calculated_at, timezone)}</p>
              </div>

              <dl className={`grid gap-3 ${wide ? 'grid-cols-2 sm:grid-cols-4' : 'grid-cols-2'}`}>
                {figures.map(([label, value]) => (
                  <div key={label}>
                    <dt className="text-xs text-gray-500">{label}</dt>
                    <dd className="text-[13.5px] font-bold text-gray-900 tabular-nums">{money(value)}</dd>
                  </div>
                ))}
              </dl>

              <div className="flex flex-wrap items-center gap-2">
                {run.status === 'draft' && (can('payroll:run:approve')
                  ? <Link to="/payroll?tab=runs" className={btn.primary}><ShieldCheck className="w-4 h-4" aria-hidden="true" />Review &amp; approve</Link>
                  : <Chip tone="warn">Waiting for approval</Chip>)}
                {run.status === 'approved' && (can('payroll:run:create')
                  ? <Link to="/payroll?tab=runs" className={btn.primary}>Bank file &amp; mark as paid</Link>
                  : <Chip tone="brand">Approved — being paid</Chip>)}
                {run.status === 'paid' && <Chip tone="ok">Paid{run.paid_on ? ` on ${formatDay(run.paid_on)}` : ''}</Chip>}
                <Link to="/payroll?tab=runs" className={btn.secondary}>Open payroll</Link>
              </div>

              {s.previous && (
                <div className="flex items-center gap-3 pt-3 border-t border-gray-100">
                  <IconBox icon={s.previous.status === 'paid' ? CheckCircle2 : Wallet} tone={s.previous.status === 'paid' ? 'ok' : 'gray'} size="sm" />
                  <p className="flex-1 text-[13px] font-semibold text-gray-900">{monthLabel(s.previous.year, s.previous.month)}</p>
                  <Chip tone={s.previous.status === 'paid' ? 'ok' : s.previous.status === 'approved' ? 'brand' : 'gray'}>{RUN_STATUS[s.previous.status]?.label ?? s.previous.status}</Chip>
                </div>
              )}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

/** Salary accounts: how many are checked, which wait for this login, who has none. */
export function BankAccountsCard({ summary }) {
  const bank = summary.data?.bank
  if (!bank) return null
  const total = bank.verified + bank.waiting + bank.rejected + bank.unchecked + bank.none
  return (
    <Card title="Bank accounts" subtitle={`${bank.verified} of ${total} checked`} action={<CardLink to="/payroll?tab=bank">Bank accounts</CardLink>}>
      <ul className="divide-y divide-gray-100">
        <li className="flex items-center gap-3 pb-2.5">
          <IconBox icon={Landmark} tone={bank.verified === total ? 'ok' : 'warn'} />
          <div className="min-w-0 flex-1">
            <p className="text-[13px] font-semibold text-gray-900">{bank.verified} of {total} checked</p>
            <p className="text-xs text-gray-500">The bank file pays only checked accounts.</p>
          </div>
        </li>
        {bank.to_check.map((p) => (
          <li key={`c${p.employee_id}`} className="flex items-center gap-3 py-2.5">
            <Avatar name={p.full_name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-gray-900 truncate">{p.full_name}</p>
              <p className="text-xs text-gray-500">Waiting for a check</p>
            </div>
            <Link to="/payroll?tab=bank" className={btn.primarySm}>Check</Link>
          </li>
        ))}
        {bank.without.map((p) => (
          <li key={`n${p.employee_id}`} className="flex items-center gap-3 py-2.5 last:pb-0">
            <Avatar name={p.full_name} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-gray-900 truncate">{p.full_name}</p>
              <p className="text-xs text-gray-500">No bank account yet</p>
            </div>
            <Link to="/payroll?tab=bank" className={btn.secondarySm}><Plus className="w-3.5 h-3.5" aria-hidden="true" />Add</Link>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** The month the next run is for, and what would stop it — read from the same check the Payroll page runs. */
export function NextMonthCard({ summary }) {
  const can = useAuthStore((state) => state.can)
  const next = summary.data?.next
  const readiness = useRunReadiness(next?.year, next?.month, Boolean(next))
  if (!next) return null
  return (
    <Card title={monthLabel(next.year, next.month)} subtitle="No payroll run yet" action={<CardLink to="/payroll?tab=runs">Payroll runs</CardLink>}>
      <DataState query={readiness} compact>
        {(r) => {
          const blockers = r.blockers ?? []
          const warnings = r.warnings ?? []
          return (
            <div className="space-y-2.5">
              {blockers.length === 0 && warnings.length === 0 && (
                <p className="flex items-center gap-2 text-[13px] font-semibold text-emerald-700"><CheckCircle2 className="w-4 h-4" aria-hidden="true" />Nothing stops this month’s run.</p>
              )}
              {blockers.slice(0, 3).map((b, i) => (
                <p key={`b${i}`} className="flex items-start gap-2 text-xs text-red-700"><AlertTriangle className="w-4 h-4 shrink-0 text-red-500" aria-hidden="true" /><span><b>{b.employee.fullName}:</b> {b.message}</span></p>
              ))}
              {blockers.length > 3 && <p className="text-xs text-red-700">and {blockers.length - 3} more</p>}
              {warnings.length > 0 && <p className="text-xs text-amber-800 bg-amber-50 rounded-lg px-3 py-2">{warnings.length} warning{warnings.length === 1 ? '' : 's'} to read before running.</p>}
              {can('payroll:run:create') && <Link to="/payroll?tab=runs" className={btn.softSm}>Run payroll</Link>}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

/** Amounts entered for a month — incentives and the like. */
export function EntriesCard({ summary }) {
  const entries = summary.data?.entries ?? []
  if (entries.length === 0) return null
  return (
    <Card title="Incentives & entries" subtitle="Amounts entered for a month" action={<CardLink to="/payroll?tab=incentives">Incentives</CardLink>}>
      <ul className="divide-y divide-gray-100">
        {[...entries].reverse().map((e) => (
          <li key={`${e.year}-${e.month}`} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-semibold text-gray-900">{monthLabel(e.year, e.month)}</p>
              <p className="text-xs text-gray-500">{e.count ? `${e.count} entr${e.count === 1 ? 'y' : 'ies'}` : 'Nothing entered yet'}</p>
            </div>
            {e.count > 0 && <b className="text-sm tabular-nums text-gray-900">{money(e.total)}</b>}
          </li>
        ))}
      </ul>
    </Card>
  )
}

/** Loans and advances still being recovered. */
export function LoansCard({ summary }) {
  const loans = summary.data?.loans
  if (!loans) return null
  return (
    <Card title="Loans & advances" subtitle={loans.active ? `${loans.active} being recovered` : 'None being recovered'} action={<CardLink to="/payroll?tab=loans">Loans</CardLink>}>
      <div className="flex items-center gap-3">
        <IconBox icon={Wallet} tone={loans.active ? 'info' : 'gray'} />
        <div>
          <p className="text-[13px] font-semibold text-gray-900">{loans.active ? `${money(loans.left)} still to recover` : 'Nothing to recover'}</p>
          <p className="text-xs text-gray-500">Taken from salary each month until repaid.</p>
        </div>
      </div>
    </Card>
  )
}
