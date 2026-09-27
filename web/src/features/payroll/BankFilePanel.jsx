import { useState } from 'react'
import { X, Download, Loader2, AlertTriangle, Landmark } from 'lucide-react'
import { useBankFilePreview, downloadBankFile } from '../../hooks/usePayroll'
import { useDownload } from './useDownload'
import { money, monthLabel } from './format'

/**
 * The bank transfer file for one approved or paid run.
 *
 * Who it pays and who it leaves out are shown BEFORE the file is taken, so a
 * missing account is fixed now — not found out when somebody's salary does
 * not arrive. Amounts are the payslips' net pay; nothing is worked out here.
 */

const REASONS = {
  no_bank_account: 'No bank account on record',
  not_verified: 'Bank account not checked yet',
  rejected: 'Bank account was rejected',
  nothing_to_pay: 'Nothing to pay this month',
}

export default function BankFilePanel({ run, onClose }) {
  const [payDate, setPayDate] = useState('')
  const { data, isLoading, error } = useBankFilePreview(run.id, payDate || undefined)
  const { busy, start } = useDownload()
  const label = monthLabel(run.year, run.month)

  const date = payDate || data?.pay_date || ''

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label="Bank transfer file">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl my-8 overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-blue-100 p-2"><Landmark className="w-4 h-4 text-blue-700" /></div>
            <div>
              <p className="text-base font-semibold text-gray-900">Bank transfer file — {label}</p>
              <p className="text-xs text-gray-500">A CSV to upload to the bank's bulk payment screen</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="p-6 space-y-5">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <label className="space-y-1.5">
              <span className="block text-sm font-medium text-gray-600">Payment date in the file</span>
              <input type="date" value={date} onChange={(e) => setPayDate(e.target.value)}
                className="border border-gray-300 rounded-lg px-3 py-2 text-sm" />
            </label>
            {data && (
              <div className="text-right">
                <p className="text-xs text-gray-500">{data.count} {data.count === 1 ? 'payment' : 'payments'}</p>
                <p className="text-xl font-bold text-gray-900">{money(data.total)}</p>
              </div>
            )}
          </div>

          {isLoading && <p className="text-sm text-gray-400 py-6 text-center">Preparing the file…</p>}
          {error && <p className="text-sm text-red-600">{error.message}</p>}

          {data && (
            <>
              {!data.template_saved && (
                <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg p-3">
                  This uses the standard layout. If the bank asks for different columns, set them once under
                  <span className="font-medium"> Payroll → Bank file format</span>.
                </p>
              )}

              {data.excluded.length > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <p className="flex items-center gap-2 text-sm font-semibold text-amber-800">
                    <AlertTriangle className="w-4 h-4" />
                    {data.excluded.length === 1 ? 'One person is' : `${data.excluded.length} people are`} not in the file
                  </p>
                  <ul className="mt-2 space-y-1 text-sm text-amber-900">
                    {data.excluded.map((x) => (
                      <li key={x.payslip_id} className="flex flex-wrap justify-between gap-2">
                        <span>{x.full_name} <span className="text-xs font-mono text-amber-700">{x.employee_code}</span> — {REASONS[x.reason] ?? x.reason}</span>
                        <span className="font-medium">{money(x.net_payable)}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-amber-700">Pay them another way, or fix their bank account under Bank accounts and come back.</p>
                </div>
              )}

              <div className="rounded-xl border border-gray-200 overflow-hidden">
                <div className="overflow-x-auto max-h-80">
                  <table className="w-full min-w-140 text-sm">
                    <thead>
                      <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                        <th className="px-4 py-2.5 text-left">Beneficiary</th>
                        <th className="px-4 py-2.5 text-left">Bank</th>
                        <th className="px-4 py-2.5 text-left">Account</th>
                        <th className="px-4 py-2.5 text-left">IFSC</th>
                        <th className="px-4 py-2.5 text-right">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.payments.length === 0 && (
                        <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-400">Nobody can be paid by bank transfer yet.</td></tr>
                      )}
                      {data.payments.map((p) => (
                        <tr key={p.payslip_id} className="border-b border-gray-100 last:border-0">
                          <td className="px-4 py-2.5">
                            <p className="font-medium text-gray-900">{p.beneficiary_name}</p>
                            <p className="text-xs text-gray-400">{p.full_name} · <span className="font-mono">{p.employee_code}</span></p>
                          </td>
                          <td className="px-4 py-2.5 text-gray-600">{p.bank_name}</td>
                          <td className="px-4 py-2.5 font-mono text-gray-700">•••• {p.account_ending}</td>
                          <td className="px-4 py-2.5 font-mono text-gray-700">{p.ifsc}</td>
                          <td className="px-4 py-2.5 text-right font-medium text-gray-900">{money(p.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-gray-500">The file has the full account numbers. Taking it is recorded.</p>
                <button onClick={() => start('file', () => downloadBankFile(run.id, payDate || undefined))}
                  disabled={busy === 'file' || data.payments.length === 0}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium">
                  {busy === 'file' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                  Download CSV
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
