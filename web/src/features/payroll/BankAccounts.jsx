import { useMemo, useState } from 'react'
import { Search, Pencil, Plus, ShieldCheck, Loader2, CheckCircle2, XCircle, Clock, CircleDashed } from 'lucide-react'
import { toast } from 'sonner'
import { useBankAccounts, useSaveBankAccount, useVerifyBankAccount } from '../../hooks/usePayroll'
import { useAuthStore } from '../../stores/authStore'
import Dialog, { inputCls } from './Dialog'

/**
 * Salary bank accounts, kept by Accounts.
 *
 * Accounts enters the account from the cancelled cheque or passbook and marks
 * it checked; the bank file pays checked accounts only (a setting), and never
 * a rejected one. Nobody checks their own account — the server refuses it, and
 * the buttons are not drawn for it.
 */

const STATUS = {
  verified: { label: 'Verified', cls: 'bg-green-100 text-green-800', icon: CheckCircle2 },
  pending: { label: 'Waiting for a check', cls: 'bg-amber-100 text-amber-800', icon: Clock },
  unverified: { label: 'Not checked', cls: 'bg-gray-100 text-gray-700', icon: CircleDashed },
  rejected: { label: 'Rejected', cls: 'bg-red-100 text-red-800', icon: XCircle },
}

const FILTERS = [
  { id: 'all', label: 'Everybody' },
  { id: 'unchecked', label: 'Not checked' },
  { id: 'verified', label: 'Verified' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'none', label: 'No account' },
]

function matches(filter, row) {
  const status = row.bank_account?.verification_status
  if (filter === 'all') return true
  if (filter === 'none') return !row.bank_account
  if (filter === 'unchecked') return status === 'pending' || status === 'unverified'
  return status === filter
}

