import { btn, card, fieldSm, th } from '../components/ui/styles'
import PageHeader from '../components/ui/PageHeader'
import { useMemo, useState } from 'react'
import {
  BarChart2, Users, Clock, CalendarDays, Wallet, Download, FileText, X, Filter, TrendingUp, Loader2, Info,
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
import { useReport, downloadReport } from '../hooks/useReports'
import { useMasterData, useEmployees } from '../hooks/useEmployees'
import { useAuthStore } from '../stores/authStore'
import { useDownload } from '../hooks/useDownload'
import { useEscape } from '../hooks/useEscape'
import { calendarDayIn } from '../lib/dates'
import { money, days, formatDay, monthLabel, recentMonths, monthValue, parseMonthValue } from '../features/payroll/format'
import DataState from '../components/DataState'
import { optionsNote } from '../lib/optionsNote'

/**
 * Reports. Every figure is the server's (GET /api/reports/:id), counted from
 * the records for any month — and the CSV is made there from the same rows.
 */

const REPORTS = [
  { id: 'attendance-summary', category: 'attendance', title: 'Monthly Attendance Summary', desc: 'Present, half days, absent, leave, and the working days nobody marked — per employee.', icon: Clock, filters: ['department', 'employee'] },
  { id: 'attendance-by-department', category: 'attendance', title: 'Department Attendance', desc: 'The same month, added up by department.', icon: BarChart2, filters: [] },
  { id: 'shift-overtime', category: 'attendance', title: 'Late, Early & Overtime', desc: 'Days late and leaving early past each shift’s grace, overtime worked, and how much was claimed and approved.', icon: Clock, filters: ['department', 'employee'] },
  { id: 'requests', category: 'attendance', title: 'Requests', desc: 'Every request sent in the month — corrections, work from home, overtime, encashment, profile changes — and what became of it.', icon: BarChart2, filters: ['department', 'employee'] },
  { id: 'leave-taken', category: 'leave', title: 'Leave Taken', desc: 'Approved leave inside the month, per employee and leave type.', icon: CalendarDays, filters: ['department', 'employee'] },
  { id: 'leave-balances', category: 'leave', title: 'Leave Balances', desc: 'What the leave ledger holds for the leave year, per employee.', icon: CalendarDays, filters: ['department', 'employee'] },
  { id: 'payroll-summary', category: 'payroll', title: 'Monthly Payroll', desc: 'Gross, each deduction and net pay per employee, from the month’s payroll run.', icon: Wallet, filters: ['department', 'employee'] },
  { id: 'pf-esi', category: 'payroll', title: 'PF / ESI Contributions', desc: 'PF wages, employee and employer PF, EPS and ESI, with each UAN.', icon: Wallet, filters: ['department', 'employee'] },
  { id: 'headcount', category: 'employee', title: 'Headcount', desc: 'Everybody employed at the end of the month, by department and type.', icon: Users, filters: ['department'] },
  { id: 'joiners-exits', category: 'employee', title: 'Joiners & Exits', desc: 'Who joined and who left in the month, with the dates.', icon: TrendingUp, filters: ['department'] },
]

/** The right each kind of report needs (client §46) — the server checks it too, and shows only the caller's reach. */
const CATEGORY_PERMISSION = { attendance: 'attendance:read', leave: 'leave:read', payroll: 'payroll:structure:read', employee: 'employee:read' }

/** Each kind of report in one of the logo's colours — its icon, its chart. */
const CATEGORY_META = {
  attendance: { label: 'Attendance', hex: '#8B2FE6', icon: Clock },
  leave: { label: 'Leave', hex: '#F2479A', icon: CalendarDays },
  payroll: { label: 'Payroll', hex: '#FF8A3D', icon: Wallet },
  employee: { label: 'Employee', hex: '#3BB8F5', icon: Users },
}

/** A soft square of the category's colour behind its icon. */
const tint = (hex, strength = '1A') => ({ background: `${hex}${strength}`, color: hex })

const PIE_COLORS = ['#8B2FE6', '#F2479A', '#3BB8F5', '#FF8A3D', '#0E9F6E', '#5B7CF0', '#F59E0B']

/** A cell as its column's type says. Null is "nothing recorded", a dash. */
function show(value, type) {
  if (value === null || value === undefined || value === '') return '—'
  switch (type) {
    case 'money': return money(value)
    case 'days': return days(value)
    case 'hours': return `${Number(value).toLocaleString('en-IN')} h`
    case 'percent': return `${value}%`
    case 'date': return formatDay(value)
    case 'number': return Number(value).toLocaleString('en-IN')
    default: return String(value)
  }
}

const numeric = (type) => ['money', 'days', 'hours', 'percent', 'number'].includes(type)

function ReportPanel({ report, onClose }) {
  useEscape(onClose)
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const today = calendarDayIn(timezone)
  const months = useMemo(() => recentMonths(today, 24), [today])
  const [monthKey, setMonthKey] = useState(() => monthValue(months[0]))
  const [departmentId, setDepartmentId] = useState('')
  const [employeeId, setEmployeeId] = useState('')
  const masterQuery = useMasterData()
  const employeesQuery = useEmployees()
  const { busy, start } = useDownload()

  const { year, month } = parseMonthValue(monthKey)
  const filters = {
    year,
    month,
    departmentId: report.filters.includes('department') ? departmentId || undefined : undefined,
    employeeId: report.filters.includes('employee') ? employeeId || undefined : undefined,
  }
  const reportQuery = useReport(report.id, filters)
  // Print and CSV only for a report that is on the screen — not one whose refresh failed.
  const shown = reportQuery.isError ? undefined : reportQuery.data
  const meta = CATEGORY_META[report.category]

  return (
    <>
      <div className="fixed inset-0 bg-gray-950/45 backdrop-blur-[2px] z-40 no-print" onClick={onClose} />
      <div className="print-area fixed right-0 top-0 h-full w-full max-w-4xl bg-white shadow-2xl z-50 flex flex-col" role="dialog" aria-modal="true" aria-label={report.title}>
        <div className="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-gray-100 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 rounded-[11px] grid place-items-center shrink-0" style={tint(meta.hex, '14')}>
              <report.icon className="w-5 h-5" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <p className="text-base font-bold text-gray-900 truncate">{report.title}</p>
              <p className="text-xs text-gray-500">{shown?.period ?? monthLabel(year, month)}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="no-print p-2 rounded-lg hover:bg-gray-100 text-gray-400"><X className="w-4 h-4" /></button>
        </div>

        <div className="no-print flex flex-wrap items-center gap-2.5 px-4 sm:px-6 py-3 border-b border-gray-100 bg-gray-50/60 shrink-0">
          <Filter className="w-3.5 h-3.5 text-gray-400" />
          <select value={monthKey} onChange={(e) => setMonthKey(e.target.value)} aria-label="Month"
            className={fieldSm}>
            {months.map((m) => <option key={monthValue(m)} value={monthValue(m)}>{monthLabel(m.year, m.month)}</option>)}
          </select>
          {report.filters.includes('department') && (
            <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} aria-label="Department"
              className={fieldSm}>
              <option value="">{optionsNote(masterQuery, 'All departments')}</option>
              {(masterQuery.data?.departments ?? []).filter((d) => !d.archived).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          {report.filters.includes('employee') && (
            <select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} aria-label="Employee"
              className={`${fieldSm} max-w-48`}>
              <option value="">{optionsNote(employeesQuery, 'All employees')}</option>
              {(employeesQuery.data ?? []).map((e) => <option key={e.id} value={e.id}>{e.full_name} ({e.employee_id})</option>)}
            </select>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button onClick={() => window.print()} disabled={!shown}
              className={btn.secondarySm}>
              <FileText className="w-3.5 h-3.5" /> Print / PDF
            </button>
            <button onClick={() => start('csv', () => downloadReport(report.id, filters))} disabled={!shown || busy === 'csv'}
              className={btn.primarySm}>
              {busy === 'csv' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Export CSV
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-6 py-4 space-y-4">
          <DataState query={reportQuery}>
            {(data) => (
              <>
                {data.notes.length > 0 && (
                  <div className="space-y-1">
                    {data.notes.map((n) => (
                      <p key={n} className="flex gap-2 text-xs text-gray-600"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-gray-400" /> {n}</p>
                    ))}
                  </div>
                )}

                {data.chart && data.chart.points.length > 0 && (
                  <div>
                    <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-2">{data.chart.label}</p>
                    <ResponsiveContainer width="100%" height={data.chart.kind === 'pie' ? 220 : 170}>
                      {data.chart.kind === 'pie' ? (
                        <PieChart>
                          <Pie data={data.chart.points} dataKey="value" nameKey="label" cx="50%" cy="50%" innerRadius={50} outerRadius={85} paddingAngle={3} strokeWidth={0} isAnimationActive={false}>
                            {data.chart.points.map((p, i) => <Cell key={p.label} fill={PIE_COLORS[i % PIE_COLORS.length]} />)}
                          </Pie>
                          <Tooltip formatter={(v, n) => [`${v}`, n]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                        </PieChart>
                      ) : (
                        <BarChart data={data.chart.points} barSize={26}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#EFEBF5" vertical={false} />
                          <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8C82A3' }} axisLine={false} tickLine={false} />
                          <YAxis tick={{ fontSize: 11, fill: '#8C82A3' }} axisLine={false} tickLine={false} width={72}
                            tickFormatter={(v) => (report.category === 'payroll' ? Number(v).toLocaleString('en-IN') : `${v}%`)} />
                          <Tooltip formatter={(v) => [v === null || v === undefined ? 'None' : report.category === 'payroll' ? money(v) : `${v}%`, data.chart.label]} contentStyle={{ fontSize: 12, borderRadius: 8 }} />
                          <Bar dataKey="value" fill={meta.hex} radius={[6, 6, 0, 0]} isAnimationActive={false} />
                        </BarChart>
                      )}
                    </ResponsiveContainer>
                  </div>
                )}

                {data.rows.length === 0 ? (
                  <p className="text-sm text-gray-400 py-12 text-center">Nothing to show for these filters.</p>
                ) : (
                  <div className="overflow-x-auto border border-gray-200 rounded-xl">
                    <table className="w-full text-sm">
                      <thead>
                        <tr>
                          {data.columns.map((c) => (
                            <th key={c.key} className={`${th} ${numeric(c.type) ? 'text-right' : 'text-left'}`}>{c.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {data.rows.map((row, i) => (
                          <tr key={i} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                            {data.columns.map((c) => (
                              <td key={c.key} className={`px-3 py-2.5 whitespace-nowrap ${numeric(c.type) ? 'text-right text-gray-800' : 'text-gray-700'} ${c.key === 'employee_code' ? 'font-mono text-xs text-gray-500' : ''}`}>
                                {show(row[c.key], c.type)}
                              </td>
                            ))}
                          </tr>
                        ))}
                        {data.totals && (
                          <tr className="bg-gray-50 border-t-2 border-gray-200 font-semibold">
                            {data.columns.map((c) => (
                              <td key={c.key} className={`px-3 py-2.5 whitespace-nowrap ${numeric(c.type) ? 'text-right' : ''}`}>
                                {data.totals[c.key] === null || data.totals[c.key] === undefined ? '' : show(data.totals[c.key], c.type)}
                              </td>
                            ))}
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                )}
                <p className="text-xs text-gray-400">{data.rows.length} {data.rows.length === 1 ? 'row' : 'rows'} · the CSV has exactly these rows.</p>
              </>
            )}
          </DataState>
        </div>
      </div>
    </>
  )
}

export default function Reports() {
  const [active, setActive] = useState(null)
  const can = useAuthStore((s) => s.can)
  const categories = Object.keys(CATEGORY_META).filter((cat) => can(CATEGORY_PERMISSION[cat]))

  return (
    <>
      <PageHeader title="Reports" subtitle="Worked out from the records for any month, and exported exactly as shown" />

      <div className="space-y-6">
        {categories.map((cat) => {
          const meta = CATEGORY_META[cat]
          return (
            <section key={cat} aria-label={`${meta.label} reports`}>
              <div className="flex items-center gap-2.5 mb-3">
                <span className="w-7 h-7 rounded-lg grid place-items-center" style={tint(meta.hex)}>
                  <meta.icon className="w-4 h-4" aria-hidden="true" />
                </span>
                <p className="text-sm font-bold text-gray-900">{meta.label} reports</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {REPORTS.filter((r) => r.category === cat).map((report) => (
                  <div key={report.id} className={`${card} p-5 flex flex-col gap-4 hover:border-brand-300 hover:shadow-md transition-all`}>
                    <div className="flex items-start gap-3.5">
                      <span className="w-10 h-10 rounded-[11px] grid place-items-center shrink-0" style={tint(meta.hex, '14')}>
                        <report.icon className="w-5 h-5" aria-hidden="true" />
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-bold text-gray-900">{report.title}</p>
                        <p className="text-xs text-gray-500 mt-1 leading-relaxed">{report.desc}</p>
                      </div>
                    </div>
                    <div className="mt-auto">
                      <button onClick={() => setActive(report)} className={btn.softSm}>
                        <FileText className="w-3.5 h-3.5" aria-hidden="true" /> Open & export
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )
        })}
      </div>

      {active && <ReportPanel key={active.id} report={active} onClose={() => setActive(null)} />}
    </>
  )
}
