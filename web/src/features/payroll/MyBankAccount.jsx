import { Landmark, CheckCircle2, XCircle, Clock, CircleDashed } from 'lucide-react'
import { useMyBankAccount } from '../../hooks/usePayroll'

/**
 * Where the signed-in person's salary is paid, as Accounts recorded it.
 *
 * Read-only. The version this replaces let an employee "submit" an account
 * that was written to the browser's own storage, where nobody paying salaries
 * would ever see it — and showed "Pending Verification" for an account that
 * did not exist. Accounts records the account from a cancelled cheque; this
 * shows what they recorded.
 */

const STATUS = {
  verified: { label: 'Verified', cls: 'bg-emerald-100 text-emerald-800', icon: CheckCircle2 },
  pending: { label: 'Waiting for a check', cls: 'bg-amber-100 text-amber-800', icon: Clock },
  unverified: { label: 'Not checked yet', cls: 'bg-gray-100 text-gray-700', icon: CircleDashed },
  rejected: { label: 'Rejected', cls: 'bg-rose-100 text-rose-800', icon: XCircle },
}

export default function MyBankAccount() {
  const { data: account, isLoading, error } = useMyBankAccount()
  const status = account ? STATUS[account.verification_status] : null

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Landmark className="w-4 h-4 text-blue-600" />
        <h4 className="text-sm font-bold text-gray-900">Bank Account for Salary Credit</h4>
      </div>

      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200/80 space-y-2.5 text-xs">
        {isLoading && <p className="text-slate-400">Loading…</p>}
        {error && <p className="text-rose-600">{error.message}</p>}
        {!isLoading && !error && !account && (
          <p className="text-slate-600">No bank account is recorded for your salary yet.</p>
        )}
        {account && (
          <>
            <Row label="Bank" value={account.bank_name} />
            <Row label="Name on account" value={account.account_holder_name} />
            <Row label="Account number" value={`•••• ${account.account_ending}`} mono />
            <Row label="IFSC" value={account.ifsc} mono />
            <div className="flex items-center justify-between pt-1 border-t border-slate-200/60">
              <span className="text-slate-500">Status</span>
              {status && (
                <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${status.cls}`}>
                  <status.icon className="w-3 h-3" /> {status.label}
                </span>
              )}
            </div>
            {account.verification_status === 'rejected' && account.verification_remarks && (
              <p className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-[11px] text-rose-700">
                <span className="font-semibold block">Why it was rejected</span>
                {account.verification_remarks}
              </p>
            )}
          </>
        )}
        {!isLoading && !error && (
          <p className="text-[11px] text-slate-500 pt-1">
            To add or change it, give Accounts a cancelled cheque or a passbook page of the account.
          </p>
        )}
      </div>
    </div>
  )
}

function Row({ label, value, mono = false }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className={`font-semibold text-slate-900 text-right ${mono ? 'font-mono' : ''}`}>{value || '—'}</span>
    </div>
  )
}
