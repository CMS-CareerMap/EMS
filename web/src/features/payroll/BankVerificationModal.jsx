import { useState } from 'react'
import {
  X, Landmark, CheckCircle2, XCircle, AlertTriangle, FileText,
  Upload, Check, ShieldCheck, Edit3, Loader2, CreditCard, Building2, User, Eye
} from 'lucide-react'
import { useUpdateBankDetails, useVerifyBankAccount } from '../../hooks/useBankDetails'
import { useAuthStore } from '../../stores/authStore'

const POPULAR_BANKS = [
  'HDFC Bank',
  'ICICI Bank',
  'State Bank of India',
  'Axis Bank',
  'Kotak Mahindra Bank',
  'Punjab National Bank',
  'Bank of Baroda',
  'Canara Bank',
  'Union Bank of India',
  'IDFC FIRST Bank',
  'Yes Bank',
  'Federal Bank'
]

export default function BankVerificationModal({ open, onClose, profile, mode = 'review' }) {
  const { user, can } = useAuthStore()
  // Who may review bank details: the matrix gives them to Accounts (and Super
  // Admin), as the server's employee:bank:read does. The role list here also
  // named HR and Admin — so an HR edit verified itself, including HR's own.
  const isHrOrFinance = can('employee:bank:read')

  const updateBank = useUpdateBankDetails()
  const verifyBank = useVerifyBankAccount()

  const [activeMode, setActiveMode] = useState(mode) // 'review' | 'edit'
  const [prevOpen, setPrevOpen] = useState(false)
  const [prevProfileId, setPrevProfileId] = useState(null)
  const [remarks, setRemarks] = useState('')
  const [errorMsg, setErrorMsg] = useState('')

  // Edit form state
  const [bankName, setBankName] = useState('')
  const [customBankName, setCustomBankName] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [confirmAccountNumber, setConfirmAccountNumber] = useState('')
  const [accountHolderName, setAccountHolderName] = useState('')
  const [ifsc, setIfsc] = useState('')
  const [branch, setBranch] = useState('')
  const [accountType, setAccountType] = useState('Savings')
  const [proofFileName, setProofFileName] = useState('')
  const [proofFileUrl, setProofFileUrl] = useState('')
  const [proofPreviewOpen, setProofPreviewOpen] = useState(false)

  // Sync state when modal opens or profile changes during render
  if (open && profile && (open !== prevOpen || profile.id !== prevProfileId)) {
    setPrevOpen(open)
    setPrevProfileId(profile.id)
    setActiveMode(mode)
    setRemarks('')
    setErrorMsg('')

    const currentBank = profile.bank_name || ''
    if (POPULAR_BANKS.includes(currentBank)) {
      setBankName(currentBank)
      setCustomBankName('')
    } else if (currentBank) {
      setBankName('Other')
      setCustomBankName(currentBank)
    } else {
      setBankName('HDFC Bank')
      setCustomBankName('')
    }

    setAccountNumber(profile.bank_account || '')
    setConfirmAccountNumber(profile.bank_account || '')
    setAccountHolderName(profile.bank_account_holder_name || profile.full_name || '')
    setIfsc(profile.ifsc || '')
    setBranch(profile.bank_branch || 'Main Branch')
    setAccountType(profile.bank_account_type || 'Savings')
    setProofFileName(profile.bank_proof_name || 'cancelled_cheque.pdf')
    setProofFileUrl(profile.bank_proof_url || '')
  } else if (!open && prevOpen) {
    setPrevOpen(false)
  }

  if (!open || !profile) return null

  const effectiveBankName = bankName === 'Other' ? customBankName : bankName
  const status = profile.bank_verification_status || 'pending'

  const handleFileChange = (e) => {
    const file = e.target.files?.[0]
    if (file) {
      setProofFileName(file.name)
      const reader = new FileReader()
      reader.onload = (evt) => {
        setProofFileUrl(evt.target.result)
      }
      reader.readAsDataURL(file)
    }
  }

  const handleApprove = async () => {
    setErrorMsg('')
    try {
      await verifyBank.mutateAsync({
        employeeId: profile.id,
        status: 'verified',
        remarks: remarks.trim() || 'Verified for salary credit by HR/Finance.',
        verifiedBy: user?.id || 'HR/Finance Admin',
        employeeName: profile.full_name
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'Failed to verify bank account.')
    }
  }

  const handleReject = async () => {
    if (!remarks.trim()) {
      setErrorMsg('Please provide a reason for rejecting the bank details.')
      return
    }
    setErrorMsg('')
    try {
      await verifyBank.mutateAsync({
        employeeId: profile.id,
        status: 'rejected',
        remarks: remarks.trim(),
        verifiedBy: user?.id || 'HR/Finance Admin',
        employeeName: profile.full_name
      })
      onClose()
    } catch (err) {
      setErrorMsg(err.message || 'Failed to reject bank account.')
    }
  }

  const handleSaveBankDetails = async (e) => {
    e.preventDefault()
    setErrorMsg('')

    if (!effectiveBankName.trim()) {
      setErrorMsg('Please select or enter your bank name.')
      return
    }
    if (!accountHolderName.trim()) {
      setErrorMsg('Please enter the account holder name.')
      return
    }
    if (!accountNumber.trim() || accountNumber.length < 8) {
      setErrorMsg('Please enter a valid bank account number (at least 8 digits).')
      return
    }
    if (accountNumber !== confirmAccountNumber) {
      setErrorMsg('Account numbers do not match.')
      return
    }
    if (!ifsc.trim() || ifsc.length < 6) {
      setErrorMsg('Please enter a valid IFSC code.')
      return
    }

    try {
      await updateBank.mutateAsync({
        employeeId: profile.id,
        bank_name: effectiveBankName.trim(),
        bank_account: accountNumber.trim(),
        bank_account_holder_name: accountHolderName.trim(),
        ifsc: ifsc.trim().toUpperCase(),
        bank_branch: branch.trim() || 'Main Branch',
        bank_account_type: accountType,
        bank_proof_name: proofFileName || 'cancelled_cheque.pdf',
        bank_proof_url: proofFileUrl || profile.bank_proof_url,
        employeeName: profile.full_name,
        isHrUpdate: isHrOrFinance
      })
      setActiveMode('review')
    } catch (err) {
      setErrorMsg(err.message || 'Failed to save bank details.')
    }
  }

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden border border-gray-100 transition-all">

        {/* Header */}
        <div className="px-6 py-5 bg-slate-900 text-white flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-blue-500/20 border border-blue-400/30 text-blue-300">
              <Landmark className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">
                {activeMode === 'review' ? 'Verify Bank Account Details' : 'Manage Bank Account for Salary Credit'}
              </h3>
              <p className="text-xs text-slate-300 mt-0.5">{profile.full_name} ({profile.employee_id || 'EMP'})</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Error banner */}
        {errorMsg && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-red-50 border border-red-200 text-red-700 text-xs flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-600" />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Body Content */}
        {activeMode === 'review' ? (
          <div className="p-6 space-y-5">
            {/* Status Badge */}
            <div className="flex items-center justify-between p-3.5 rounded-xl bg-slate-50 border border-slate-200">
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500 font-medium">Verification Status:</span>
                {status === 'verified' && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Verified
                  </span>
                )}
                {status === 'pending' && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                    <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" /> Pending Verification
                  </span>
                )}
                {status === 'rejected' && (
                  <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
                    <XCircle className="w-3.5 h-3.5 text-rose-600" /> Rejected
                  </span>
                )}
              </div>
              <button
                onClick={() => setActiveMode('edit')}
                className="text-xs text-blue-600 font-semibold hover:text-blue-700 flex items-center gap-1"
              >
                <Edit3 className="w-3.5 h-3.5" /> Edit Details
              </button>
            </div>

            {/* Account Info Cards */}
            <div className="bg-slate-50/70 rounded-xl p-4 border border-slate-200 space-y-3">
              <div className="grid grid-cols-2 gap-4 text-xs">
                <div>
                  <p className="text-slate-400">Bank Name</p>
                  <p className="font-bold text-slate-900 text-sm mt-0.5">{profile.bank_name || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-slate-400">Account Type</p>
                  <p className="font-semibold text-slate-800 text-sm mt-0.5">{profile.bank_account_type || 'Savings'}</p>
                </div>
                <div>
                  <p className="text-slate-400">Account Holder Name</p>
                  <p className="font-semibold text-slate-800 text-sm mt-0.5">{profile.bank_account_holder_name || profile.full_name}</p>
                </div>
                <div>
                  <p className="text-slate-400">Account Number</p>
                  <p className="font-mono font-bold text-slate-900 text-sm mt-0.5 tracking-wider">{profile.bank_account || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-slate-400">IFSC Code</p>
                  <p className="font-mono font-semibold text-blue-700 text-sm mt-0.5 uppercase">{profile.ifsc || 'N/A'}</p>
                </div>
                <div>
                  <p className="text-slate-400">Branch</p>
                  <p className="font-medium text-slate-800 text-sm mt-0.5">{profile.bank_branch || 'Main Branch'}</p>
                </div>
              </div>

              {/* Bank Proof Attachment */}
              <div className="pt-2 border-t border-slate-200/80 flex items-center justify-between">
                <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                  <FileText className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="text-xs text-slate-600 font-medium shrink-0">Bank Proof:</span>
                  <span className="text-xs font-mono text-slate-900 truncate">{profile.bank_proof_name || 'cancelled_cheque.pdf'}</span>
                </div>
                <button
                  type="button"
                  onClick={() => setProofPreviewOpen(true)}
                  className="text-xs text-blue-600 hover:text-blue-700 font-semibold bg-blue-50 hover:bg-blue-100 px-2.5 py-1 rounded-lg border border-blue-200 flex items-center gap-1 shrink-0 transition-colors"
                >
                  <Eye className="w-3.5 h-3.5" /> View Proof
                </button>
              </div>
            </div>

            {/* Rejection / Verification notes if existing */}
            {profile.bank_verification_remarks && (
              <div className="p-3.5 rounded-xl bg-blue-50/60 border border-blue-200 text-xs">
                <p className="font-semibold text-blue-900">Verification Remarks / Notes:</p>
                <p className="text-blue-800 mt-1">{profile.bank_verification_remarks}</p>
              </div>
            )}

            {/* Verification action box for HR / Finance */}
            {isHrOrFinance && (
              <div className="space-y-3 pt-2 border-t border-gray-100">
                <label className="block text-xs font-semibold text-slate-700">
                  HR / Finance Remarks & Rejection Reason
                </label>
                <textarea
                  rows={2}
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  placeholder="Enter verification notes or rejection reason if rejecting..."
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-slate-900 placeholder:text-gray-400"
                />

                <div className="flex items-center justify-end gap-2 pt-2">
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={verifyBank.isPending}
                    className="px-4 py-2 rounded-xl border border-rose-300 text-rose-700 bg-rose-50 hover:bg-rose-100 text-xs font-semibold transition-colors flex items-center gap-1.5"
                  >
                    <XCircle className="w-4 h-4 text-rose-600" /> Reject Submission
                  </button>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={verifyBank.isPending}
                    className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold transition-colors shadow-sm flex items-center gap-1.5"
                  >
                    {verifyBank.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin text-white" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-white" />
                    )}
                    Approve & Verify Bank
                  </button>
                </div>
              </div>
            )}
          </div>
        ) : (
          /* Edit Mode */
          <form onSubmit={handleSaveBankDetails} className="p-6 space-y-4">
            <div className="space-y-1">
              <label className="text-xs font-semibold text-gray-700">Bank Name *</label>
              <select
                value={bankName}
                onChange={(e) => setBankName(e.target.value)}
                className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                {POPULAR_BANKS.map((b) => (
                  <option key={b} value={b}>{b}</option>
                ))}
                <option value="Other">Other Bank...</option>
              </select>
              {bankName === 'Other' && (
                <input
                  type="text"
                  placeholder="Enter Bank Name"
                  value={customBankName}
                  onChange={(e) => setCustomBankName(e.target.value)}
                  className="w-full mt-2 border border-gray-300 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
                />
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Account Holder Name *</label>
                <input
                  type="text"
                  placeholder="As printed on bank account"
                  value={accountHolderName}
                  onChange={(e) => setAccountHolderName(e.target.value)}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Account Type</label>
                <select
                  value={accountType}
                  onChange={(e) => setAccountType(e.target.value)}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs text-gray-900 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
                >
                  <option value="Savings">Savings Account</option>
                  <option value="Current">Current Account</option>
                  <option value="Salary">Salary Account</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Bank Account Number *</label>
                <input
                  type="text"
                  placeholder="Enter account number"
                  value={accountNumber}
                  onChange={(e) => setAccountNumber(e.target.value.replace(/\D/g, ''))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Confirm Account Number *</label>
                <input
                  type="text"
                  placeholder="Re-enter account number"
                  value={confirmAccountNumber}
                  onChange={(e) => setConfirmAccountNumber(e.target.value.replace(/\D/g, ''))}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs font-mono focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">IFSC Code *</label>
                <input
                  type="text"
                  placeholder="e.g. HDFC0000123"
                  value={ifsc}
                  onChange={(e) => setIfsc(e.target.value.toUpperCase())}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs font-mono uppercase focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
                />
              </div>
              <div className="space-y-1">
                <label className="text-xs font-semibold text-gray-700">Branch Name</label>
                <input
                  type="text"
                  placeholder="e.g. BKC Branch, Mumbai"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value)}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900"
                />
              </div>
            </div>

            {/* Proof Upload */}
            <div className="space-y-1.5 pt-1">
              <label className="text-xs font-semibold text-gray-700 flex items-center justify-between">
                <span>Upload Bank Proof (Cancelled Cheque / Passbook)</span>
                <span className="text-[11px] text-gray-400 font-normal">PDF, PNG, JPG</span>
              </label>
              <label className="flex items-center justify-center gap-2 p-3 border-2 border-dashed border-gray-300 hover:border-blue-500 rounded-xl cursor-pointer bg-slate-50/50 transition-colors">
                <Upload className="w-4 h-4 text-blue-600" />
                <span className="text-xs text-gray-700 font-medium truncate">
                  {proofFileName || 'Click to select cancelled cheque or passbook file'}
                </span>
                <input
                  type="file"
                  accept="image/*,.pdf"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </label>

              {/* View Proof Before Submitting */}
              {(proofFileName || proofFileUrl || profile.bank_proof_url) && (
                <div className="flex items-center justify-between p-2.5 bg-blue-50/70 rounded-xl border border-blue-200 text-xs mt-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FileText className="w-4 h-4 text-blue-600 shrink-0" />
                    <span className="font-mono text-slate-800 truncate">{proofFileName || profile.bank_proof_name || 'cancelled_cheque.pdf'}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setProofPreviewOpen(true)}
                    className="px-2.5 py-1 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold flex items-center gap-1 shadow-xs transition-colors shrink-0"
                  >
                    <Eye className="w-3.5 h-3.5" /> View Proof
                  </button>
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex items-center justify-between pt-4 border-t border-gray-100">
              <button
                type="button"
                onClick={() => setActiveMode('review')}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700"
              >
                Back to Review
              </button>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-xl border border-gray-300 text-gray-700 hover:bg-gray-50 text-xs font-medium transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={updateBank.isPending}
                  className="px-5 py-2 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold transition-colors flex items-center gap-1.5 shadow-sm"
                >
                  {updateBank.isPending ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-white" />
                      Saving...
                    </>
                  ) : (
                    <span>Submit Bank Account</span>
                  )}
                </button>
              </div>
            </div>
          </form>
        )}

      </div>

      {/* Proof Document Preview Modal */}
      {proofPreviewOpen && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-xl overflow-hidden border border-slate-200 flex flex-col">
            <div className="px-6 py-4 border-b border-slate-100 bg-slate-50 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Landmark className="w-5 h-5 text-blue-600" />
                <div>
                  <h3 className="text-base font-bold text-slate-900">Bank Proof Attachment</h3>
                  <p className="text-xs text-slate-500">{profile.full_name} · {profile.bank_name || 'Bank Account'}</p>
                </div>
              </div>
              <button onClick={() => setProofPreviewOpen(false)} className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-200">
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-6 bg-slate-900/5 flex flex-col items-center justify-center min-h-[300px]">
              {(profile.bank_proof_url || proofFileUrl) ? (
                <img
                  src={proofFileUrl || profile.bank_proof_url}
                  alt="Bank Proof Document"
                  className="max-h-[50vh] object-contain rounded-xl shadow-md border border-slate-200 bg-white"
                />
              ) : (
                /* Authentic Cancelled Cheque / Passbook Card Preview */
                <div className="w-full bg-white rounded-2xl border-2 border-slate-300 shadow-md p-6 relative overflow-hidden space-y-4">
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none opacity-15 rotate-[-20deg]">
                    <span className="text-3xl font-extrabold tracking-widest text-slate-900 border-4 border-slate-900 px-6 py-2 rounded-xl">
                      CANCELLED CHEQUE
                    </span>
                  </div>
                  
                  <div className="flex items-center justify-between border-b pb-3 border-slate-200">
                    <div className="flex items-center gap-2">
                      <Building2 className="w-5 h-5 text-blue-700" />
                      <span className="font-bold text-slate-900 text-sm">{profile.bank_name || 'HDFC Bank'}</span>
                    </div>
                    <span className="font-mono text-xs text-slate-400">PAYEE REF: CHEQUE-5849</span>
                  </div>

                  <div className="grid grid-cols-2 gap-3 text-xs pt-1">
                    <div>
                      <span className="text-slate-400 block">Account Holder Name:</span>
                      <span className="font-bold text-slate-900">{profile.bank_account_holder_name || profile.full_name}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Account Number:</span>
                      <span className="font-mono font-bold text-blue-700">{profile.bank_account || 'XXXXXXXX5678'}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">IFSC Code:</span>
                      <span className="font-mono font-bold text-slate-800">{profile.ifsc || 'HDFC0001234'}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 block">Branch Name:</span>
                      <span className="font-medium text-slate-800">{profile.bank_branch || 'BKC Branch, Mumbai'}</span>
                    </div>
                  </div>

                  <div className="pt-3 border-t border-slate-100 flex items-center justify-between text-[11px] text-slate-400">
                    <span>Attached File: {profile.bank_proof_name || 'cancelled_cheque.pdf'}</span>
                    <span className="font-mono text-emerald-600 font-semibold">● VERIFICATION ATTACHMENT</span>
                  </div>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 bg-white flex justify-end">
              <button
                onClick={() => setProofPreviewOpen(false)}
                className="px-4 py-2 rounded-xl border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-slate-50"
              >
                Close Preview
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
