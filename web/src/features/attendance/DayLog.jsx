import { useAuthStore } from '../../stores/authStore'
import { useNow } from '../../hooks/useNow'
import { Chip } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { dayState, daysOfMonth, formatHours, monthLabel } from '../../lib/attendance'
import AbsentAction from './AbsentAction'
import { formatDay, wallClockIn } from '../../lib/dates'
import { WORK_MODES, minutesLabel } from '../../lib/requests'

/**
 * A month's days, a line a day, newest first — up to today and from the day
 * they joined: arrival, departure, hours, and what the day was. One's own
 * Attendance page, and the page a name on Attendance opens (client, 15 Oct
 * 2026), draw the same lines. A computer gets a table; a phone, a list.
 *
 * `onApply` (one's own page): an absent day leave can still be asked for opens
 * the leave form. `onEvidence` (somebody's page): a day's punches, with the
 * photos, for whoever may see them.
 */
/** A day checked in on the app — HR may have put its check-out right since: the roster's own rule for Evidence. */
const appPunched = (row) => row?.source === 'punch' || (row?.source === 'correction' && Boolean(row?.check_in))

export default function DayLog({ year, month, today, days, daysOff, leaveOn, absentOn, onApply = null, joinedOn = null, leftOn = null, open = null, skewMs = 0, label, onEvidence = null, notJoined = 'Not joined yet in this month.' }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const now = useNow()
  const byDate = new Map(days.map((r) => [r.date, r]))
  const offOn = new Map((daysOff ?? []).map((d) => [d.date, d]))
  // The days they were employed, to today: from joining, to their last day (15 Oct 2026).
  const logDays = daysOfMonth(year, month).filter((d) => d <= today && (!joinedOn || d >= joinedOn) && (!leftOn || d <= leftOn)).reverse()
  // The time so far of the day they are still at work on (`open`: today's, or a night shift's past
  // midnight) — since its check-in, by the server's clock (`skewMs`), as the month's figures count it.
  const soFar = open ? Math.floor((now.getTime() + skewMs - Date.parse(open.since)) / 60_000) : 0
  const runningOn = (day) => Boolean(open) && day === open.day && soFar > 0
  const clock = (iso) => (iso ? wallClockIn(timezone, iso) : null)

  if (logDays.length === 0) {
    const first = daysOfMonth(year, month)[0]
    return (
      <p className="px-4 py-10 text-center text-sm text-gray-500">
        {first > today ? 'This month has not started yet.' : leftOn && first > leftOn ? `Not employed in this month — the last working day was ${formatDay(leftOn)}.` : notJoined}
      </p>
    )
  }

  return (
    <>
      {/* A computer: a table with the day drawn on a line. */}
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm" aria-label={`${label} in ${monthLabel(year, month)}`}>
          <thead>
            <tr className="text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider border-b border-gray-100">
              <th className="px-4 py-2.5">Date</th>
              <th className="px-4 py-2.5">Arrival</th>
              <th className="px-4 py-2.5">Departure</th>
              <th className="px-4 py-2.5">Hours</th>
              <th className="px-4 py-2.5">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {logDays.map((day) => {
              const row = byDate.get(day)
              const state = dayState({ date: day, row, dayOff: offOn.get(day), today, leave: leaveOn.get(day) ?? null })
              const inAt = clock(row?.check_in)
              const outAt = clock(row?.check_out)
              return (
                <tr key={day} className={day === today ? 'bg-brand-50/40' : ''}>
                  <td className="px-4 py-3 font-semibold text-gray-900 whitespace-nowrap">{formatDay(day, { weekday: true, year: false })}</td>
                  <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                    {inAt ?? <span className="text-gray-300">—</span>}
                    {row?.late_minutes > 0 && <span className="ml-1.5 text-xs font-bold text-amber-600">+{minutesLabel(row.late_minutes)}</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                    {outAt ?? <span className="text-gray-300">—</span>}
                    {row?.early_leaving_minutes > 0 && <span className="ml-1.5 text-xs font-bold text-amber-600">−{minutesLabel(row.early_leaving_minutes)}</span>}
                  </td>
                  <td className="px-4 py-3 tabular-nums whitespace-nowrap">
                    {row?.hours_worked != null ? formatHours(row.hours_worked) : runningOn(day) ? <span className="text-gray-500">{minutesLabel(soFar)} so far</span> : <span className="text-gray-300">—</span>}
                    {row?.overtime_minutes > 0 && <span className="block text-xs font-semibold text-emerald-700">+{minutesLabel(row.overtime_minutes)} overtime</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Chip tone={state.tone}>{state.label}</Chip>
                      {row?.work_mode && row.work_mode !== 'office' && <Chip tone="info" dot={false}>{WORK_MODES[row.work_mode]}</Chip>}
                      <AbsentAction absent={row?.status === 'absent' ? absentOn.get(day) : null} day={day} onApply={onApply} />
                      {onEvidence && appPunched(row) && (
                        <button type="button" onClick={() => onEvidence(day)} className={btn.softSm} aria-label={`Evidence of the punches on ${formatDay(day)}`}>Evidence</button>
                      )}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* A phone: a line a day, the times under the date. */}
      <ul className="md:hidden divide-y divide-gray-100" aria-label={`${label} in ${monthLabel(year, month)}`}>
        {logDays.map((day) => {
          const row = byDate.get(day)
          const state = dayState({ date: day, row, dayOff: offOn.get(day), today, leave: leaveOn.get(day) ?? null })
          const inAt = clock(row?.check_in)
          const outAt = clock(row?.check_out)
          return (
            <li key={day} className={`px-4 py-3 ${day === today ? 'bg-brand-50/40' : ''}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-gray-900">{formatDay(day, { weekday: true, year: false })}</span>
                <Chip tone={state.tone}>{state.label}</Chip>
              </div>
              <div className="mt-1 empty:hidden"><AbsentAction absent={row?.status === 'absent' ? absentOn.get(day) : null} day={day} onApply={onApply} /></div>
              {(inAt || row?.hours_worked != null) && (
                <p className="text-xs text-gray-500 mt-1 tabular-nums">
                  {[inAt && `In ${inAt}${row?.late_minutes > 0 ? ` (+${minutesLabel(row.late_minutes)})` : ''}`, outAt && `Out ${outAt}`, row?.hours_worked != null ? formatHours(row.hours_worked) : runningOn(day) && `${minutesLabel(soFar)} so far`].filter(Boolean).join(' · ')}
                </p>
              )}
              {onEvidence && appPunched(row) && (
                <button type="button" onClick={() => onEvidence(day)} className="mt-1 -ml-1 px-1 py-1 text-xs font-semibold text-brand-600 hover:underline" aria-label={`Evidence of the punches on ${formatDay(day)}`}>Evidence</button>
              )}
            </li>
          )
        })}
      </ul>
    </>
  )
}
