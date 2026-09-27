import { createElement, useState, useMemo } from 'react'
import {
  IndianRupee, Users, CheckCircle, Clock, TrendingUp,
  Play, Download, Eye, AlertCircle, Search,
  Landmark, CheckCircle2, XCircle, Edit3, ShieldCheck, FileText
} from 'lucide-react'
import PayslipModal from '../features/payroll/PayslipModal'
import BankVerificationModal from '../features/payroll/BankVerificationModal'
import { useEmployees } from '../hooks/useEmployees'
import { usePayrollRuns, useCreatePayrollRun, useUpdatePayrollRun, usePayslips, useSalaryStructures } from '../hooks/usePayroll'
import { useAuthStore } from '../stores/authStore'
import { estimateSalary } from '../lib/salaryEstimate'
import SalaryStructures from '../features/payroll/SalaryStructures'
import { isoInstant } from '../lib/dates'

// ─── Salary computation ───────────────────────────────────────────────────────

function fmt(n) { return '₹' + Number(n || 0).toLocaleString('en-IN') }
function initials(name) { return (name || '').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase() }

const RUN_STATES = ['draft', 'processing', 'approved', 'paid']
const STATE_META = {
  draft:      { label: 'Draft',      cls: 'bg-gray-100 text-gray-600',   dot: 'bg-gray-400' },
  processing: { label: 'Processing', cls: 'bg-amber-100 text-amber-700', dot: 'bg-amber-500' },
  approved:   { label: 'Approved',   cls: 'bg-blue-100 text-blue-700',   dot: 'bg-blue-500' },
  paid:       { label: 'Paid',       cls: 'bg-green-100 text-green-700', dot: 'bg-green-500' },
}

const NOW     = new Date()
const CUR_MONTH = NOW.getMonth() + 1
const CUR_YEAR  = NOW.getFullYear()
const MONTH_NAMES = ['', 'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December']

// ─── Payroll Runs tab ─────────────────────────────────────────────────────────

