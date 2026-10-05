import { Download, Loader2, ReceiptText } from 'lucide-react'
import { useMyPayslips, downloadMyPayslip } from '../hooks/usePayroll'
import { useAuthStore } from '../stores/authStore'
import { useDownload } from '../hooks/useDownload'
import { money, formatDay, monthLabel } from '../features/payroll/format'
import DataState from '../components/DataState'
import PageHeader from '../components/ui/PageHeader'
import { Card, EmptyState } from '../components/ui/bits'
import { btn, th } from '../components/ui/styles'

/**
 * A person's own payslips — every month that has been paid, as the PDF that
 * was stored when it was paid. A month appears only once its salary is paid:
 * before that its figures can still change.
 */
export default function MyPayslips() {
  const linked = useAuthStore((s) => Boolean(s.profile))
  const payslips = useMyPayslips()
  const { busy, start } = useDownload()
  const pdf = (slip) => start(slip.id, () => downloadMyPayslip(slip.id))

  return (
    <>
      <PageHeader title="My Payslips" subtitle="Each month’s payslip, once the salary has been paid" />

      <DataState query={payslips} empty={
        <Card>
          <EmptyState icon={ReceiptText} title="No payslips yet">
            {linked
              ? 'A payslip appears here once that month’s salary has been paid.'
              : 'This login is not linked to an employee record, so it has no payslips.'}
          </EmptyState>
        </Card>
      }>
        {(slips) => {
          const latest = slips[0]
          return (
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 items-start">
              {/* The latest, in the logo's colours: what was paid, and its PDF. */}
              <section className="lg:col-span-5 bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" aria-label="Latest payslip">
                <div className="relative overflow-hidden bg-logo text-white p-5">
                  <span aria-hidden="true" className="absolute -right-8 -top-10 w-36 h-36 rounded-full bg-white/20" />
                  <p className="relative text-xs font-semibold text-white/90">Latest · paid on {formatDay(latest.paid_on)}</p>
                  <p className="relative text-[15px] font-bold mt-0.5">{monthLabel(latest.year, latest.month)}</p>
                  <p className="relative text-[30px] font-extrabold tracking-tight tabular-nums mt-2">{money(latest.net_payable, latest.currency)}</p>
                  <p className="relative text-xs text-white/90">Net pay</p>
                </div>
                <dl className="p-4 text-sm">
                  <div className="flex justify-between gap-3 py-2">
                    <dt className="text-gray-600">Gross</dt>
                    <dd className="font-bold text-gray-900 tabular-nums">{money(latest.gross_earnings, latest.currency)}</dd>
                  </div>
                  <div className="flex justify-between gap-3 py-2 border-t border-gray-100">
                    <dt className="text-gray-600">Deductions</dt>
                    <dd className="font-bold text-red-600 tabular-nums">{money(latest.total_deductions, latest.currency)}</dd>
                  </div>
                </dl>
                <div className="px-4 pb-4">
                  <button onClick={() => pdf(latest)} disabled={busy === latest.id} className={`${btn.primary} w-full`}>
                    {busy === latest.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" aria-hidden="true" />}
                    Download the PDF
                  </button>
                </div>
              </section>

              <Card className="lg:col-span-7" title="All payslips" subtitle={`${slips.length} month${slips.length === 1 ? '' : 's'} paid`} bodyClassName="pt-3">
                {/* On a phone, one line a month: the net pay and the download first. */}
                <ul className="sm:hidden divide-y divide-gray-100 border-t border-gray-100">
                  {slips.map((slip) => (
                    <li key={slip.id} className="px-4 py-3 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="font-semibold text-gray-900">{monthLabel(slip.year, slip.month)}</p>
                        <p className="text-base font-bold text-gray-900 tabular-nums">{money(slip.net_payable, slip.currency)}</p>
                        <p className="text-xs text-gray-500">Paid {formatDay(slip.paid_on)} · gross {money(slip.gross_earnings, slip.currency)}</p>
                      </div>
                      <PdfButton busy={busy === slip.id} onClick={() => pdf(slip)} />
                    </li>
                  ))}
                </ul>
                <div className="hidden sm:block overflow-x-auto">
                  <table className="w-full min-w-140 text-sm">
                    <thead>
                      <tr>
                        <th className={th}>Month</th>
                        <th className={th}>Paid on</th>
                        <th className={`${th} text-right`}>Gross</th>
                        <th className={`${th} text-right`}>Deductions</th>
                        <th className={`${th} text-right`}>Net pay</th>
                        <th className={th} aria-label="PDF" />
                      </tr>
                    </thead>
                    <tbody>
                      {slips.map((slip) => (
                        <tr key={slip.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                          <td className="px-4 py-3 font-semibold text-gray-900 whitespace-nowrap">{monthLabel(slip.year, slip.month)}</td>
                          <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatDay(slip.paid_on)}</td>
                          <td className="px-4 py-3 text-right text-gray-700 tabular-nums">{money(slip.gross_earnings, slip.currency)}</td>
                          <td className="px-4 py-3 text-right text-gray-700 tabular-nums">{money(slip.total_deductions, slip.currency)}</td>
                          <td className="px-4 py-3 text-right font-bold text-gray-900 tabular-nums">{money(slip.net_payable, slip.currency)}</td>
                          <td className="px-4 py-3 text-right">
                            <PdfButton busy={busy === slip.id} onClick={() => pdf(slip)} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            </div>
          )
        }}
      </DataState>
    </>
  )
}

function PdfButton({ busy, onClick }) {
  return (
    <button onClick={onClick} disabled={busy} className={`shrink-0 ${btn.softSm}`}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />} PDF
    </button>
  )
}
