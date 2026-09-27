import { useState } from 'react'
import { useReportsData } from '../hooks/useReports'
import {
  BarChart2, Users, Clock, CalendarDays, Wallet,
  Download, FileText, ChevronRight, X, Search,
  TrendingUp, TrendingDown, Filter,
} from 'lucide-react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, PieChart, Pie, Cell,
} from 'recharts'

// Report definitions ───────────────────────────────────────────────────────

const REPORTS = [
  {
    id: 'attendance_monthly',
    category: 'attendance',
    title: 'Monthly Attendance Summary',
    desc: 'Present, absent, late, WFH count per employee for the month.',
    icon: Clock,
    color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200',
  },
  {
    id: 'attendance_dept',
    category: 'attendance',
    title: 'Department Attendance',
    desc: 'Attendance percentage grouped by department.',
    icon: BarChart2,
    color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200',
  },
  {
    id: 'leave_summary',
    category: 'leave',
    title: 'Leave Summary Report',
    desc: 'Total leave taken per employee broken down by leave type.',
    icon: CalendarDays,
    color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-200',
  },
  {
    id: 'leave_balance',
    category: 'leave',
    title: 'Leave Balance Report',
    desc: 'Remaining leave balance per employee for the current FY.',
    icon: CalendarDays,
    color: 'text-purple-600', bg: 'bg-purple-50', border: 'border-purple-200',
  },
  {
    id: 'payroll_monthly',
    category: 'payroll',
    title: 'Monthly Payroll Report',
    desc: 'Gross, deductions (PF/ESI/PT), and net pay per employee.',
    icon: Wallet,
    color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200',
  },
  {
    id: 'payroll_pf',
    category: 'payroll',
    title: 'PF / ESI Contribution',
    desc: 'Statutory deductions summary for PF and ESI compliance.',
    icon: Wallet,
    color: 'text-green-600', bg: 'bg-green-50', border: 'border-green-200',
  },
  {
    id: 'employee_headcount',
    category: 'employee',
    title: 'Headcount Report',
    desc: 'Total employees by department, designation, and employment type.',
    icon: Users,
    color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200',
  },
  {
    id: 'employee_joiners',
    category: 'employee',
    title: 'Joiners & Exits',
    desc: 'New hires and exits for the selected month.',
    icon: TrendingUp,
    color: 'text-orange-600', bg: 'bg-orange-50', border: 'border-orange-200',
  },
]

const CATEGORY_META = {
  attendance: { label: 'Attendance',  color: 'text-blue-600',   bg: 'bg-blue-600' },
  leave:      { label: 'Leave',       color: 'text-purple-600', bg: 'bg-purple-600' },
  payroll:    { label: 'Payroll',     color: 'text-green-600',  bg: 'bg-green-600' },
  employee:   { label: 'Employee',    color: 'text-orange-600', bg: 'bg-orange-600' },
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

// Null is "not on record", shown as a dash rather than ₹0.
function fmt(n) { return n === null || n === undefined ? '—' : '₹' + Number(n).toLocaleString('en-IN') }
const sum = (rows, key) => rows.reduce((s, r) => s + (r[key] ?? 0), 0)

function exportCSV(filename, headers, rows) {
  const lines = [headers.join(','), ...rows.map((r) => r.map((v) => `"${v}"`).join(','))]
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
}

function pctBar(val, max = 100) {
  const pct = Math.min(100, Math.round(val / max * 100))
  const color = pct >= 90 ? 'bg-green-500' : pct >= 75 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium text-gray-700 w-8 text-right">{val}%</span>
    </div>
  )
}

// ─── Report Preview Panel ─────────────────────────────────────────────────────

