import DataState from '../../components/DataState'
import { Card } from '../../components/ui/bits'
import { useNow } from '../../hooks/useNow'
import { formatHours, monthLabel, serverSkew, unpaidDaysWords } from '../../lib/attendance'
import { formatDay } from '../../lib/dates'
import { minutesLabel } from '../../lib/requests'

/**
 * A month in figures (client, 15 Oct 2026), as the server counts it — the ONE
 * count behind one's own Attendance page, the page a name on Attendance opens,
 * and the home page's "My month": the days so far (the 1st, or the day they
 * joined, to today) and what each was, the hours of the days closed, and the
 * days paid and unpaid as payroll will count them. Today's time at work, while
 * they are still in, is added live — by the server's clock.
 *
 * `query`: usePersonMonth. `title`: "Attendance stats" on one's own page.
 */
export default function MonthFigures({ query, year, month, title = 'Month so far' }) {
  const now = useNow(60_000)
  return (
    <Card title={title} subtitle={monthLabel(year, month)}>
      <DataState query={query} compact>
        {(d) => <Figures d={d} now={now} />}
      </DataState>
    </Card>
  )
}

function Figures({ d, now }) {
  const t = d.totals
  // The time since today's check-in, by the server's clock: a phone minutes out neither adds nor takes away.
  const liveMs = t.open_since ? Math.max(0, now.getTime() + serverSkew(d) - Date.parse(t.open_since)) : 0
  const liveMinutes = Math.floor(liveMs / 60_000)

  const line = (name, value, hint) => (
    <div className="flex items-baseline justify-between gap-3 py-2.5 border-t border-gray-100 first:border-t-0 first:pt-0">
      <dt className="text-sm text-gray-600">{name}</dt>
      <dd className="text-right">
        <span className="text-sm font-bold text-gray-900 tabular-nums">{value}</span>
        {hint && <span className="block text-[11px] text-gray-400">{hint}</span>}
      </dd>
    </div>
  )

  if (!t.from) return <p className="text-sm text-gray-500">{nothingCounted(d)}</p>
  const counted = t.from === t.to ? formatDay(t.from, { year: false }) : `${formatDay(t.from, { year: false })} – ${formatDay(t.to, { year: false })}`
  const onTime = t.arrivals ? Math.round(((t.arrivals - t.late_days) / t.arrivals) * 100) : null
  const days = (n) => `${n} day${n === 1 ? '' : 's'}`

  return (
    <>
      <p className="text-xs text-gray-500 mb-2">
        Counted <b className="text-gray-700">{counted}</b>{t.ongoing ? ' · till today' : d.person?.employed_until && t.to === d.person.employed_until ? ' · to the last working day' : ' · the whole month'}
      </p>
      <dl>
        {line('Hours worked', formatHours(t.hours_worked), [
          liveMinutes > 0 ? `+ ${minutesLabel(liveMinutes)} today so far` : null,
          t.expected_hours != null ? `of ${formatHours(t.expected_hours)} expected for the days worked` : null,
          // In and never out: no hours, so neither counted nor expected — said, not hidden (25 Oct 2026).
          t.without_check_out > 0 ? `${days(t.without_check_out)} with no check-out not counted` : null,
        ].filter(Boolean).join(' · ') || null)}
        {line('Working days', t.working_days, `${t.weekly_offs} weekly off · ${t.holidays} holiday${t.holidays === 1 ? '' : 's'}`)}
        {line('Days present', t.present + t.half_days, t.half_days ? `${t.half_days} of them half days` : null)}
        {line('Average hours a day', t.average_hours == null ? '—' : formatHours(t.average_hours))}
        {line('On-time arrival', onTime === null ? '—' : `${onTime}%`, t.late_days ? `late on ${days(t.late_days)}` : null)}
        {line('Leave · Absent', `${t.on_leave} · ${t.absent}`, t.not_marked ? `${days(t.not_marked)} not marked yet` : null)}
        <PayDaysLines payDays={d.pay_days} line={line} />
      </dl>
    </>
  )
}

/** Why a month has no days to count: gone before it, not joined by its end, or not begun. */
function nothingCounted(d) {
  const monthKey = `${d.year}-${String(d.month).padStart(2, '0')}`
  const last = d.person?.last_working_date
  if (last && last.slice(0, 7) < monthKey) return `Not employed in this month — the last working day was ${formatDay(last)}.`
  const joined = d.person?.date_of_joining
  if (joined && joined.slice(0, 7) > monthKey) return `Not employed in this month — ${joined > d.today ? 'joins' : 'joined'} on ${formatDay(joined)}.`
  return 'Nothing to count yet in this month.'
}

/**
 * The days cut from pay (loss of pay), from the server's reckoning — the
 * payroll run's own. Nothing where they were not employed; a dash where no pay
 * rules were in force. Not "Paid days 31 of 31" (client, 25 Oct 2026): it
 * counted the whole month beside figures counted to today, and confused; what
 * matters through the month is what is cut. The payslip says the days paid.
 */
function PayDaysLines({ payDays: d, line }) {
  if (!d || !d.employed) return null
  return line('Unpaid days (loss of pay)', d.unpaid_days === null ? '—' : <span className={d.unpaid_days > 0 ? 'text-amber-800' : ''}>{d.unpaid_days}</span>,
    d.unpaid_days === null ? null : unpaidDaysWords(d))
}
