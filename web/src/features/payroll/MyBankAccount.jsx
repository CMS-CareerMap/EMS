import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Landmark, CheckCircle2, XCircle, Clock, CircleDashed, Pencil, Plus, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import DataState from '../../components/DataState'
import { useMyBankAccount, useSubmitMyBankAccount } from '../../hooks/usePayroll'
import { prepareUpload } from '../../lib/prepareUpload'
import { btn } from '../../components/ui/styles'

/**
 * Where the signed-in person's salary is paid — and how to send in a new
 * account.
 *
 * Sending one in needs a photo or PDF of a cancelled cheque or a passbook page
 * showing the account. It then waits for Accounts to check it against that
 * proof; until it is verified the bank file does not pay into it. The number
 * shows only its last four digits here.
 */

const STATUS = {
  verified: { label: 'Verified', cls: 'bg-emerald-100 text-emerald-800', icon: CheckCircle2 },
  pending: { label: 'Waiting for a check', cls: 'bg-amber-100 text-amber-800', icon: Clock },
  unverified: { label: 'Not checked yet', cls: 'bg-gray-100 text-gray-700', icon: CircleDashed },
  rejected: { label: 'Rejected', cls: 'bg-rose-100 text-rose-800', icon: XCircle },
}

export default function MyBankAccount() {
  const bank = useMyBankAccount()
  const account = bank.data?.account ?? null
  const [editing, setEditing] = useState(false)
  const status = account ? STATUS[account.verification_status] : null

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Landmark className="w-4 h-4 text-brand-600" />
          <h4 className="text-sm font-bold text-gray-900">Bank Account for Salary Credit</h4>
        </div>
        {bank.isSuccess && (
          <button onClick={() => setEditing(true)} className="flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-700">
            {account ? <Pencil className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />} {account ? 'Change' : 'Add account'}
          </button>
        )}
      </div>

      <div className="bg-slate-50 rounded-xl p-4 border border-slate-200/80 space-y-2.5 text-xs">
        <DataState query={bank} compact isEmpty={(d) => !d.account}
          empty={<p className="text-slate-600">No bank account is recorded for your salary yet.</p>}>
          {() => (
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
        </DataState>
        {bank.isSuccess && (
          <p className="text-[11px] text-slate-500 pt-1">
            To add or change it, send the details with a photo of a cancelled cheque or a passbook page. Accounts checks it before any salary goes there.
          </p>
        )}
      </div>

      {editing && createPortal(<SubmitDialog account={account} maxMb={bank.data?.maxUploadMb} onClose={() => setEditing(false)} />, document.body)}
    </div>
  )
}

function SubmitDialog({ account, maxMb, onClose }) {
  const submit = useSubmitMyBankAccount()
  const [form, setForm] = useState({
    bankName: account?.bank_name ?? '',
    accountHolderName: account?.account_holder_name ?? '',
    accountNumber: '',
    confirmNumber: '',
    ifsc: account?.ifsc ?? '',
    branch: account?.branch ?? '',
    accountType: account?.account_type ?? 'Savings',
  })
  const [proof, setProof] = useState(null)
  const [problem, setProblem] = useState('')
  const [preparing, setPreparing] = useState(false)
  const set = (key, value) => setForm((f) => ({ ...f, [key]: value }))
  const mismatch = form.confirmNumber !== form.accountNumber

  async function handle(e) {
    e.preventDefault()
    if (mismatch) return
    setProblem('')
    let ready = null
    if (proof) {
      setPreparing(true)
      try {
        ready = await prepareUpload(proof, maxMb)
      } catch (err) {
        setProblem(err.message)
        setPreparing(false)
        return
      }
      setPreparing(false)
    }
    const ok = await submit.mutateAsync({
      bankName: form.bankName,
      accountHolderName: form.accountHolderName,
      accountNumber: form.accountNumber,
      ifsc: form.ifsc.toUpperCase(),
      branch: form.branch || null,
      accountType: form.accountType,
      proof: ready,
    }).then(() => true, (err) => {
      setProblem(err.message)
      return false
    })
    if (ok) {
      toast.success('Sent to Accounts to check')
      onClose()
    }
  }

  return (
    <Dialog title={account ? 'Change your salary account' : 'Add your salary account'} onClose={onClose}>
      <form onSubmit={handle} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label="Bank"><input className={inputCls} value={form.bankName} onChange={(e) => set('bankName', e.target.value)} required minLength={2} maxLength={80} placeholder="HDFC Bank" /></Field>
          <Field label="Name on the account"><input className={inputCls} value={form.accountHolderName} onChange={(e) => set('accountHolderName', e.target.value)} required minLength={2} maxLength={100} /></Field>
          <Field label="Account number">
            <input className={`${inputCls} font-mono`} value={form.accountNumber} inputMode="numeric" autoComplete="off" required pattern="\d{9,18}" title="9 to 18 digits"
              onChange={(e) => set('accountNumber', e.target.value.replace(/\D/g, ''))} />
          </Field>
          <Field label="Account number again" error={mismatch && form.confirmNumber ? 'The two numbers differ' : null}>
            <input className={`${inputCls} font-mono`} value={form.confirmNumber} inputMode="numeric" autoComplete="off" required
              onChange={(e) => set('confirmNumber', e.target.value.replace(/\D/g, ''))} onPaste={(e) => e.preventDefault()} />
          </Field>
          <Field label="IFSC">
            <input className={`${inputCls} font-mono uppercase`} value={form.ifsc} maxLength={11} required pattern="[A-Za-z]{4}0[A-Za-z0-9]{6}" title="Like HDFC0001234"
              onChange={(e) => set('ifsc', e.target.value.toUpperCase().trim())} />
          </Field>
          <Field label="Account type">
            <select className={inputCls} value={form.accountType} onChange={(e) => set('accountType', e.target.value)}>
              <option value="Savings">Savings</option>
              <option value="Salary">Salary</option>
              <option value="Current">Current</option>
            </select>
          </Field>
        </div>
        <Field label="Cancelled cheque or passbook page">
          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.webp" required={!account?.has_proof}
            onChange={(e) => { setProof(e.target.files?.[0] ?? null); setProblem('') }}
            className="w-full text-sm file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-semibold file:bg-brand-50 file:text-brand-700" />
          <span className="block text-xs text-gray-500">
            A clear photo or a PDF showing your name, the account number and the IFSC, up to {maxMb} MB.
            {account?.has_proof ? ' Needed again if the number or IFSC changes; otherwise the one on file is kept.' : ''}
          </span>
        </Field>
        {problem && <p className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg p-3">{problem}</p>}
        <div className="flex flex-wrap justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={preparing || submit.isPending || mismatch}
            className={btn.primary}>
            {(preparing || submit.isPending) && <Loader2 className="w-4 h-4 animate-spin" />} Send to Accounts
          </button>
        </div>
      </form>
    </Dialog>
  )
}

function Field({ label, error = null, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-semibold text-gray-700">{label}</span>
      {children}
      {error && <span className="text-xs text-red-600">{error}</span>}
    </label>
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
