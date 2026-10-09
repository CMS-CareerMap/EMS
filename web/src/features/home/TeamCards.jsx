import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, ChevronRight, Clock, Hourglass, UserCheck, CalendarDays, X } from 'lucide-react'
import DataState, { QueryError } from '../../components/DataState'
import { Avatar, Card, CardLink, Chip, StatTile } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { TabPanel } from '../../components/ui/Tabs'
import { onTabKeyDown, tabIdOf } from '../../components/ui/tabKeys'
import { useLeaveRequests, useUpdateLeaveStatus } from '../../hooks/useLeave'
import { useAuthStore } from '../../stores/authStore'
import { formatDay, wallClockIn } from '../../lib/dates'
import { minutesLabel, summaryOf } from '../../lib/requests'
import { clockSkew } from '../../lib/attendance'
import { useNow } from '../../hooks/useNow'
import { AcceptResignationDialog, CancelResignationDialog } from '../employees/LifecycleDialogs'

/**
 * The home page's cards about other people: what waits for this login's
 * decision, and today at work across its reach.
 */

const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (day) => SHORT_WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]
const range = (from, to) => (from === to ? formatDay(from) : `${formatDay(from, { year: false })} – ${formatDay(to)}`)

/**
 * Everything waiting for this login's decision, in one place: resignations
 * (as the person the writer reports to, or standing in), leave asked of them,
 * and the other requests they decide. Leave is decided right here; a request
 * opens where its details are.
 *
 * The answers come from the page, which also decides whether to show the card
 * at all — it is not drawn while nothing waits, and a list that failed to load
 * (`failed`: [what, query]) says so here rather than looking empty.
 *
 * Every resignation is listed: no other page lists the ones waiting for this
 * login, so one left under "and 2 more" could not be reached. Leave and
 * requests fill the rest, up to five rows; theirs is "Open all".
 */
