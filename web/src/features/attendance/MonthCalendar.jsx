import DataState from '../../components/DataState'
import { STATUS, UNPAID_LEAVE, WEEK_MONDAY_FIRST, WEEKDAYS, daysOfMonth, formatHours, leaveWords, weekdayOf } from '../../lib/attendance'
import { formatDay } from '../../lib/dates'

/**
 * One person's own month, a day a square: what the day was, in its colour,
 * with the hours worked on it.
 *
 * Holidays and weekly offs come from the company's calendar, not from rows —
 * nobody marks them, and a calendar drawn only from rows showed them blank,
 * as if the person had not come in. Days before they joined are faded.
 *
 * A day of leave says which (client, 10 Oct 2026): "Casual Leave", or "Loss
 * of Pay" in amber — the unpaid colour everywhere — from `leaveOn` (the
 * pay-days answer). An absent day leave can still be asked for is a button,
 * when `onApply` is given: it opens the leave form on that day.
 */
const SHORT = { present: 'Present', half_day: 'Half day', absent: 'Absent', on_leave: 'Leave', holiday: 'Holiday', weekly_off: 'Off' }

export default function MonthCalendar({ year, month, today, rows, rowsQuery, calendarQuery, joinedOn = null, leaveOn = null, absentOn = null, onApply = null }) {
  const anyUnpaid = leaveOn ? [...leaveOn.values()].some((l) => !l.paid) : false
  return (
    <div>
      {/* A month that failed to load is not a month of blank days. */}
      <DataState queries={[rowsQuery, calendarQuery]} compact loading="Loading the month…">
        {([, calendar]) => <Grid year={year} month={month} today={today} rows={rows} calendar={calendar} joinedOn={joinedOn} leaveOn={leaveOn} absentOn={absentOn} onApply={onApply} />}
      </DataState>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] font-medium text-gray-500" aria-label="What the colours mean">
        {Object.entries(STATUS).map(([key, meta]) => (
          <li key={key} className="inline-flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-sm ${meta.dot}`} aria-hidden="true" />{meta.label}</li>
        ))}
        {anyUnpaid && <li className="inline-flex items-center gap-1.5"><span className={`w-2.5 h-2.5 rounded-sm ${UNPAID_LEAVE.dot}`} aria-hidden="true" />{UNPAID_LEAVE.label}</li>}
      </ul>
    </div>
  )
}

function Grid({ year, month, today, rows, calendar, joinedOn, leaveOn, absentOn, onApply }) {
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
        const leave = row?.status === 'on_leave' ? (leaveOn?.get(day) ?? null) : null
        // A row says what the day was; with none, the company's calendar may.
        const kind = row?.status ?? (off ? (off.kind === 'holiday' ? 'holiday' : 'weekly_off') : null)
        const meta = leave && !leave.paid ? UNPAID_LEAVE : kind ? STATUS[kind] : null
        const open = row?.check_in && !row.check_out
        const label = open
          ? (day === today ? 'In' : 'No out')
          : row?.status === 'present' && row.hours_worked != null
            ? formatHours(row.hours_worked)
            : leave
              ? leaveWords(leave)
              : kind === 'holiday'
                ? (off?.name ?? 'Holiday')
                : kind ? SHORT[kind] : ''
        const before = joinedOn && day < joinedOn
        const absent = row?.status === 'absent' ? absentOn?.get(day) : null
        const canApply = Boolean(onApply && absent?.can_apply)
        const asked = absent?.applied
          ? (absent.leave?.status === 'approved' ? `${absent.leave.half ? 'half day of ' : ''}${absent.leave.leave_type_name} approved` : 'leave applied, waiting')
          : null
        const words = [
          formatDay(day, { weekday: true, year: false }),
          off ? (off.name ?? 'Weekly off') : null,
          leave ? leaveWords(leave) : row ? STATUS[row.status]?.label : null,
          leave && !leave.paid ? 'unpaid' : null,
          open ? (day === today ? 'checked in' : 'no check-out') : null,
          row?.hours_worked != null ? formatHours(row.hours_worked) : null,
          asked,
          canApply ? 'apply leave for this day' : null,
          // Why there is no button — the calendar is all a manager's own month has (Attendance → Team).
          absent && !absent.applied && !canApply ? absent.why : null,
        ].filter(Boolean)
        const className = `relative min-h-11 sm:min-h-16 rounded-lg border p-1 sm:p-1.5 flex flex-col justify-between overflow-hidden text-left
          ${meta ? meta.cell : 'bg-white border-gray-100 text-gray-700'}
          ${open && day !== today ? 'border-red-200' : ''}
          ${day === today ? 'ring-2 ring-brand-500 ring-offset-1' : ''}
          ${before ? 'opacity-40' : ''}`
        const inside = (
          <>
            <span className={`text-xs sm:text-[13px] font-bold tabular-nums ${day === today ? 'text-brand-700' : ''}`}>{Number(day.slice(8))}</span>
            {label && <span className="hidden sm:block text-[10.5px] font-semibold leading-tight truncate">{label}</span>}
            {canApply && <span className="hidden sm:block text-[10px] font-bold text-brand-700 underline">Apply leave</span>}
            {absent?.applied && <span className="hidden sm:block text-[10px] font-semibold leading-tight truncate">{absent.leave?.status === 'approved' ? 'Leave approved' : 'Leave applied'}</span>}
            {/* On a phone the words are hidden: a dot says there is something to do, or something asked. */}
            {(canApply || absent?.applied) && (
              <span className={`sm:hidden absolute top-1 right-1 w-1.5 h-1.5 rounded-full ${canApply ? 'bg-brand-600' : STATUS.on_leave.dot}`} aria-hidden="true" />
            )}
          </>
        )

        return canApply ? (
          <button key={day} type="button" onClick={() => onApply(day)} title={words.join(' · ')} aria-label={words.join(', ')}
            className={`${className} hover:ring-2 hover:ring-brand-300 focus-visible:ring-2 focus-visible:ring-brand-500`}>
            {inside}
          </button>
        ) : (
          <div key={day} title={words.join(' · ')} aria-label={words.join(', ')} className={className}>
            {inside}
          </div>
        )
      })}
    </div>
  )
}