export default function BankAccounts() {
  const can = useAuthStore((s) => s.can)
  const ownEmployeeId = useAuthStore((s) => s.profile?.id)
  const canManage = can('employee:bank:manage')
  const { data: rows = [], isLoading } = useBankAccounts()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState('all')
  const [editing, setEditing] = useState(null)
  const [reviewing, setReviewing] = useState(null)

  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.id, rows.filter((r) => matches(f.id, r)).length])), [rows])
  const shown = rows.filter((r) => {
    if (!matches(filter, r)) return false
    const q = search.trim().toLowerCase()
    return !q || r.full_name.toLowerCase().includes(q) || r.employee_code.toLowerCase().includes(q)
  })

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((f) => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border ${filter === f.id ? 'bg-blue-600 border-blue-600 text-white' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {f.label} <span className="opacity-75">{counts[f.id]}</span>
            </button>
          ))}
        </div>
        <div className="relative">
          <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name or code"
            className="pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm w-56" />
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-200 text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-4 py-3 text-left">Employee</th>
                <th className="px-4 py-3 text-left">Bank</th>
                <th className="px-4 py-3 text-left">Account</th>
                <th className="px-4 py-3 text-left">IFSC</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Loading…</td></tr>}
              {!isLoading && shown.length === 0 && <tr><td colSpan={6} className="px-4 py-10 text-center text-gray-400">Nobody here.</td></tr>}
              {shown.map((row) => {
                const a = row.bank_account
                const status = a ? STATUS[a.verification_status] : null
                const own = row.employee_id === ownEmployeeId
                return (
                  <tr key={row.employee_id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <p className="font-medium text-gray-900">{row.full_name}{own && <span className="ml-1.5 text-xs text-gray-400">(you)</span>}</p>
                      <p className="text-xs text-gray-400"><span className="font-mono">{row.employee_code}</span>{row.department ? ` · ${row.department}` : ''}</p>
                    </td>
                    <td className="px-4 py-3 text-gray-700">{a ? <>{a.bank_name}{a.branch && <p className="text-xs text-gray-400">{a.branch}</p>}</> : <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-3">
                      {a ? <><p className="font-mono text-gray-800">•••• {a.account_number.slice(-4)}</p><p className="text-xs text-gray-400">{a.account_holder_name}</p></> : <span className="text-gray-400">—</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-gray-700">{a?.ifsc ?? '—'}</td>
                    <td className="px-4 py-3">
                      {status ? (
                        <span className={`inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold ${status.cls}`}>
                          <status.icon className="w-3.5 h-3.5" /> {status.label}
                        </span>
                      ) : <span className="text-xs text-gray-400">No account</span>}
                      {a?.verification_status === 'rejected' && a.verification_remarks && (
                        <p className="text-xs text-red-600 mt-1 max-w-56">{a.verification_remarks}</p>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {canManage && (
                        <div className="flex justify-end gap-1.5">
                          {a && !own && a.verification_status !== 'verified' && (
                            <button onClick={() => setReviewing(row)} className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold">
                              <ShieldCheck className="w-3.5 h-3.5" /> Check
                            </button>
                          )}
                          <button onClick={() => setEditing(row)} aria-label={`${a ? 'Edit' : 'Add'} ${row.full_name}'s bank account`}
                            className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50 text-gray-700 text-xs font-medium">
                            {a ? <Pencil className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {a ? 'Edit' : 'Add'}
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {editing && <AccountDialog row={editing} own={editing.employee_id === ownEmployeeId} onClose={() => setEditing(null)} />}
      {reviewing && <ReviewDialog row={reviewing} onClose={() => setReviewing(null)} />}
    </div>
  )
}

function AccountDialog({ row, own, onClose }) {
  const save = useSaveBankAccount()
  const a = row.bank_account
  const [form, setForm] = useState({
    bankName: a?.bank_name ?? '',
    accountHolderName: a?.account_holder_name ?? row.full_name,
    accountNumber: a?.account_number ?? '',
    confirmNumber: a?.account_number ?? '',
    ifsc: a?.ifsc ?? '',
    branch: a?.branch ?? '',
    accountType: a?.account_type ?? 'Savings',
    markVerified: false,
  })
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))

  const numberChanged = !a || form.accountNumber !== a.account_number || form.ifsc.toUpperCase() !== a.ifsc
  const mismatch = form.confirmNumber !== form.accountNumber

  async function handleSubmit(e) {
    e.preventDefault()
    if (mismatch) return
    const ok = await save.mutateAsync({
      employeeId: row.employee_id,
      bankName: form.bankName,
      accountHolderName: form.accountHolderName,
      accountNumber: form.accountNumber,
      ifsc: form.ifsc.toUpperCase(),
      branch: form.branch || null,
      accountType: form.accountType || null,
      markVerified: !own && form.markVerified,
    }).then(() => true, () => false)
    if (ok) {
      toast.success(`${row.full_name}'s bank account saved`)
      onClose()
    }
  }

  return (
    <Dialog title={`${a ? 'Edit' : 'Add'} bank account — ${row.full_name}`} onClose={onClose}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Bank">
            <input className={inputCls} value={form.bankName} onChange={(e) => set('bankName', e.target.value)} required minLength={2} maxLength={80} placeholder="HDFC Bank" />
          </Field>
          <Field label="Name on the account">
            <input className={inputCls} value={form.accountHolderName} onChange={(e) => set('accountHolderName', e.target.value)} required minLength={2} maxLength={100} />
          </Field>
          <Field label="Account number">
            <input className={`${inputCls} font-mono`} value={form.accountNumber} inputMode="numeric" autoComplete="off"
              onChange={(e) => set('accountNumber', e.target.value.replace(/\D/g, ''))} required pattern="\d{9,18}" title="9 to 18 digits" />
          </Field>
          <Field label="Account number again" error={mismatch && form.confirmNumber ? 'The two numbers differ' : null}>
            <input className={`${inputCls} font-mono`} value={form.confirmNumber} inputMode="numeric" autoComplete="off"
              onChange={(e) => set('confirmNumber', e.target.value.replace(/\D/g, ''))} onPaste={(e) => e.preventDefault()} required />
          </Field>
          <Field label="IFSC">
            <input className={`${inputCls} font-mono uppercase`} value={form.ifsc} onChange={(e) => set('ifsc', e.target.value.toUpperCase().trim())}
              required pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" title="Like HDFC0001234" maxLength={11} />
          </Field>
          <Field label="Branch (optional)">
            <input className={inputCls} value={form.branch} onChange={(e) => set('branch', e.target.value)} maxLength={100} />
          </Field>
          <Field label="Account type">
            <select className={inputCls} value={form.accountType} onChange={(e) => set('accountType', e.target.value)}>
              <option value="Savings">Savings</option>
              <option value="Salary">Salary</option>
              <option value="Current">Current</option>
            </select>
          </Field>
        </div>

        {own ? (
          <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg p-3">
            This is your own account, so somebody else in Accounts, or the Super Admin, has to check it.
          </p>
        ) : (
          <label className="flex items-start gap-2 text-sm text-gray-700">
            <input type="checkbox" className="mt-0.5" checked={form.markVerified} onChange={(e) => set('markVerified', e.target.checked)} />
            <span>I have checked these details against a cancelled cheque or passbook page.</span>
          </label>
        )}
        {a?.verification_status === 'verified' && numberChanged && !form.markVerified && (
          <p className="text-xs text-amber-700">Changing the account number or IFSC means it has to be checked again.</p>
        )}

        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium text-gray-700">Cancel</button>
          <button type="submit" disabled={save.isPending || mismatch}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium disabled:opacity-60">
            {save.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function ReviewDialog({ row, onClose }) {
  const verify = useVerifyBankAccount()
  const a = row.bank_account
  const [remarks, setRemarks] = useState('')
  const [asked, setAsked] = useState(false)

  async function decide(decision) {
    if (decision === 'rejected' && !remarks.trim()) {
      setAsked(true)
      return
    }
    const ok = await verify.mutateAsync({ employeeId: row.employee_id, decision, remarks: remarks.trim() || null }).then(() => true, () => false)
    if (ok) {
      toast.success(decision === 'verified' ? `${row.full_name}'s account verified` : `${row.full_name}'s account rejected`)
      onClose()
    }
  }

  return (
    <Dialog title={`Check bank account — ${row.full_name}`} onClose={onClose}>
      <dl className="grid grid-cols-[9rem_1fr] gap-y-1.5 text-sm">
        <dt className="text-gray-400">Bank</dt><dd className="font-medium text-gray-900">{a.bank_name}{a.branch ? `, ${a.branch}` : ''}</dd>
        <dt className="text-gray-400">Name on account</dt><dd className="font-medium text-gray-900">{a.account_holder_name}</dd>
        <dt className="text-gray-400">Account number</dt><dd className="font-mono font-medium text-gray-900">{a.account_number}</dd>
        <dt className="text-gray-400">IFSC</dt><dd className="font-mono font-medium text-gray-900">{a.ifsc}</dd>
        <dt className="text-gray-400">Type</dt><dd className="text-gray-900">{a.account_type ?? '—'}</dd>
        <dt className="text-gray-400">Last changed</dt><dd className="text-gray-900">{a.updated_at ? new Date(a.updated_at).toLocaleString('en-IN') : '—'}</dd>
        <dt className="text-gray-400">Proof</dt><dd className="text-gray-500">No proof uploaded yet</dd>
      </dl>
      <p className="text-xs text-gray-500">Verify only after comparing every detail with a cancelled cheque or passbook page.</p>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium text-gray-600">Remarks <span className="text-gray-400 font-normal">(needed to reject)</span></span>
        <input className={inputCls} value={remarks} maxLength={300} onChange={(e) => setRemarks(e.target.value)} placeholder="For example: IFSC does not match the cheque" />
        {asked && !remarks.trim() && <span className="text-xs text-red-600">Say why, so it can be put right.</span>}
      </label>
      <div className="flex justify-end gap-2">
        <button onClick={() => decide('rejected')} disabled={verify.isPending}
          className="px-4 py-2 rounded-lg border border-red-200 text-red-600 hover:bg-red-50 text-sm font-medium disabled:opacity-60">Reject</button>
        <button onClick={() => decide('verified')} disabled={verify.isPending}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-green-600 hover:bg-green-700 text-white text-sm font-medium disabled:opacity-60">
          {verify.isPending && <Loader2 className="w-4 h-4 animate-spin" />} Verify
        </button>
      </div>
    </Dialog>
  )
}

function Field({ label, error = null, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-gray-600">{label}</span>
      {children}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </label>
  )
}