function ReportPanel({ report, onClose }) {
  const [search, setSearch] = useState('')
  const [month, setMonth] = useState('March 2026')
  const [selectedDept, setSelectedDept] = useState('all')
  const [selectedEmpId, setSelectedEmpId] = useState('all')
  const { data, isLoading } = useReportsData(month, selectedDept, selectedEmpId)

  if (!report) return null

  const monthOptions = ['March 2026', 'February 2026', 'January 2026', 'December 2025', 'November 2025', 'October 2025']

  function filterBySearch(items) {
    if (!search.trim()) return items || []
    const q = search.toLowerCase().trim()
    return (items || []).filter((r) => {
      const name = (r.name || '').toLowerCase()
      const id = (r.id || '').toLowerCase()
      const dept = (r.dept || '').toLowerCase()
      return name.includes(q) || id.includes(q) || dept.includes(q)
    })
  }

  function handlePrint() {
    window.print()
  }

  function renderContent() {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center h-64">
          <div className="w-8 h-8 border-4 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      )
    }

    if (!data) return <p className="text-sm text-gray-400 p-4">No data available.</p>

    switch (report.id) {

      case 'attendance_monthly': {
        const rows = filterBySearch(data.attendanceSummary || [])
        if (rows.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }
        return (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Employee', 'Dept', 'Present', 'Absent', 'Late', 'WFH', 'Attendance %'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rawId || r.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{r.name}</p>
                        <p className="text-xs text-gray-400 font-mono">{r.id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.dept}</td>
                      <td className="px-4 py-3 text-sm font-medium text-green-600">{r.present}</td>
                      <td className="px-4 py-3 text-sm font-medium text-red-500">{r.absent}</td>
                      <td className="px-4 py-3 text-sm font-medium text-amber-600">{r.late}</td>
                      <td className="px-4 py-3 text-sm font-medium text-blue-600">{r.wfh}</td>
                      <td className="px-4 py-3 w-36">{pctBar(r.pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Showing {rows.length} employee records</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV(`attendance_${month.toLowerCase().replace(' ', '_')}.csv`,
                  ['Name', 'ID', 'Department', 'Present', 'Absent', 'Late', 'WFH', 'Attendance %'],
                  rows.map((r) => [r.name, r.id, r.dept, r.present, r.absent, r.late, r.wfh, r.pct + '%'])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      case 'attendance_dept': {
        const deptMap = {}
        ;(data.attendanceSummary || []).forEach((r) => {
          if (!deptMap[r.dept]) deptMap[r.dept] = { dept: r.dept, present: 0, absent: 0, late: 0, wfh: 0, total: 0, count: 0 }
          deptMap[r.dept].present += r.present
          deptMap[r.dept].absent  += r.absent
          deptMap[r.dept].late    += r.late
          deptMap[r.dept].wfh     += r.wfh
          deptMap[r.dept].total   += (r.present + r.wfh + r.late + r.absent)
          deptMap[r.dept].count++
        })
        let rows = Object.values(deptMap).map((d) => ({
          ...d,
          pct: d.total > 0 ? Math.round((d.present + d.wfh + d.late) / d.total * 100) : 100,
        }))
        if (search.trim()) {
          const q = search.toLowerCase().trim()
          rows = rows.filter(r => r.dept.toLowerCase().includes(q))
        }

        if (rows.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }

        return (
          <>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={rows} barSize={28}>
                <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                <XAxis dataKey="dept" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} domain={[0, 100]} unit="%" />
                <Tooltip formatter={(v) => [`${v}%`, 'Attendance']} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E2E8F0' }} />
                <Bar dataKey="pct" name="Attendance %" fill="#2563EB" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
            <div className="overflow-x-auto mt-2">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Department', 'Employees', 'Present Days', 'Absent Days', 'Late Days', 'Avg Attendance'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.dept} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{r.dept}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.count}</td>
                      <td className="px-4 py-3 text-sm text-green-600 font-medium">{r.present}</td>
                      <td className="px-4 py-3 text-sm text-red-500 font-medium">{r.absent}</td>
                      <td className="px-4 py-3 text-sm text-amber-600 font-medium">{r.late}</td>
                      <td className="px-4 py-3 w-32">{pctBar(r.pct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Showing {rows.length} departments</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV(`dept_attendance_${month.toLowerCase().replace(' ', '_')}.csv`,
                  ['Department', 'Employees', 'Present', 'Absent', 'Late', 'Attendance %'],
                  rows.map((r) => [r.dept, r.count, r.present, r.absent, r.late, r.pct + '%'])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      case 'leave_summary': {
        const rows = filterBySearch(data.leaveSummary || [])
        if (rows.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }
        return (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Employee', 'Department', 'Casual', 'Sick', 'Earned', 'WFH', 'Total Days'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rawId || r.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{r.name}</p>
                        <p className="text-xs text-gray-400 font-mono">{r.id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.dept}</td>
                      <td className="px-4 py-3 text-sm text-blue-600 font-medium">{r.casual}</td>
                      <td className="px-4 py-3 text-sm text-red-500 font-medium">{r.sick}</td>
                      <td className="px-4 py-3 text-sm text-purple-600 font-medium">{r.earned}</td>
                      <td className="px-4 py-3 text-sm text-teal-600 font-medium">{r.wfh}</td>
                      <td className="px-4 py-3 text-sm font-bold text-gray-900">{r.total}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Showing {rows.length} employee records</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV(`leave_summary_${month.toLowerCase().replace(' ', '_')}.csv`,
                  ['Name', 'ID', 'Department', 'Casual', 'Sick', 'Earned', 'WFH', 'Total'],
                  rows.map((r) => [r.name, r.id, r.dept, r.casual, r.sick, r.earned, r.wfh, r.total])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      case 'leave_balance': {
        const rows = filterBySearch(data.leaveBalancesReport || [])
        if (rows.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }
        return (
          <>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[600px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Employee', 'Department', 'Casual Bal', 'Sick Bal', 'Earned Bal', 'WFH Bal'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rawId || r.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{r.name}</p>
                        <p className="text-xs text-gray-400 font-mono">{r.id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.dept}</td>
                      {[['casual_bal', 12], ['sick_bal', 12], ['earned_bal', 18], ['wfh_bal', 24]].map(([k, max]) => (
                        <td key={k} className="px-4 py-3">
                          <div className="space-y-1">
                            <span className="text-sm font-semibold text-gray-900">{r[k]} <span className="text-xs text-gray-400 font-normal">/ {max}</span></span>
                            <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-blue-500 rounded-full" style={{ width: `${Math.round(Math.min(100, Math.max(0, r[k] / max * 100)))}%` }} />
                            </div>
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Showing {rows.length} employee records</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV(`leave_balance_${month.toLowerCase().replace(' ', '_')}.csv`,
                  ['Name', 'ID', 'Department', 'Casual Bal', 'Sick Bal', 'Earned Bal', 'WFH Bal'],
                  rows.map((r) => [r.name, r.id, r.dept, r.casual_bal, r.sick_bal, r.earned_bal, r.wfh_bal])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      case 'payroll_monthly': {
        const rows = filterBySearch(data.payrollSummary || [])
        const totGross = sum(rows, 'gross')
        const totNet   = sum(rows, 'net')

        if (rows.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }

        return (
          <>
            {/* Trend chart */}
            <div className="mb-4">
              <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider px-1 mb-2">6-Month Net Payout Trend (₹ lakhs)</p>
              <ResponsiveContainer width="100%" height={140}>
                <BarChart data={data.payrollTrend || []} barSize={24}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#F1F5F9" vertical={false} />
                  <XAxis dataKey="month" tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 11, fill: '#94A3B8' }} axisLine={false} tickLine={false} unit="L" />
                  <Tooltip formatter={(v) => [v === null || v === undefined ? 'No payroll run' : `₹${v}L`, 'Payout']} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E2E8F0' }} />
                  <Bar dataKey="amount" fill="#16A34A" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[650px]">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Employee', 'Department', 'Gross', 'PF', 'ESI', 'PT', 'Net Pay'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rawId || r.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{r.name}</p>
                        <p className="text-xs text-gray-400 font-mono">{r.id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{r.dept}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{fmt(r.gross)}</td>
                      <td className="px-4 py-3 text-sm text-red-500">{r.pf ? `−${fmt(r.pf)}` : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 text-sm text-red-500">{r.esi > 0 ? `−${fmt(r.esi)}` : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 text-sm text-red-500">{r.pt ? `−${fmt(r.pt)}` : <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-3 text-sm font-bold text-green-600">{fmt(r.net)}</td>
                    </tr>
                  ))}
                  <tr className="bg-gray-50 border-t-2 border-gray-200 font-semibold">
                    <td colSpan={2} className="px-4 py-3 text-sm text-gray-900">Total ({rows.length})</td>
                    <td className="px-4 py-3 text-sm text-gray-900">{fmt(totGross)}</td>
                    <td colSpan={3} />
                    <td className="px-4 py-3 text-sm text-green-700">{fmt(totNet)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Showing {rows.length} employee records</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV(`payroll_${month.toLowerCase().replace(' ', '_')}.csv`,
                  ['Name', 'ID', 'Department', 'Gross', 'PF', 'ESI', 'PT', 'Net'],
                  rows.map((r) => [r.name, r.id, r.dept, r.gross ?? '', r.pf ?? '', r.esi ?? '', r.pt ?? '', r.net ?? ''])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      case 'payroll_pf': {
        const rows = filterBySearch(data.payrollSummary || [])
        const totPF  = sum(rows, 'pf')
        const totESI = sum(rows, 'esi')

        if (rows.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }

        return (
          <>
            <div className="grid grid-cols-2 gap-4 mb-4">
              {[
                // Rates and the employer's share are on each payslip, from the
                // company's own settings — not restated here as fixed numbers.
                { label: 'Total Employee PF', value: fmt(totPF),  sub: 'As recorded' },
                { label: 'Total Employee ESI', value: fmt(totESI), sub: 'As recorded' },
              ].map((c) => (
                <div key={c.label} className="bg-gray-50 rounded-xl p-4 border border-gray-200">
                  <p className="text-xl font-bold text-gray-900">{c.value}</p>
                  <p className="text-sm text-gray-500 mt-0.5">{c.label}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{c.sub}</p>
                </div>
              ))}
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Employee', 'UAN', 'Basic Salary', 'Employee PF', 'Employee ESI'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.rawId || r.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{r.name}</p>
                        <p className="text-xs text-gray-400 font-mono">{r.id}</p>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500 font-mono">{r.uan ?? '—'}</td>
                      <td className="px-4 py-3 text-sm text-gray-700">{fmt(r.basic)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-blue-600">{fmt(r.pf)}</td>
                      <td className="px-4 py-3 text-sm font-medium text-purple-600">{r.esi > 0 ? fmt(r.esi) : <span className="text-gray-300">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Showing {rows.length} employee records</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV(`pf_esi_${month.toLowerCase().replace(' ', '_')}.csv`,
                  ['Name', 'ID', 'UAN', 'Basic', 'Employee PF', 'Employee ESI'],
                  rows.map((r) => [r.name, r.id, r.uan ?? '', r.basic ?? '', r.pf ?? '', r.esi ?? ''])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      case 'employee_headcount': {
        const headcountData = filterBySearch(data.headcountByDept || [])
        const total = headcountData.reduce((s, d) => s + d.value, 0)

        if (headcountData.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }

        return (
          <>
            <div className="grid grid-cols-2 gap-6 mb-4">
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={headcountData} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={3} dataKey="value" strokeWidth={0}>
                    {headcountData.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip formatter={(v, n) => [`${v} employees`, n]} contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #E2E8F0' }} />
                </PieChart>
              </ResponsiveContainer>
              <div className="space-y-2 self-center">
                {headcountData.map((d) => (
                  <div key={d.name} className="flex items-center justify-between text-sm">
                    <div className="flex items-center gap-2">
                      <span className="w-3 h-3 rounded-full shrink-0" style={{ background: d.color }} />
                      <span className="text-gray-600">{d.name}</span>
                    </div>
                    <div className="flex gap-3">
                      <span className="font-semibold text-gray-900">{d.value}</span>
                      <span className="text-gray-400 w-8">{total > 0 ? Math.round(d.value / total * 100) : 0}%</span>
                    </div>
                  </div>
                ))}
                <div className="pt-2 border-t border-gray-100 flex justify-between text-sm font-bold">
                  <span className="text-gray-900">Total</span>
                  <span className="text-blue-600">{total}</span>
                </div>
              </div>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Total Active Employees: {total}</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV('headcount_report.csv',
                  ['Department', 'Count', 'Percentage'],
                  headcountData.map((d) => [d.name, d.value, (total > 0 ? Math.round(d.value / total * 100) : 0) + '%'])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      case 'employee_joiners': {
        const joiners = filterBySearch(data.joinersExits || [])
        const joinersCount = joiners.filter(j => j.type === 'joiner').length
        const exitsCount = joiners.filter(j => j.type === 'exit').length
        const netGrowth = joinersCount - exitsCount

        if (joiners.length === 0) {
          return (
            <div className="flex flex-col items-center justify-center py-16 text-gray-400 text-sm">
              <Search className="w-8 h-8 mb-2 text-gray-300" />
              <p>No data available for the selected filters.</p>
            </div>
          )
        }

        return (
          <>
            <div className="flex gap-4 mb-4">
              <div className="flex-1 bg-green-50 border border-green-200 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-green-600">{joinersCount}</p>
                <p className="text-sm text-green-700 mt-0.5">New Joiners</p>
              </div>
              <div className="flex-1 bg-red-50 border border-red-200 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-red-500">{exitsCount}</p>
                <p className="text-sm text-red-600 mt-0.5">Exits</p>
              </div>
              <div className="flex-1 bg-blue-50 border border-blue-200 rounded-xl p-4 text-center">
                <p className="text-2xl font-bold text-blue-600">{netGrowth >= 0 ? `+${netGrowth}` : netGrowth}</p>
                <p className="text-sm text-blue-700 mt-0.5">Net Growth</p>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    {['Employee', 'Department', 'Designation', 'Date', 'Type'].map((h) => (
                      <th key={h} className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {joiners.map((j) => (
                    <tr key={j.rawId || j.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-3">
                        <p className="text-sm font-medium text-gray-900">{j.name}</p>
                        <p className="text-xs text-gray-400 font-mono">{j.id}</p>
                      </td>
                      <td className="px-4 py-3 text-sm text-gray-600">{j.dept}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{j.role}</td>
                      <td className="px-4 py-3 text-sm text-gray-600">{j.date}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium
                          ${j.type === 'joiner' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                          {j.type === 'joiner' ? 'New Joiner' : 'Exit'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="px-4 py-3 border-t border-gray-100 flex items-center justify-between gap-3">
              <p className="text-xs text-gray-400">Showing {joiners.length} records</p>
              <div className="flex items-center gap-2">
                <button onClick={handlePrint} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-xs font-medium transition-colors">
                  <FileText className="w-3.5 h-3.5" /> Print / PDF
                </button>
                <button onClick={() => exportCSV(`joiners_exits_${month.toLowerCase().replace(' ', '_')}.csv`,
                  ['Name', 'ID', 'Department', 'Designation', 'Date', 'Type'],
                  joiners.map((j) => [j.name, j.id, j.dept, j.role, j.date, j.type])
                )} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-xs font-medium transition-colors">
                  <Download className="w-3.5 h-3.5" /> Export CSV
                </button>
              </div>
            </div>
          </>
        )
      }

      default:
        return <p className="text-sm text-gray-400 p-4">Report not available.</p>
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />
      <div className="fixed right-0 top-0 h-full w-full max-w-3xl bg-white shadow-2xl z-50 flex flex-col">

        {/* Panel header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3">
            <div className={`w-9 h-9 rounded-xl ${report.bg} ${report.border} border flex items-center justify-center shrink-0`}>
              <report.icon className={`w-5 h-5 ${report.color}`} />
            </div>
            <div>
              <p className="text-base font-semibold text-gray-900">{report.title}</p>
              <p className="text-xs text-gray-400">{month} · Filters applied</p>
            </div>
          </div>
          <button onClick={onClose} className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Filters bar */}
        <div className="flex items-center gap-3 px-6 py-3 border-b border-gray-100 shrink-0 flex-wrap bg-gray-50/50">
          <div className="flex items-center gap-1.5">
            <Filter className="w-3.5 h-3.5 text-gray-400" />
            <select value={month} onChange={(e) => setMonth(e.target.value)}
              className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              {monthOptions.map((m) => <option key={m}>{m}</option>)}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <select value={selectedDept} onChange={(e) => setSelectedDept(e.target.value)}
              className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
              <option value="all">All Departments</option>
              {(data?.departments || ['Engineering', 'HR', 'Finance', 'Operations']).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5">
            <select value={selectedEmpId} onChange={(e) => setSelectedEmpId(e.target.value)}
              className="border border-gray-300 rounded-lg px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white max-w-44 truncate">
              <option value="all">All Employees</option>
              {(data?.allEmployees || []).map((emp) => (
                <option key={emp.id} value={emp.id}>{emp.name}</option>
              ))}
            </select>
          </div>

          <div className="relative flex-1 min-w-36">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-gray-400" />
            <input type="text" placeholder="Search name, ID, dept…" value={search} onChange={(e) => setSearch(e.target.value)}
              className="w-full pl-8 pr-3 py-1.5 border border-gray-300 rounded-lg text-xs
                focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400 bg-white" />
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {renderContent()}
        </div>
      </div>
    </>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────

const CATEGORIES = ['attendance', 'leave', 'payroll', 'employee']

export default function Reports() {
  const [activeReport, setActiveReport] = useState(null)

  return (
    <>
      <div className="space-y-6">

        {/* Header */}
        <div>
          <h2 className="text-2xl font-bold text-gray-900">Reports</h2>
          <p className="text-sm text-gray-500 mt-0.5">Generate and export reports across all modules</p>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[
            { label: 'Attendance Reports', count: 2, icon: Clock,        bg: 'bg-blue-100',   ic: 'text-blue-600' },
            { label: 'Leave Reports',       count: 2, icon: CalendarDays, bg: 'bg-purple-100', ic: 'text-purple-600' },
            { label: 'Payroll Reports',     count: 2, icon: Wallet,       bg: 'bg-green-100',  ic: 'text-green-600' },
            { label: 'Employee Reports',    count: 2, icon: Users,        bg: 'bg-orange-100', ic: 'text-orange-600' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex items-center gap-4">
              <div className={`${s.bg} rounded-xl p-3 shrink-0`}>
                <s.icon className={`w-5 h-5 ${s.ic}`} />
              </div>
              <div>
                <p className="text-xl font-bold text-gray-900">{s.count}</p>
                <p className="text-sm text-gray-500">{s.label}</p>
              </div>
            </div>
          ))}
        </div>

        {/* Report cards by category */}
        {CATEGORIES.map((cat) => {
          const meta = CATEGORY_META[cat]
          const catReports = REPORTS.filter((r) => r.category === cat)
          return (
            <div key={cat}>
              <div className="flex items-center gap-2 mb-3">
                <div className={`w-1 h-5 rounded-full ${meta.bg}`} />
                <p className={`text-sm font-semibold uppercase tracking-wider ${meta.color}`}>{meta.label} Reports</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {catReports.map((report) => (
                  <div key={report.id}
                    className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 hover:border-blue-300 hover:shadow-md transition-all group">
                    <div className="flex items-start gap-4">
                      <div className={`w-10 h-10 rounded-xl ${report.bg} border ${report.border} flex items-center justify-center shrink-0`}>
                        <report.icon className={`w-5 h-5 ${report.color}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-900">{report.title}</p>
                        <p className="text-xs text-gray-500 mt-1 leading-relaxed">{report.desc}</p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 mt-4 pt-4 border-t border-gray-100">
                      <button onClick={() => setActiveReport(report)}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 text-xs font-medium transition-colors">
                        <FileText className="w-3.5 h-3.5" /> Preview & Export
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {activeReport && (
        <ReportPanel report={activeReport} onClose={() => setActiveReport(null)} />
      )}
    </>
  )
}