export function WaitingCard({ leave, requests, resignations, failed = [] }) {
  const [chosen, setFilter] = useState('all')
  const panelId = 'waiting-panel'
  const [dialog, setDialog] = useState(null)
  const decide = useUpdateLeaveStatus()
  const deciding = decide.isPending ? decide.variables?.id : null

  const rows = [
    ...resignations.map((r) => ({ kind: 'resignation', key: `x${r.id}`, r })),
    ...leave.map((r) => ({ kind: 'leave', key: `l${r.id}`, r })),
    ...requests.map((r) => ({ kind: 'request', key: `r${r.id}`, r })),
  ]
  const tabs = [
    ['all', 'All', rows.length],
    ['leave', 'Leave', leave.length],
    ['request', 'Requests', requests.length],
    ['resignation', 'Resignation', resignations.length],
  ].filter(([key, , n]) => key === 'all' || n > 0)
  // A kind whose last item was just decided has no tab any more: back to all,
  // rather than an empty list with no way out.
  const filter = tabs.some(([key]) => key === chosen) ? chosen : 'all'
  const shown = rows.filter((row) => filter === 'all' || row.kind === filter)
  const shownResignations = shown.filter((row) => row.kind === 'resignation')
  const others = shown.filter((row) => row.kind !== 'resignation')
  const listed = [...shownResignations, ...others.slice(0, Math.max(0, 5 - shownResignations.length))]
  // What did not fit, by kind — each has its own page (Requests' "To decide"
  // holds no leave, Leave's no requests). Resignations are all here already.
  const hidden = (kind) => shown.filter((row) => row.kind === kind).length - listed.filter((row) => row.kind === kind).length
  const more = [
    ['leave', hidden('leave'), 'leave request', '/leave?tab=decide'],
    ['request', hidden('request'), 'request', '/requests?tab=decide'],
  ].filter(([, n]) => n > 0)
  const openAll = filter === 'leave' || (filter === 'all' && !requests.length && leave.length)
    ? '/leave?tab=decide'
    : (filter === 'request' || filter === 'all') && requests.length ? '/requests?tab=decide' : null

  return (
    <Card title="Waiting for you"
      subtitle={rows.length ? `${rows.length} need${rows.length === 1 ? 's' : ''} your decision` : 'Could not be checked'}
      action={openAll && <CardLink to={openAll}>Open all</CardLink>}>
      {failed.map(([what, query]) => (
        <div key={what} className="mb-3 rounded-lg border border-amber-200 bg-amber-50/50">
          <p className="px-3 pt-2.5 text-xs font-semibold text-gray-700">Your {what}</p>
          <QueryError error={query.error} onRetry={() => query.refetch()} retrying={query.isFetching} compact />
        </div>
      ))}
      {tabs.length > 2 && (
        <div className="flex flex-wrap gap-1.5 mb-3" role="tablist" aria-label="Waiting, by kind"
          onKeyDown={(e) => onTabKeyDown(e, tabs.map(([key]) => key), filter, setFilter)}>
          {tabs.map(([key, label, n]) => (
            <button key={key} type="button" role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}
              tabIndex={filter === key ? 0 : -1} data-tab-key={key} id={tabIdOf(panelId, key)} aria-controls={panelId}
              className={`h-7.5 px-3 rounded-full text-xs font-semibold border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${filter === key ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-200 text-gray-600 hover:border-gray-300'}`}>
              {label} <span className={filter === key ? 'text-gray-300' : 'text-gray-400'}>{n}</span>
            </button>
          ))}
        </div>
      )}
      <TabPanel id={panelId} tab={tabs.length > 2 ? filter : null}>
      <ul className="divide-y divide-gray-100">
        {listed.map(({ kind, key, r }) => (
          <li key={key} className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 py-3 first:pt-0 last:pb-0">
            <div className="flex items-start gap-3 min-w-0 flex-1">
              <Avatar name={r.full_name} />
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-gray-900">
                  {r.full_name}
                  {kind === 'resignation' && <Chip tone="warn">Resignation</Chip>}
                  {kind === 'leave' && <Chip tone="leave">{r.leave_type_name}</Chip>}
                  {kind === 'request' && <Chip tone="brand">{r.label}</Chip>}
                </p>
                {kind === 'resignation' && (
                  <>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[r.designation, r.department].filter(Boolean).join(', ') || r.employee_code}
                      {' · '}handed in {formatDay(r.submitted_on)} · asks to leave {formatDay(r.requested_last_day)}
                      {r.as_backup && ` · standing in for ${r.decided_by}`}
                    </p>
                    <p className="text-xs text-gray-600 italic mt-0.5 truncate">“{r.reason}”</p>
                  </>
                )}
                {kind === 'leave' && (
                  <p className="text-xs text-gray-500 mt-0.5">
                    {range(r.from_date, r.to_date)} · {r.days} day{r.days === 1 ? '' : 's'}{r.reason ? ` · “${r.reason}”` : ''}
                  </p>
                )}
                {kind === 'request' && (
                  <p className="text-xs text-gray-500 mt-0.5 truncate">
                    {summaryOf(r)}{r.may?.as_backup ? ' · standing in' : ''}
                  </p>
                )}
              </div>
            </div>
            <div className="flex gap-1.5 shrink-0 pl-12 sm:pl-0">
              {kind === 'resignation' && (
                <>
                  <button type="button" onClick={() => setDialog({ kind: 'accept', r })} className={btn.primarySm}>Accept</button>
                  <button type="button" onClick={() => setDialog({ kind: 'cancel', r })} className={btn.secondarySm}>Call off</button>
                </>
              )}
              {kind === 'leave' && (
                <>
                  <button type="button" disabled={Boolean(deciding)} onClick={() => decide.mutate({ id: r.id, status: 'approved' })} className={btn.okSm}>
                    <Check className="w-3.5 h-3.5" aria-hidden="true" />Approve
                  </button>
                  <button type="button" disabled={Boolean(deciding)} onClick={() => decide.mutate({ id: r.id, status: 'rejected' })} className={btn.dangerSm}>
                    <X className="w-3.5 h-3.5" aria-hidden="true" />Reject
                  </button>
                </>
              )}
              {kind === 'request' && (
                <Link to="/requests?tab=decide" className={btn.secondarySm}>Open<ChevronRight className="w-3.5 h-3.5" aria-hidden="true" /></Link>
              )}
            </div>
          </li>
        ))}
      </ul>
      {more.length > 0 && (
        <p className="text-xs text-gray-500 pt-3 border-t border-gray-100 mt-3">
          and{' '}
          {more.map(([kind, n, word, to], i) => (
            <span key={kind}>
              {i > 0 && ' and '}
              <Link to={to} className="font-semibold text-brand-600 hover:underline">{n} more {word}{n === 1 ? '' : 's'}</Link>
            </span>
          ))}
        </p>
      )}
      </TabPanel>

      {dialog?.kind === 'accept' && <AcceptResignationDialog resignation={dialog.r} name={dialog.r.full_name} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'cancel' && <CancelResignationDialog resignationId={dialog.r.id} name={dialog.r.full_name} accepted={false} onClose={() => setDialog(null)} />}
    </Card>
  )
}

