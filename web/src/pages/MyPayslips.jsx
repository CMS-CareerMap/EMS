import { Download, Loader2, FileText } from 'lucide-react'
import { useMyPayslips, downloadMyPayslip } from '../hooks/usePayroll'
import { useAuthStore } from '../stores/authStore'
import { useDownload } from '../features/payroll/useDownload'
import { money, formatDay, monthLabel } from '../features/payroll/format'

/**
 * A person's own payslips — every month that has been paid, as the PDF that
 * was stored when it was paid. A month appears only once its salary is paid:
 * before that its figures can still change.
 */
export default function MyPayslips() {
  const linked = useAuthStore((s) => Boolean(s.profile))
  const { data: slips = [], isLoading } = useMyPayslips()
  const { busy, start } = useDownload()

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">My Payslips</h2>
        <p className="text-sm text-gray-500 mt-0.5">Each month's payslip, once the salary has been paid</p>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <p className="px-4 py-12 text-center text-sm text-gray-400">Loading…</p>
        ) : slips.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <FileText className="w-8 h-8 text-gray-300 mx-auto" />
            <p className="mt-3 text-sm font-medium text-gray-700">No payslips yet</p>
            <p className="mt-1 text-sm text-gray-500">
              {linked
                ? 'A payslip appears here once that month’s salary has been paid.'
                : 'This login is not linked to an employee record, so it has no payslips.'}
            </p>
          </div>
        ) : (
          <>
          {/* On a phone, one card a month: the net pay and the download first. */}
          <ul className="sm:hidden divide-y divide-gray-100">
            {slips.map((slip) => (
              <li key={slip.id} className="p-4 flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-semibold text-gray-900">{monthLabel(slip.year, slip.month)}</p>
                  <p className="text-lg font-bold text-gray-900">{money(slip.net_payable, slip.currency)}</p>
                  <p className="text-xs text-gray-500">
                    Paid {formatDay(slip.paid_on)} · gross {money(slip.gross_earnings, slip.currency)}
                  </p>
                </div>
                <PdfButton busy={busy === slip.id} onClick={() => start(slip.id, () => downloadMyPayslip(slip.id))} />
              </li>
            ))}
          </ul>
          <div className="hidden sm:block overflow-x-auto">
            <table className="w-full min-w-160 text-sm">
              <thead>
                <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                  <th className="px-4 py-3 text-left">Month</th>
                  <th className="px-4 py-3 text-left">Paid on</th>
                  <th className="px-4 py-3 text-right">Gross</th>
                  <th className="px-4 py-3 text-right">Deductions</th>
                  <th className="px-4 py-3 text-right">Net pay</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {slips.map((slip) => (
                  <tr key={slip.id} className="border-b border-gray-100 last:border-0">
                    <td className="px-4 py-3 font-medium text-gray-900">{monthLabel(slip.year, slip.month)}</td>
                    <td className="px-4 py-3 text-gray-600">{formatDay(slip.paid_on)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{money(slip.gross_earnings, slip.currency)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{money(slip.total_deductions, slip.currency)}</td>
                    <td className="px-4 py-3 text-right font-semibold text-gray-900">{money(slip.net_payable, slip.currency)}</td>
                    <td className="px-4 py-3 text-right">
                      <PdfButton busy={busy === slip.id} onClick={() => start(slip.id, () => downloadMyPayslip(slip.id))} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          </>
        )}
      </div>
    </div>
  )
}

function PdfButton({ busy, onClick }) {
  return (
    <button onClick={onClick} disabled={busy}
      className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold disabled:opacity-60">
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} PDF
    </button>
  )
}
