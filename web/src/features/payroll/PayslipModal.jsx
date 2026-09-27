import { X, Download, Loader2, AlertTriangle } from 'lucide-react'
import { usePayslipDetail, downloadRunPayslip } from '../../hooks/usePayroll'
import { money, days, formatDay, monthLabel, LOP_BASIS } from './format'
import { useDownload } from './useDownload'
import { useEscape } from './useEscape'

/**
 * One payslip, as the server stored it.
 *
 * The version this replaces drew a payslip in the browser from an estimate,
 * and printed things nobody had recorded: a GSTIN, a PF account number, a pay
 * date of 31 March for every month, a logo. Every value here is the payslip's
 * own — a statutory number that is not on record shows as a dash, never a
 * guess — and the PDF is the server's.
 */
export default function PayslipModal({ runId, payslipId, runStatus, onClose }) {
  const { data: slip, isLoading } = usePayslipDetail(runId, payslipId)
  useEscape(onClose)
  const { busy, start } = useDownload()
  const downloading = busy === payslipId
  const handleDownload = () => start(payslipId, () => downloadRunPayslip(runId, payslipId))

  const currency = slip?.currency ?? 'INR'
  const m = (v) => money(v, currency)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Payslip">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl my-8 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div>
            <p className="text-base font-semibold text-gray-900">
              {slip ? `${slip.full_name} — ${monthLabel(slip.year, slip.month)}` : 'Payslip'}
            </p>
            {slip && <p className="text-xs text-gray-400 font-mono">{slip.employee_code}</p>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={handleDownload} disabled={!slip || downloading}
              className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 disabled:opacity-50">
              {downloading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
              PDF
            </button>
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {isLoading || !slip ? (
          <p className="p-10 text-center text-sm text-gray-400">Loading payslip…</p>
        ) : (
          <div className="p-6 space-y-5">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-1.5 text-sm">
              <Line label="Designation" value={slip.designation} />
              <Line label="UAN" value={slip.uan} />
              <Line label="Department" value={slip.department} />
              <Line label="PF member ID" value={slip.pf_member_id} />
              <Line label="Joining date" value={formatDay(slip.date_of_joining)} />
              <Line label="ESIC number" value={slip.esic_number} />
              <Line label="Layout" value={`${slip.country} · ${slip.currency}`} />
              <Line label="PAN" value={slip.pan} />
            </div>
            {!slip.pdf && (
              <p className="text-xs text-gray-400">
                {runStatus === 'draft'
                  ? 'UAN, PF, ESIC and PAN are copied onto the payslip when the payroll is approved; the PDF is stored once it is paid.'
                  : 'The PDF is stored once the payroll is paid; until then it is a preview.'}
              </p>
            )}

            <div className="grid grid-cols-3 gap-3 text-center">
              <Stat label="Days in month" value={days(slip.days_in_month)} />
              <Stat label="Paid days" value={days(slip.paid_days)} />
              <Stat label="Loss of pay" value={days(slip.lop_days)} />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Lines title="Earnings" rows={slip.earnings} total={['Gross earnings', slip.gross_earnings]} m={m} showRate />
              <Lines title="Deductions" rows={slip.deductions} total={['Total deductions', slip.total_deductions]} m={m} />
            </div>

            <div className="rounded-xl bg-gray-900 px-5 py-4 flex items-center justify-between">
              <p className="text-gray-300 text-sm font-medium">Net pay</p>
              <p className="text-white text-xl font-bold">{m(slip.net_payable)}</p>
            </div>

            <div className="text-xs text-gray-500 space-y-0.5">
              <p className="font-semibold text-gray-600">Employer contributions (not deducted from pay)</p>
              <p>PF pension (EPS) {m(slip.employer.eps)} · PF (EPF) {m(slip.employer.epf)} · ESI {m(slip.employer.esi)}</p>
              <p>
                Paid on {days(slip.payable_days)} of {slip.pay_basis_days} days ({LOP_BASIS[slip.lop_basis] ?? slip.lop_basis})
                {slip.basis?.tdsEnabled === false ? ' · no income tax deducted through payroll' : ''}
              </p>
            </div>

            {slip.warnings.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 space-y-1">
                {slip.warnings.map((w) => (
                  <p key={w} className="flex gap-2 text-xs text-amber-800">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {w}
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function Line({ label, value }) {
  return (
    <div className="flex gap-3">
      <span className="w-28 shrink-0 text-gray-400">{label}</span>
      <span className="font-medium text-gray-800">{value || '—'}</span>
    </div>
  )
}

function Stat({ label, value }) {
  return (
    <div className="rounded-lg bg-gray-50 border border-gray-100 py-2">
      <p className="text-lg font-bold text-gray-900">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  )
}

function Lines({ title, rows, total, m, showRate = false }) {
  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <p className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-sm font-semibold text-gray-700">{title}</p>
      <div className="divide-y divide-gray-100">
        {rows.length === 0 && <p className="px-4 py-2.5 text-sm text-gray-400">None</p>}
        {rows.map((row) => (
          <div key={row.code} className="flex items-center justify-between gap-3 px-4 py-2 text-sm">
            <span className="text-gray-700">{row.label}</span>
            <span className="text-right shrink-0">
              {showRate && row.rate !== null && <span className="text-xs text-gray-400 mr-2 whitespace-nowrap">of {m(row.rate)}</span>}
              <span className="font-medium text-gray-900">{m(row.amount)}</span>
            </span>
          </div>
        ))}
        <div className="flex items-center justify-between px-4 py-2 bg-gray-50 text-sm font-semibold">
          <span>{total[0]}</span>
          <span>{m(total[1])}</span>
        </div>
      </div>
    </div>
  )
}