/**
 * Leave waiting across this login's leave reach that is somebody else's to
 * decide — HR keeps an eye on it, and used to see it on its home page. What
 * this login decides itself is in "Waiting for you"; its own leave is on the
 * Leave page. Drawn by the page only for a leave reach beyond one's own.
 */
export function PendingLeaveCard() {
  const myId = useAuthStore((state) => state.profile?.id ?? null)
  const pending = useLeaveRequests({ status: 'pending' })
  return (
    <Card title="Leave waiting" subtitle="For somebody else's decision" action={<CardLink to="/leave">Leave</CardLink>}>
      <DataState query={pending} compact>
        {(rows) => {
          const others = rows.filter((r) => r.status === 'pending' && !r.can_decide && r.employee_id !== myId)
          if (others.length === 0) return <p className="py-4 text-center text-sm text-gray-500">No leave is waiting for anybody else.</p>
          return (
            <>
              <ul className="divide-y divide-gray-100">
                {others.slice(0, 4).map((r) => (
                  <li key={r.id} className="flex items-center gap-2.5 py-2.5 first:pt-0">
                    <Avatar name={r.full_name} size="sm" />
                    <div className="min-w-0 flex-1">
                      <p className="text-[13px] font-semibold text-gray-900 truncate">{r.full_name}</p>
                      <p className="text-xs text-gray-500 truncate">
                        {r.leave_type_name} · {range(r.from_date, r.to_date)}{r.decided_by ? ` · goes to ${r.decided_by}` : ''}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              {others.length > 4 && <Link to="/leave" className="mt-2 inline-block text-xs font-semibold text-brand-600 hover:underline">and {others.length - 4} more, on the Leave page</Link>}
            </>
          )
        }}
      </DataState>
    </Card>
  )
}

/**
 * Today at work across this login's attendance reach — the company for HR,
 * a manager's team. The page shows it only beyond one's own; the server
 * refuses a reach of one's own as well.
 */
export function TodayCard({ today }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const tick = useNow(30_000)
  return (
    <DataState query={today} keepOnRefetchError>
      {(t) => {
        const team = t.reach === 'team'
        // At work now (the server's rule, the roster's: app check-ins only), its
        // time running on the server's clock (client, 9 Oct 2026).
        const nowMs = tick.getTime() + clockSkew(t.server_now, today.dataUpdatedAt)
        const soFar = (p) => (p.at_work && p.check_in ? ` · ${minutesLabel(Math.floor(Math.max(0, nowMs - Date.parse(p.check_in)) / 60_000))} so far` : '')
        const notIn = t.people.filter((p) => !p.status)
        const present = t.counts.present + t.counts.half_day
        return (
          <Card title={team ? 'My team today' : 'Company today'}
            subtitle={t.day_off ? (t.holiday ? `Holiday · ${t.holiday}` : 'A weekly off — nobody is expected in') : `${t.headcount} at work today`}
            action={<CardLink to="/attendance">Attendance</CardLink>}>
            <div className="space-y-4">
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
                <StatTile label="Present" value={present} icon={UserCheck} tone="ok" hint={`of ${t.headcount}${t.counts.away ? ` · ${t.counts.away} away` : ''}`} />
                <StatTile label="Late today" value={t.counts.late} icon={Clock} tone="warn" />
                <StatTile label="On leave" value={t.counts.on_leave} icon={CalendarDays} tone="leave" />
                <StatTile label={t.day_off ? 'Day off' : 'Not marked yet'} value={t.day_off ? '—' : t.counts.not_marked} icon={Hourglass} tone="gray"
                  hint={!t.day_off && notIn.length ? notIn.slice(0, 2).map((p) => p.full_name.split(' ')[0]).join(', ') + (notIn.length > 2 ? '…' : '') : undefined} />
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
                <div className="lg:col-span-7">
                  {team ? (
                    <ul className="divide-y divide-gray-100">
                      {t.people.map((p) => (
                        <li key={p.id} className="flex items-center gap-3 py-2.5 first:pt-0">
                          <Avatar name={p.full_name} size="sm" />
                          <div className="min-w-0 flex-1">
                            <p className="text-[13px] font-semibold text-gray-900 truncate">{p.is_self ? 'You' : p.full_name}</p>
                            <p className="text-xs text-gray-500 truncate">{p.designation ?? p.employee_id}</p>
                            {/* On a phone under the name, so the name keeps its room. */}
                            {p.check_in && <p className="sm:hidden text-xs text-gray-500 tabular-nums">in {wallClockIn(timezone, p.check_in)}{soFar(p)}</p>}
                          </div>
                          {p.check_in && <span className="hidden sm:inline text-xs text-gray-500 tabular-nums whitespace-nowrap">in {wallClockIn(timezone, p.check_in)}{soFar(p)}</span>}
                          <PersonStatus p={p} dayOff={t.day_off} />
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <WeekBars week={t.week} headcount={t.headcount} />
                  )}
                </div>
                <div className="lg:col-span-5">
                  <p className="text-xs font-bold text-gray-700 mb-2">Away · next 7 days</p>
                  {t.away.length === 0
                    ? <p className="text-xs text-gray-500">Nobody is away in the next 7 days.</p>
                    : (
                      <ul className="divide-y divide-gray-100">
                        {t.away.slice(0, 5).map((a) => (
                          <li key={`${a.kind}${a.employee_id}${a.from_date}`} className="flex items-center gap-2.5 py-2 first:pt-0">
                            <Avatar name={a.full_name} size="sm" />
                            <div className="min-w-0 flex-1">
                              <p className="text-[13px] font-semibold text-gray-900 truncate">{a.full_name}</p>
                              <p className="text-xs text-gray-500 truncate">{weekdayOf(a.from_date)} {range(a.from_date, a.to_date)} · {a.label}</p>
                            </div>
                            <Chip tone={a.status === 'approved' ? 'ok' : 'warn'}>{a.status === 'approved' ? 'Approved' : 'Waiting'}</Chip>
                          </li>
                        ))}
                        {t.away.length > 5 && <li className="pt-2 text-xs text-gray-500">and {t.away.length - 5} more</li>}
                      </ul>
                    )}
                </div>
              </div>
            </div>
          </Card>
        )
      }}
    </DataState>
  )
}

function PersonStatus({ p, dayOff }) {
  if (!p.status) return <Chip tone="gray">{dayOff ? 'Day off' : 'Not in yet'}</Chip>
  if (p.status === 'present' && p.late_minutes > 0) return <Chip tone="warn">Late {minutesLabel(p.late_minutes)}</Chip>
  const label = { present: p.work_mode && p.work_mode !== 'office' ? 'Away' : 'Present', half_day: 'Half day', absent: 'Absent', on_leave: 'On leave', holiday: 'Holiday', weekly_off: 'Weekly off' }[p.status] ?? p.status
  const tone = { present: 'ok', half_day: 'brand', absent: 'bad', on_leave: 'leave' }[p.status] ?? 'gray'
  return <Chip tone={tone}>{label}</Chip>
}

/** Present each of the last seven days, today last; the company's days off named. */
function WeekBars({ week, headcount }) {
  const top = Math.max(1, headcount, ...week.map((d) => d.present + d.half_day))
  return (
    <div>
      <p className="text-xs font-bold text-gray-700 mb-2">Present, last 7 days</p>
      <div className="grid grid-cols-7 gap-1.5 sm:gap-2 items-end h-32" role="list" aria-label="People present, last seven days">
        {week.map((d, i) => {
          const today = i === week.length - 1
          const n = d.present + d.half_day
          const off = d.day_off && n === 0
          return (
            <div key={d.date} role="listitem" className="flex flex-col items-center justify-end gap-1 h-full" title={d.holiday ? `${formatDay(d.date)} · ${d.holiday}` : formatDay(d.date)}>
              <span className={`text-[11px] font-bold tabular-nums ${off ? 'text-gray-400' : 'text-gray-700'}`}>{off ? (d.day_off === 'holiday' ? 'Holiday' : 'Off') : n}</span>
              <span className={`w-full max-w-6 rounded-t-md rounded-b-sm ${off ? (d.day_off === 'holiday' ? 'bg-orange-100' : 'bg-gray-100') : today ? 'bg-[repeating-linear-gradient(45deg,#E7D5FB_0_5px,#D4B6F7_5px_10px)]' : 'bg-linear-to-b from-brand-400 to-brand-600'}`}
                style={{ height: off ? 8 : Math.max(6, Math.round((n / top) * 84)) }} />
              <span className="text-[11px] font-semibold text-gray-400">{today ? 'Today' : weekdayOf(d.date)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

