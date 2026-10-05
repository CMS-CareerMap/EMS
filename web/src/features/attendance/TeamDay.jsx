import { ChevronLeft, ChevronRight, Search, Edit2, UserCheck, UserX, Clock, CalendarDays, CircleDashed } from 'lucide-react'
import { Avatar, Chip, StatTile } from '../../components/ui/bits'
import { btn, card, field, th, td } from '../../components/ui/styles'
import { STATUS, formatHours } from '../../lib/attendance'
import { addDays, formatDay } from '../../lib/dates'
import { WORK_MODES, minutesLabel } from '../../lib/requests'
import DayBar from './DayBar'

/**
 * One day of everybody the caller's attendance reaches — a team, or the
 * company: the figures, the filters, and a line a person with their day drawn
 * on it, and Mark or Edit for whoever may record days.
 */

/** `unmarked` is not a status — it is the absence of one, and a filter of its own. */
const FILTERS = [
  ['all', 'All'], ['present', 'Present'], ['half_day', 'Half Day'], ['absent', 'Absent'],
  ['on_leave', 'On Leave'], ['weekly_off', 'Weekly Off'], ['unmarked', 'Not Marked'],
]

const TILES = [
  { key: 'present', label: 'Present', icon: UserCheck, tone: 'ok' },
  { key: 'half_day', label: 'Half Day', icon: Clock, tone: 'brand' },
  { key: 'absent', label: 'Absent', icon: UserX, tone: 'bad' },
  { key: 'on_leave', label: 'On Leave', icon: CalendarDays, tone: 'leave' },
  { key: 'unmarked', label: 'Not Marked', icon: CircleDashed, tone: 'gray' },
]