function RunsTab({ employees }) {
  const { data: runs = [] } = usePayrollRuns()
  const createRun   = useCreatePayrollRun()
  const updateRun   = useUpdatePayrollRun()
  const { user }    = useAuthStore()

  const currentRun  = runs.find((r) => r.month === CUR_MONTH && r.year === CUR_YEAR)
  const runState    = currentRun?.status || 'draft'
  const stateIdx    = RUN_STATES.indexOf(runState)

  const totalGross  = employees.reduce((s, e) => s + e.salary.gross, 0)
  const totalNet    = employees.reduce((s, e) => s + e.salary.net, 0)

  const history = runs.filter((r) => !(r.month === CUR_MONTH && r.year === CUR_YEAR))

  const nextAction = {
    draft:      { label: 'Run Payroll',  icon: Play,        next: 'processing', color: 'bg-blue-600 hover:bg-blue-700 text-white' },
    processing: { label: 'Approve',      icon: CheckCircle, next: 'approved',   color: 'bg-green-600 hover:bg-green-700 text-white' },
    approved:   { label: 'Mark as Paid', icon: CheckCircle, next: 'paid',       color: 'bg-emerald-600 hover:bg-emerald-700 text-white' },
    paid: null,
  }[runState]

  async function handleAdvance() {
    const next = nextAction.next
    if (!currentRun) {
      await createRun.mutateAsync({
        month: CUR_MONTH, year: CUR_YEAR, status: next,
        total_gross: totalGross, total_net: totalNet, processed_by: user?.id,
        processed_at: isoInstant(),
        payslips: employees.map((employee) => ({
          employee_id: employee.id,
          gross: employee.salary.gross,
          basic: employee.salary.basic,
          hra: employee.salary.hra,
          da: employee.salary.da,
          special_allowance: employee.salary.special,
          pf: employee.salary.pf,
          esi: employee.salary.esi,
          pt: employee.salary.pt,
          tds: 0,
          net: employee.salary.net,
        })),
      })
    } else {
      await updateRun.mutateAsync({ id: currentRun.id, status: next, processed_by: user?.id, processed_at: isoInstant() })
    }
  }

  function handleExport() {
    const headers = ['Employee Name', 'Employee ID', 'Department', 'Designation', 'Annual CTC', 'Gross Monthly', 'Basic', 'HRA', 'Special Allowance', 'PF Deduction', 'ESI Deduction', 'PT Deduction', 'Net Payout']
    const rows = employees.map((e) => [
      e.full_name || '',
      e.employee_id || '',
      e.department || '',
      e.designation || '',
      e.ctc || 0,
      e.salary?.gross || 0,
      e.salary?.basic || 0,
      e.salary?.hra || 0,
      e.salary?.special || 0,
      e.salary?.pf || 0,
      e.salary?.esi || 0,
      e.salary?.pt || 0,
      e.salary?.net || 0,
    ])
    const lines = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `payroll_run_${MONTH_NAMES[CUR_MONTH]}_${CUR_YEAR}.csv`
    a.click()
  }

  return (
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <div className="flex items-center gap-3 mb-3">
              <p className="text-base font-semibold text-gray-900">{MONTH_NAMES[CUR_MONTH]} {CUR_YEAR} Payroll</p>
              <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${STATE_META[runState].cls}`}>
                <span className={`w-1.5 h-1.5 rounded-full ${STATE_META[runState].dot}`} />
                {STATE_META[runState].label}
              </span>
            </div>
            <div className="flex items-center gap-2">
              {RUN_STATES.map((s, i) => {
                const done = i <= stateIdx
                return (
                  <div key={s} className="flex items-center gap-2">
                    <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold transition-all
                      ${done ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-400'}`}>
                      {i < stateIdx ? '✓' : i + 1}
                    </div>
                    <span className={`text-xs capitalize hidden sm:block ${done ? 'text-gray-700 font-medium' : 'text-gray-400'}`}>
                      {STATE_META[s].label}
                    </span>
                    {i < RUN_STATES.length - 1 && (
                      <div className={`w-8 h-0.5 ${i < stateIdx ? 'bg-blue-600' : 'bg-gray-200'}`} />
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={handleExport} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 transition-colors">
              <Download className="w-4 h-4" /> Export
            </button>
            {nextAction && (
              <button onClick={handleAdvance} disabled={createRun.isPending || updateRun.isPending}
                className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium transition-colors disabled:opacity-60 ${nextAction.color}`}>
                <nextAction.icon className="w-4 h-4" />
                {nextAction.label}
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-4 mt-5 pt-5 border-t border-gray-100">
          <div>
            <p className="text-xs text-gray-500">Total Gross</p>
            <p className="text-lg font-bold text-gray-900 mt-0.5">{fmt(totalGross)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Total Deductions</p>
            <p className="text-lg font-bold text-red-500 mt-0.5">− {fmt(totalGross - totalNet)}</p>
          </div>
          <div>
            <p className="text-xs text-gray-500">Net Payout</p>
            <p className="text-lg font-bold text-green-600 mt-0.5">{fmt(totalNet)}</p>
          </div>
        </div>
      </div>

      {runState === 'draft' && (
        <div className="flex items-center gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
          <AlertCircle className="w-4 h-4 text-amber-500 shrink-0" />
          <p className="text-sm text-amber-700">Review salary structures before running payroll. Click <strong>Run Payroll</strong> to begin.</p>
        </div>
      )}

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900">Employee Breakdown</p>
          <span className="text-xs text-gray-400">{employees.length} employees</span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Employee</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Gross</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">PF</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">ESI</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">PT</th>
                <th className="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Net Pay</th>
              </tr>
            </thead>
            <tbody>
              {employees.length === 0 ? (
                <tr><td colSpan={6} className="text-center py-16 text-sm text-gray-400">No employees with salary data yet.</td></tr>
              ) : employees.map((emp) => (
                <tr key={emp.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                  <td className="px-5 py-3.5">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                        <span className="text-blue-700 text-xs font-semibold">{initials(emp.full_name)}</span>
                      </div>
                      <div>
                        <p className="text-sm font-medium text-gray-900">{emp.full_name}</p>
                        <p className="text-xs text-gray-400">{emp.designation}</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3.5 text-right text-sm text-gray-700">{fmt(emp.salary.gross)}</td>
                  <td className="px-4 py-3.5 text-right text-sm text-red-500">− {fmt(emp.salary.pf)}</td>
                  <td className="px-4 py-3.5 text-right text-sm text-red-500">{emp.salary.esi > 0 ? `− ${fmt(emp.salary.esi)}` : <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-3.5 text-right text-sm text-red-500">{emp.salary.pt > 0 ? `− ${fmt(emp.salary.pt)}` : <span className="text-gray-300">—</span>}</td>
                  <td className="px-4 py-3.5 text-right text-sm font-semibold text-green-600">{fmt(emp.salary.net)}</td>
                </tr>
              ))}
              {employees.length > 0 && (
                <tr className="bg-gray-50 font-semibold border-t border-gray-200">
                  <td className="px-5 py-3.5 text-sm text-gray-900">Total</td>
                  <td className="px-4 py-3.5 text-right text-sm text-gray-900">{fmt(totalGross)}</td>
                  <td className="px-4 py-3.5 text-right text-sm text-red-600">− {fmt(employees.reduce((s, e) => s + e.salary.pf, 0))}</td>
                  <td className="px-4 py-3.5 text-right text-sm text-red-600">− {fmt(employees.reduce((s, e) => s + e.salary.esi, 0))}</td>
                  <td className="px-4 py-3.5 text-right text-sm text-red-600">− {fmt(employees.reduce((s, e) => s + e.salary.pt, 0))}</td>
                  <td className="px-4 py-3.5 text-right text-sm text-green-700">{fmt(totalNet)}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* History */}
      {history.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100">
            <p className="text-base font-semibold text-gray-900">Payroll History</p>
          </div>
          <div className="divide-y divide-gray-50">
            {history.map((h) => {
              const meta = STATE_META[h.status]
              return (
                <div key={h.id} className="flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl bg-green-50 flex items-center justify-center">
                      <CheckCircle className="w-5 h-5 text-green-600" />
                    </div>
                    <div>
                      <p className="text-sm font-medium text-gray-900">{MONTH_NAMES[h.month]} {h.year}</p>
                      <p className="text-xs text-gray-400">{h.processed_at ? `Processed on ${new Date(h.processed_at).toLocaleDateString('en-IN')}` : '—'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <p className="text-sm font-semibold text-gray-900">{fmt(h.total_net)}</p>
                    <span className={`px-2.5 py-0.5 rounded-full text-xs font-medium ${meta.cls}`}>{meta.label}</span>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Salary Structure tab ─────────────────────────────────────────────────────
//
// Now features/payroll/SalaryStructures.jsx, reading the server. The table that
// was here showed an estimate — CTC ÷ 12 split by fixed percentages — as if it
// were each person's recorded salary.

// ─── Payslips tab ─────────────────────────────────────────────────────────────

function PayslipsTab({ employees }) {
  const { data: runs = [] }   = usePayrollRuns()
  const [selectedRunId, setSelectedRunId] = useState(null)
  const [payslipEmp, setPayslipEmp]       = useState(null)

  const runOptions = runs.filter((r) => r.status === 'paid' || r.status === 'approved')
  const activeRunId = selectedRunId || runOptions[0]?.id
  const { data: payslips = [] } = usePayslips(activeRunId)

  const activeRun = runs.find((r) => r.id === activeRunId)
  const runLabel  = activeRun ? `${MONTH_NAMES[activeRun.month]} ${activeRun.year}` : '—'

  // Merge payslips with employee data or fall back to employees list
  const displayList = payslips.length > 0
    ? payslips.map((p) => ({
        ...p.profiles,
        id: p.employee_id,
        salary: { net: p.net, gross: p.gross, basic: p.basic, hra: p.hra, da: p.da, special: p.special_allowance, pf: p.pf, esi: p.esi, pt: p.pt },
        payslipData: p,
      }))
    : employees.map((emp) => ({ ...emp, payslipData: null }))

  const handleDownloadAll = () => {
    const headers = ['Employee Name', 'Employee ID', 'Department', 'Designation', 'Bank Name', 'Account Number', 'IFSC Code', 'Gross Payout', 'PF Deduction', 'ESI Deduction', 'PT Deduction', 'Net Salary']
    const rows = displayList.map((e) => [
      e.full_name || '',
      e.employee_id || '',
      e.department || '',
      e.designation || '',
      e.bank_name || 'Bank Transfer',
      e.bank_account || '',
      e.ifsc || '',
      e.salary?.gross || 0,
      e.salary?.pf || 0,
      e.salary?.esi || 0,
      e.salary?.pt || 0,
      e.salary?.net || 0,
    ])
    const lines = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))]
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `payslips_summary_${runLabel.replace(/\s+/g, '_')}.csv`
    a.click()
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium text-gray-600">Select Month</label>
        <select value={activeRunId || ''} onChange={(e) => setSelectedRunId(e.target.value)}
          className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
          {runOptions.length === 0 && <option value="">No payroll runs yet</option>}
          {runOptions.map((r) => (
            <option key={r.id} value={r.id}>{MONTH_NAMES[r.month]} {r.year}</option>
          ))}
        </select>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between">
          <p className="text-base font-semibold text-gray-900">Payslips — {runLabel}</p>
          <button onClick={handleDownloadAll} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-sm font-medium text-gray-700 transition-colors">
            <Download className="w-4 h-4" /> Download All
          </button>
        </div>
        {displayList.length === 0 ? (
          <div className="text-center py-16 text-sm text-gray-400">No payslips yet. Run payroll first.</div>
        ) : (
          <div className="divide-y divide-gray-50">
            {displayList.map((emp) => (
              <div key={emp.id} className="flex items-center justify-between px-5 py-4 hover:bg-gray-50 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                    <span className="text-blue-700 text-sm font-semibold">{initials(emp.full_name)}</span>
                  </div>
                  <div>
                    <p className="text-sm font-medium text-gray-900">{emp.full_name}</p>
                    <p className="text-xs text-gray-400">{emp.employee_id} · {emp.department}</p>
                  </div>
                </div>
                <div className="flex items-center gap-6">
                  <div className="text-right hidden sm:block">
                    <p className="text-sm font-semibold text-green-600">{fmt(emp.salary?.net)}</p>
                    <p className="text-xs text-gray-400">Net pay</p>
                  </div>
                  <span className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-700">Generated</span>
                  <button onClick={() => setPayslipEmp(emp)}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 text-xs font-medium transition-colors">
                    <Eye className="w-3.5 h-3.5" /> View
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <PayslipModal
        open={!!payslipEmp}
        employee={payslipEmp}
        month={runLabel}
        onClose={() => setPayslipEmp(null)}
      />
    </div>
  )
}

// ─── Bank Accounts & Verification tab ────────────────────────────────────────

function BankAccountsTab({ employees }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [selectedProfile, setSelectedProfile] = useState(null)
  const [bankModalMode, setBankModalMode] = useState('review')

  const verifiedCount = employees.filter((e) => e.bank_verification_status === 'verified').length
  const pendingCount = employees.filter((e) => e.bank_verification_status === 'pending' || !e.bank_verification_status).length
  const rejectedCount = employees.filter((e) => e.bank_verification_status === 'rejected').length

  const filtered = employees.filter((emp) => {
    const q = search.toLowerCase()
    const matchesQuery = !q ||
      (emp.full_name || '').toLowerCase().includes(q) ||
      (emp.employee_id || '').toLowerCase().includes(q) ||
      (emp.department || '').toLowerCase().includes(q) ||
      (emp.bank_name || '').toLowerCase().includes(q)

    const empStatus = emp.bank_verification_status || 'pending'
    const matchesStatus = statusFilter === 'all' || empStatus === statusFilter
    return matchesQuery && matchesStatus
  })

  return (
    <div className="space-y-5">
      {/* Metrics Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
          <p className="text-xs text-gray-500 font-medium">Total Accounts</p>
          <p className="text-2xl font-bold text-gray-900 mt-1">{employees.length}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">Submitted for salary credit</p>
        </div>

        <div className="bg-emerald-50/60 rounded-xl border border-emerald-200 p-4 shadow-sm">
          <p className="text-xs text-emerald-800 font-medium flex items-center gap-1">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Verified Accounts
          </p>
          <p className="text-2xl font-bold text-emerald-900 mt-1">{verifiedCount}</p>
          <p className="text-[11px] text-emerald-700 mt-0.5">Ready for payroll credit</p>
        </div>

        <div className="bg-amber-50/60 rounded-xl border border-amber-200 p-4 shadow-sm">
          <p className="text-xs text-amber-800 font-medium flex items-center gap-1">
            <Clock className="w-3.5 h-3.5 text-amber-600" /> Pending Approvals
          </p>
          <p className="text-2xl font-bold text-amber-900 mt-1">{pendingCount}</p>
          <p className="text-[11px] text-amber-700 mt-0.5">Requires HR/Finance review</p>
        </div>

        <div className="bg-rose-50/60 rounded-xl border border-rose-200 p-4 shadow-sm">
          <p className="text-xs text-rose-800 font-medium flex items-center gap-1">
            <XCircle className="w-3.5 h-3.5 text-rose-600" /> Rejected Details
          </p>
          <p className="text-2xl font-bold text-rose-900 mt-1">{rejectedCount}</p>
          <p className="text-[11px] text-rose-700 mt-0.5">Resubmission pending</p>
        </div>
      </div>

      {/* Controls Bar */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex flex-col sm:flex-row gap-3 items-center justify-between">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search employee, ID, or bank..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-900 placeholder:text-gray-400"
          />
        </div>

        <div className="flex items-center gap-1.5 w-full sm:w-auto overflow-x-auto">
          {[
            { id: 'all', label: 'All' },
            { id: 'pending', label: `Pending (${pendingCount})` },
            { id: 'verified', label: `Verified (${verifiedCount})` },
            { id: 'rejected', label: `Rejected (${rejectedCount})` }
          ].map((f) => (
            <button
              key={f.id}
              onClick={() => setStatusFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold shrink-0 transition-colors ${
                statusFilter === f.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bank Accounts Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-5 py-3 text-left">Employee</th>
                <th className="px-4 py-3 text-left">Bank & Branch</th>
                <th className="px-4 py-3 text-left">Account Holder & Number</th>
                <th className="px-4 py-3 text-left">IFSC Code</th>
                <th className="px-4 py-3 text-left">Proof</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-center py-16 text-sm text-gray-400">
                    No bank account records found for this filter.
                  </td>
                </tr>
              ) : (
                filtered.map((emp) => {
                  const empStatus = emp.bank_verification_status || 'pending'
                  return (
                    <tr key={emp.id} className="hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="w-9 h-9 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                            <span className="text-blue-700 text-xs font-bold">{initials(emp.full_name)}</span>
                          </div>
                          <div>
                            <p className="text-sm font-semibold text-gray-900">{emp.full_name}</p>
                            <p className="text-xs text-gray-400">{emp.employee_id} · {emp.department}</p>
                          </div>
                        </div>
                      </td>

                      <td className="px-4 py-3.5 text-xs text-gray-700">
                        <p className="font-semibold text-gray-900">{emp.bank_name || 'N/A'}</p>
                        <p className="text-gray-400 mt-0.5">{emp.bank_branch || 'Main Branch'}</p>
                      </td>

                      <td className="px-4 py-3.5 text-xs">
                        <p className="font-mono font-bold text-gray-900">{emp.bank_account || '—'}</p>
                        <p className="text-gray-500 text-[11px] mt-0.5">{emp.bank_account_holder_name || emp.full_name} ({emp.bank_account_type || 'Savings'})</p>
                      </td>

                      <td className="px-4 py-3.5 text-xs font-mono font-semibold text-blue-700 uppercase">
                        {emp.ifsc || '—'}
                      </td>

                      <td className="px-4 py-3.5 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 text-slate-600 min-w-0">
                            <FileText className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                            <span className="font-mono text-[11px] truncate max-w-[120px]">{emp.bank_proof_name || 'cancelled_cheque.pdf'}</span>
                          </div>
                          <button
                            onClick={() => {
                              setSelectedProfile(emp)
                              setBankModalMode('review')
                            }}
                            className="px-2 py-1 rounded bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold text-[11px] flex items-center gap-1 border border-blue-200 transition-colors shrink-0"
                            title="View Proof Document"
                          >
                            <Eye className="w-3 h-3" /> View
                          </button>
                        </div>
                      </td>

                      <td className="px-4 py-3.5 text-center text-xs">
                        {empStatus === 'verified' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> Verified
                          </span>
                        )}
                        {empStatus === 'pending' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                            <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" /> Pending
                          </span>
                        )}
                        {empStatus === 'rejected' && (
                          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
                            <XCircle className="w-3.5 h-3.5 text-rose-600" /> Rejected
                          </span>
                        )}
                      </td>

                      <td className="px-4 py-3.5 text-right text-xs">
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => {
                              setSelectedProfile(emp)
                              setBankModalMode('review')
                            }}
                            className="px-2.5 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold transition-colors flex items-center gap-1"
                          >
                            <ShieldCheck className="w-3.5 h-3.5" />
                            {empStatus === 'pending' ? 'Verify' : 'Review'}
                          </button>

                          <button
                            onClick={() => {
                              setSelectedProfile(emp)
                              setBankModalMode('edit')
                            }}
                            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                            title="Edit bank details"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      <BankVerificationModal
        open={!!selectedProfile}
        onClose={() => setSelectedProfile(null)}
        profile={selectedProfile}
        mode={bankModalMode}
      />
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

const TABS = ['runs', 'structure', 'payslips', 'bank_accounts']
const TAB_LABELS = {
  runs: 'Payroll Runs',
  structure: 'Salary Structure',
  payslips: 'Payslips',
  bank_accounts: 'Bank Accounts & Verification'
}

export default function Payroll() {
  const [tab, setTab] = useState('runs')
  const { data: rawEmployees = [] } = useEmployees()
  const { data: salaryStructures = [] } = useSalaryStructures()

  const employees = useMemo(() =>
    rawEmployees.map((e) => {
      const ss = salaryStructures.find((s) => s.employee_id === e.id || s.profiles?.id === e.id)
      const computed = estimateSalary(Number(e.ctc || ss?.ctc) || 0)
      if (ss) {
        return {
          ...e,
          ctc: e.ctc || ss.ctc,
          salary: {
            gross: ss.gross ?? computed.gross,
            basic: ss.basic ?? computed.basic,
            hra: ss.hra ?? computed.hra,
            da: ss.da ?? computed.da,
            special: ss.special_allowance ?? computed.special,
            pf: ss.pf ?? computed.pf,
            esi: ss.esi ?? computed.esi,
            pt: ss.pt ?? computed.pt,
            net: ss.net_salary ?? computed.net
          }
        }
      }
      return { ...e, salary: computed }
    }),
    [rawEmployees, salaryStructures]
  )

  const totalMonthly = employees.reduce((s, e) => s + e.salary.gross, 0)
  const totalNet     = employees.reduce((s, e) => s + e.salary.net, 0)
  const avgSalary    = employees.length ? Math.round(totalNet / employees.length) : 0

  return (
    <div className="space-y-5">

      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Payroll</h2>
          <p className="text-sm text-gray-500 mt-0.5">{MONTH_NAMES[CUR_MONTH]} {CUR_YEAR} · {employees.length} active employees</p>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Monthly Gross',   value: fmt(totalMonthly), icon: IndianRupee, bg: 'bg-blue-100',   ic: 'text-blue-600',   sub: 'Total payroll' },
          { label: 'Monthly Net Pay', value: fmt(totalNet),     icon: TrendingUp,  bg: 'bg-green-100',  ic: 'text-green-600',  sub: 'After deductions' },
          { label: 'Avg Net Salary',  value: fmt(avgSalary),    icon: Users,       bg: 'bg-purple-100', ic: 'text-purple-600', sub: 'Per employee' },
          { label: 'Payroll Status',  value: 'Draft',           icon: Clock,       bg: 'bg-amber-100',  ic: 'text-amber-600',  sub: `${MONTH_NAMES[CUR_MONTH]} ${CUR_YEAR}` },
        ].map(({ label, value, icon, bg, ic, sub }) => (
          <div key={label} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
            <div className={`${bg} rounded-xl p-3 shrink-0`}>{createElement(icon, { className: `w-6 h-6 ${ic}` })}</div>
            <div>
              <p className="text-xl font-bold text-gray-900">{value}</p>
              <p className="text-sm text-gray-500">{label}</p>
              <p className="text-xs text-gray-400 mt-0.5">{sub}</p>
            </div>
          </div>
        ))}
      </div>

      <div className="flex items-center gap-1 border-b border-gray-200">
        {TABS.map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
              ${tab === t ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}>
            {TAB_LABELS[t]}
          </button>
        ))}
      </div>

      {tab === 'runs'          && <RunsTab employees={employees} />}
      {tab === 'structure'     && <SalaryStructures />}
      {tab === 'payslips'      && <PayslipsTab employees={employees} />}
      {tab === 'bank_accounts' && <BankAccountsTab employees={employees} />}
    </div>
  )
}
