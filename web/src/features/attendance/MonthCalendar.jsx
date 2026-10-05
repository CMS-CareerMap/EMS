import DataState from '../../components/DataState'
import { STATUS, WEEK_MONDAY_FIRST, WEEKDAYS, daysOfMonth, formatHours, weekdayOf } from '../../lib/attendance'
import { formatDay } from '../../lib/dates'

/**
 * One person's own month, a day a square: what the day was, in its colour,
 * with the hours worked on it.
 *
 * Holidays and weekly offs come from the company's calendar, not from rows —
 * nobody marks them, and a calendar drawn only from rows showed them blank,
 * as if the person had not come in. Days before they joined are faded.
 */
const SHORT = { present: 'Present', half_day: 'Half day', absent: 'Absent', on_leave: 'Leave', holiday: 'Holiday', weekly_off: 'Off' }

export default function MonthCalendar({ year, month, today, rows, rowsQuery, calendarQuery, joinedOn = null }) {
  return (
    <div>
      {/* A month that failed to load is not a month of blank days. */}
      <DataState queries={[rowsQuery, calendarQuery]} compact loading="Loading the month…">
        {([, calendar]) => <Grid year={year} month={month} today={today} rows={rows} calendar={calendar} joinedOn={joinedOn} />}
      </DataState>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] font-medium text-gray-500" aria-label="What the colours mean">
        {Object.entries(STATUS).map(([key, meta]) => (
          <li key={key} className="inline-flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-sm ${meta.dot}`} aria-hidden="true" />{meta.label}</li>
        ))}
      </ul>
    </div>
  )
}

function Grid({ year, month, today, rows, calendar, joinedOn }) {
  const days = daysOfMonth(year, month)
  const byDate = new Map(rows.map((r) => [r.date, r]))
  const offOn = new Map((calendar?.days_off ?? []).map((d) => [d.date, d]))
  const lead = WEEK_MONDAY_FIRST.indexOf(weekdayOf(days[0]))

  return (
    <div className="grid grid-cols-7 gap-1 sm:gap-1.5">
      {WEEK_MONDAY_FIRST.map((d) => (
        <div key={d} className="text-center text-[11px] font-bold text-gray-400 uppercase tracking-wide pb-1">
          <span className="sm:hidden">{WEEKDAYS[d].slice(0, 1)}</span><span className="hidden sm:inline">{WEEKDAYS[d].slice(0, 3)}</span>
        </div>
      ))}
      {Array.from({ length: lead }, (_, i) => <div key={`lead-${i}`} aria-hidden="true" />)}
      {days.map((day) => {
        const row = byDate.get(day)
        const off = offOn.get(day)
        // A row says what the day was; with none, the company's calendar may.
        const kind = row?.status ?? (off ? (off.kind === 'holiday' ? 'holiday' : 'weekly_off') : null)
        const meta = kind ? STATUS[kind] : null
        const open = row?.check_in && !row.check_out
        const label = open
          ? (day === today ? 'In' : 'No out')
          : row?.status === 'present' && row.hours_worked != null
            ? formatHours(row.hours_worked)
            : kind === 'holiday'
              ? (off?.name ?? 'Holiday')
              : kind ? SHORT[kind] : ''
        const before = joinedOn && day < joinedOn
        const words = [formatDay(day, { weekday: true, year: false }), off ? (off.name ?? 'Weekly off') : null, row ? STATUS[row.status]?.label : null, open ? (day === today ? 'checked in' : 'no check-out') : null, row?.hours_worked != null ? formatHours(row.hours_worked) : null].filter(Boolean)

        return (
          <div key={day} title={words.join(' · ')} aria-label={words.join(', ')}
            className={`relative min-h-11 sm:min-h-16 rounded-lg border p-1 sm:p-1.5 flex flex-col justify-between overflow-hidden
              ${meta ? meta.cell : 'bg-white border-gray-100 text-gray-700'}
              ${open && day !== today ? 'border-red-200' : ''}
              ${day === today ? 'ring-2 ring-brand-500 ring-offset-1' : ''}
              ${before ? 'opacity-40' : ''}`}>
            <span className={`text-xs sm:text-[13px] font-bold tabular-nums ${day === today ? 'text-brand-700' : ''}`}>{Number(day.slice(8))}</span>
            {label && <span className="hidden sm:block text-[10.5px] font-semibold leading-tight truncate">{label}</span>}
          </div>
        )
      })}
    </div>
  )
}