export default function TeamDay({
  records, filtered, stats, date, onDate, today, tab, onTab,
  departments, deptFilter, onDept, search, onSearch, canMark, onMark, nowMinutes,
}) {
  const marked = records.length - stats.unmarked
  // The day's attendance: present or half day, of everybody on the roster.
  const attended = records.length ? Math.round(((stats.present + stats.half_day) / records.length) * 100) : 0
  const step = 'grid place-items-center w-8 h-8 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 disabled:text-gray-300 disabled:hover:bg-transparent transition-colors'

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {TILES.map((tile) => (
          <StatTile key={tile.key} label={tile.label} value={stats[tile.key]} icon={tile.icon} tone={tile.tone}
            onClick={() => onTab(tab === tile.key ? 'all' : tile.key)} active={tab === tile.key} />
        ))}
      </div>

      <div className={`${card} overflow-hidden`}>
        <div className="px-4 py-3 flex flex-wrap gap-2.5 items-center border-b border-gray-200">
          <div className="inline-flex items-center gap-0.5 rounded-lg border border-gray-200 bg-white p-0.5">
            <button type="button" onClick={() => onDate(addDays(date, -1))} aria-label="Previous day" className={step}>
              <ChevronLeft className="w-4 h-4" />
            </button>
            <input type="date" value={date} max={today} aria-label="Day" onChange={(e) => e.target.value && onDate(e.target.value)}
              className="h-8 px-2 text-[13px] font-semibold text-gray-900 bg-transparent focus:outline-none" />
            <button type="button" onClick={() => onDate(date < today ? addDays(date, 1) : date)} disabled={date >= today} aria-label="Next day" className={step}>
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
          {date !== today && <button type="button" onClick={() => onDate(today)} className={btn.softSm}>Today</button>}

          <label className="relative flex-1 min-w-44">
            <span className="sr-only">Search employee</span>
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
            <input type="text" placeholder="Search employee…" value={search} onChange={(e) => onSearch(e.target.value)} className={`w-full pl-9 ${field}`} />
          </label>

          {/* The company's own departments, from the people on the roster. */}
          <select value={deptFilter} onChange={(e) => onDept(e.target.value)} aria-label="Department" className={`${field} flex-1 sm:flex-none`}>
            {departments.map((d) => <option key={d} value={d}>{d === 'All' ? 'All departments' : d}</option>)}
          </select>

          <div className="w-full sm:w-auto sm:ml-auto flex items-center gap-2 text-xs font-semibold text-gray-500">
            {marked}/{records.length} marked
            <span className="flex-1 sm:flex-none sm:w-28 h-1.5 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
              <span className="block h-full bg-logo rounded-full transition-all" style={{ width: `${attended}%` }} />
            </span>
            <span className="text-gray-700 tabular-nums">{attended}% present</span>
          </div>
        </div>

        <div className="px-4 pt-3 flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Status">
          {FILTERS.map(([key, label]) => (
            <button key={key} type="button" onClick={() => onTab(key)} aria-pressed={tab === key}
              className={`shrink-0 inline-flex items-center gap-1.5 h-8 px-3 rounded-full text-[12.5px] font-semibold border transition-colors
                ${tab === key ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {label}
              <span className={`text-[11px] tabular-nums ${tab === key ? 'text-white/70' : 'text-gray-400'}`}>{key === 'all' ? records.length : stats[key]}</span>
            </button>
          ))}
        </div>

        {/* A computer: the table, with the day on a line. */}
        <div className="hidden md:block overflow-x-auto mt-3">
          <table className="w-full min-w-200">
            <thead>
              <tr>
                <th className={`${th} pl-5`}>Employee</th>
                <th className={th}>Department</th>
                <th className={th}>Check-in</th>
                <th className={th}>Check-out</th>
                <th className={`${th} hidden xl:table-cell`}>Day · 08:00 – 20:00</th>
                <th className={th}>Hours</th>
                <th className={th}>Status</th>
                {canMark && <th className={`${th} text-right pr-5`}>Action</th>}
              </tr>
            </thead>
            <tbody>
              {/* The roster has answered by now, so nothing here is the empty of a
                  failed request — only of the filters. */}
              {filtered.length === 0 ? (
                <tr><td colSpan={canMark ? 8 : 7} className="text-center py-14 text-sm text-gray-400">No records found.</td></tr>
              ) : filtered.map((rec) => {
                const meta = rec.status ? STATUS[rec.status] : null
                return (
                  <tr key={rec.id} className="hover:bg-gray-50 transition-colors">
                    <td className={`${td} pl-5`}>
                      <div className="flex items-center gap-3">
                        <Avatar name={rec.full_name} size="sm" />
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-gray-900 truncate">{rec.full_name}</p>
                          <p className="text-xs text-gray-400 font-mono">{rec.employee_code}</p>
                        </div>
                      </div>
                    </td>
                    <td className={td}>
                      <p className="text-gray-700">{rec.department || '—'}</p>
                      <p className="text-xs text-gray-400">{rec.designation || '—'}</p>
                    </td>
                    <td className={`${td} tabular-nums`}>
                      <span className={rec.check_in ? 'font-semibold text-gray-900' : 'text-gray-300'} title={rec.check_in_device ?? undefined}>{rec.check_in || '—'}</span>
                      {rec.late_minutes > 0 && <span className="block mt-1"><Chip tone="warn" dot={false}>Late {minutesLabel(rec.late_minutes)}</Chip></span>}
                      {rec.work_mode && rec.work_mode !== 'office' && <span className="block mt-1"><Chip tone="info" dot={false}>{WORK_MODES[rec.work_mode]}</Chip></span>}
                    </td>
                    <td className={`${td} tabular-nums`}>
                      <span className={rec.check_out ? 'text-gray-900' : 'text-gray-300'}>{rec.check_out || '—'}</span>
                    </td>
                    <td className={`${td} hidden xl:table-cell min-w-40`}>
                      <DayBar checkIn={rec.check_in} checkOut={rec.check_out} nowMinutes={date === today ? nowMinutes : null}
                        off={rec.status === 'holiday' || rec.status === 'weekly_off' ? rec.status : null} />
                    </td>
                    <td className={`${td} tabular-nums whitespace-nowrap`}>
                      {formatHours(rec.hours_worked)}
                      {rec.overtime_minutes > 0 && <span className="block text-xs font-semibold text-emerald-700">+{minutesLabel(rec.overtime_minutes)} overtime</span>}
                      {rec.early_leaving_minutes > 0 && <span className="block text-xs font-semibold text-amber-700">Left {minutesLabel(rec.early_leaving_minutes)} early</span>}
                    </td>
                    <td className={td}>
                      {meta ? (
                        <div className="flex items-center gap-2">
                          <Chip tone={meta.tone}>{meta.label}</Chip>
                          {rec.note && <span className="text-xs text-gray-400 truncate max-w-24" title={rec.note}>{rec.note}</span>}
                        </div>
                      ) : (
                        <Chip tone="gray" dot={false}>Not marked</Chip>
                      )}
                    </td>
                    {canMark && (
                      <td className={`${td} text-right pr-5`}>
                        {rec.mark_goes_to ? (
                          <span className="text-xs text-gray-400 italic">Goes to {rec.mark_goes_to}</span>
                        ) : (
                          <button type="button" onClick={() => onMark(rec)} className={btn.softSm} aria-label={`${rec.status ? 'Edit' : 'Mark'} ${rec.full_name}`}>
                            <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />{rec.status ? 'Edit' : 'Mark'}
                          </button>
                        )}
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* A phone: a line a person, Mark or Edit beside it. */}
        <ul className="md:hidden divide-y divide-gray-100 mt-3 border-t border-gray-100" aria-label="Attendance">
          {filtered.length === 0 && <li className="px-4 py-10 text-center text-sm text-gray-400">No records found.</li>}
          {filtered.map((rec) => {
            const meta = rec.status ? STATUS[rec.status] : null
            return (
              <li key={rec.id} className="px-4 py-3 flex items-center gap-3">
                <Avatar name={rec.full_name} size="sm" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold text-gray-900 truncate">{rec.full_name}</p>
                  <p className="text-xs text-gray-500 tabular-nums">
                    {rec.check_in ? `In ${rec.check_in}${rec.check_out ? ` · Out ${rec.check_out}` : ''}${rec.late_minutes > 0 ? ` · late ${minutesLabel(rec.late_minutes)}` : ''}` : (rec.department || rec.employee_code)}
                  </p>
                  {canMark && rec.mark_goes_to && <p className="text-[11px] text-gray-400 italic">Goes to {rec.mark_goes_to}</p>}
                </div>
                {meta ? <Chip tone={meta.tone}>{meta.label}</Chip> : <Chip tone="gray" dot={false}>Not marked</Chip>}
                {canMark && !rec.mark_goes_to && (
                  <button type="button" onClick={() => onMark(rec)} className={btn.icon} aria-label={`${rec.status ? 'Edit' : 'Mark'} ${rec.full_name}`}>
                    <Edit2 className="w-4 h-4" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>

        <div className="px-4 sm:px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3 text-xs text-gray-500">
          <span>Showing {filtered.length} of {records.length} employees</span>
          <span>{formatDay(date)}</span>
        </div>
      </div>
    </div>
  )
}
