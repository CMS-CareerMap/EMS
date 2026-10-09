import { Link } from 'react-router-dom'
import { CalendarDays, Download, Inbox, Info, Loader2, Receipt, Upload } from 'lucide-react'
import DataState from '../../components/DataState'
import { Card, CardLink, Chip, EmptyState, IconBox, Ring } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { useMyRequests } from '../../hooks/useRequests'
import { useMyPayslips, downloadMyPayslip } from '../../hooks/usePayroll'
import { useChecklist } from '../../hooks/useDocuments'
import { useDownload } from '../../hooks/useDownload'
import { useAuthStore } from '../../stores/authStore'
import { formatDay } from '../../lib/dates'
import { minutesLabel, statusOf, summaryOf, typeLabel } from '../../lib/requests'
import { money, monthLabel } from '../payroll/format'
import { STATUS, clockSkew } from '../../lib/attendance'
import { useNow } from '../../hooks/useNow'

/**
 * The home page's cards about the signed-in person themselves: their month,
 * their leave, their last week, what they asked for, their payslip and their
 * papers. Each reads its own answer, so one that fails leaves the rest.
 */

const RING_COLOURS = ['#8B2FE6', '#F2479A', '#3BB8F5', '#0E9F6E', '#FF8A3D']
const SHORT_WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const weekdayOf = (day) => SHORT_WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()]

/**
 * The month at a glance, from the person's own record: today, and the days so
 * far. `note` says how their days are recorded when it is not by checking in
 * here — the biometric machine, HR, or their other login — chosen by the page
 * from the login's permissions and the record's attendance mode.
 */
export function MyMonthCard({ stats, note = null, showBalances = true }) {
  return (
    <Card title="My month" subtitle="This month so far" action={<CardLink to="/attendance">Attendance</CardLink>}>
      <DataState query={stats} compact>
        {(s) => {
          const balances = s.leaveBalances.filter((b) => b.total_days > 0 || b.remaining_days > 0)
          const today = STATUS[s.todayStatus] ?? null
          return (
            <div className="space-y-3">
              {today && <Chip tone={today.tone}>Today: {today.label}</Chip>}
              <div className="grid grid-cols-3 gap-x-2 gap-y-3">
                <Figure value={s.presentDays} label="Present" />
                <Figure value={s.absentDays} label="Absent" />
                <Figure value={s.leaveDays} label="Leave" />
                <Figure value={s.weeklyOffDays} label="Weekly off" />
                <Figure value={s.halfDays} label="Half days" />
                <Figure value={minutesLabel(Math.round((s.totalHours ?? 0) * 60))} label="Worked" />
              </div>
              {showBalances && balances.length > 0 && (
                <p className="text-xs rounded-lg bg-gray-50 px-3 py-2 text-gray-600">
                  Leave left · <b className="text-gray-800">{balances.map((b) => `${b.code} ${b.remaining_days}`).join(' · ')}</b>
                </p>
              )}
              {note && (
                <p className="flex gap-2 text-xs text-brand-700">
                  <Info className="w-4 h-4 shrink-0" aria-hidden="true" />
                  {note}
                </p>
              )}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

function Figure({ value, label }) {
  return (
    <div>
      <p className="text-xl font-extrabold tracking-tight text-gray-900 tabular-nums">{value}</p>
      <p className="text-xs text-gray-500">{label}</p>
    </div>
  )
}

/** Leave left this year, as rings — only the kinds the person has days in. */
export function LeaveBalanceCard({ stats, canApply }) {
  return (
    <Card title="Leave balance" subtitle="This leave year" action={canApply ? <CardLink to="/leave?apply=1">Apply</CardLink> : <CardLink to="/leave?tab=balance">Details</CardLink>}>
      <DataState query={stats} compact>
        {(s) => {
          const shown = s.leaveBalances.filter((b) => b.total_days > 0 || b.remaining_days > 0)
          const hidden = s.leaveBalances.filter((b) => !shown.includes(b))
          const pending = s.leaveBalances.reduce((sum, b) => sum + (b.pending ?? 0), 0)
          if (shown.length === 0) return <EmptyState icon={CalendarDays} title="No leave to take yet">Your leave for the year has not been given.</EmptyState>
          return (
            <div className="space-y-3">
              <div className="grid grid-cols-3 gap-2 text-center">
                {shown.slice(0, 6).map((b, i) => (
                  <div key={b.id}>
                    <div className="flex justify-center">
                      <Ring value={b.remaining_days} total={Math.max(b.total_days, b.remaining_days)} size={68} stroke={7} color={RING_COLOURS[i % RING_COLOURS.length]}
                        label={`${b.name}: ${b.remaining_days} of ${b.total_days} left`}>
                        <span>
                          <b className="block text-lg font-extrabold tabular-nums">{b.remaining_days}</b>
                          <span className="block text-[10px] font-semibold text-gray-500">of {b.total_days}</span>
                        </span>
                      </Ring>
                    </div>
                    <p className="text-xs font-semibold text-gray-700 mt-1.5 truncate" title={b.name}>{b.name.replace(/ Leave$/, '')}</p>
                  </div>
                ))}
              </div>
              {pending > 0 && <p className="text-xs font-semibold rounded-lg bg-amber-50 text-amber-800 px-3 py-2">{pending} day{pending === 1 ? '' : 's'} waiting for approval</p>}
              {hidden.length > 0 && <p className="text-xs text-gray-500">{hidden.map((b) => b.name).join(', ')} show here once you have days in them.</p>}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

/** The last seven days, hours a day — the company's days off named, a day with no check-out flagged. */
export function MyWeekCard({ stats }) {
  const tick = useNow(30_000)
  return (
    <Card title="My last 7 days" subtitle="Hours worked each day" action={<CardLink to="/attendance">Attendance</CardLink>}>
      <DataState query={stats} compact>
        {(s) => {
          const days = s.recentDays
          const worked = days.filter((d) => d.hours_worked > 0)
          const average = worked.length ? worked.reduce((sum, d) => sum + d.hours_worked, 0) / worked.length : 0
          const tallest = Math.max(9, ...worked.map((d) => d.hours_worked))
          // A day still at work: its time so far, on the server's clock, where
          // today said only "In" (client, 9 Oct 2026). Not in the average.
          const nowMs = tick.getTime() + clockSkew(s.serverNow, stats.dataUpdatedAt)
          const soFarMs = (d) => Math.max(0, nowMs - Date.parse(d.check_in))
          return (
            <div>
              <div className="grid grid-cols-7 gap-1.5 sm:gap-2 items-end h-32" role="list" aria-label="Hours worked, last seven days">
                {days.map((d, i) => {
                  const today = i === days.length - 1
                  const off = d.day_off
                  // Still at work (the server's rule: a night shift's day is yesterday's) runs its time; a day left open otherwise is a forgotten check-out.
                  const atWork = d.at_work ?? (today && d.check_in && !d.check_out)
                  const noOut = d.check_in && !d.check_out && !today && !atWork
                  const label = off === 'holiday' ? 'Holiday' : off === 'weekly_off' && !d.status ? 'Off' : noOut ? 'No out' : d.hours_worked ? minutesLabel(Math.round(d.hours_worked * 60)) : atWork ? minutesLabel(Math.floor(soFarMs(d) / 60_000)) : today && d.check_in && !d.check_out ? 'In' : '—'
                  const hours = d.hours_worked || (atWork ? soFarMs(d) / 3_600_000 : 0)
                  const height = hours ? Math.max(8, Math.round((Math.min(hours, tallest) / tallest) * 84)) : 8
                  return (
                    <div key={d.date} role="listitem" className="flex flex-col items-center justify-end gap-1 h-full" title={d.holiday ? `${formatDay(d.date)} · ${d.holiday}` : atWork ? `${formatDay(d.date)} · at work so far` : formatDay(d.date)}>
                      <span className={`text-[10px] sm:text-[11px] font-bold tabular-nums whitespace-nowrap ${off ? 'text-gray-400' : noOut ? 'text-red-500' : 'text-gray-700'}`}>{label}</span>
                      <span className={`w-full max-w-6 rounded-t-md rounded-b-sm ${off === 'holiday' ? 'bg-orange-100' : off ? 'bg-gray-100' : noOut ? 'bg-red-100' : today || atWork ? 'bg-[repeating-linear-gradient(45deg,#E7D5FB_0_5px,#D4B6F7_5px_10px)]' : 'bg-linear-to-b from-pink-400 to-brand-500'}`}
                        style={{ height }} />
                      <span className="text-[11px] font-semibold text-gray-400">{today ? 'Today' : weekdayOf(d.date)}</span>
                    </div>
                  )
                })}
              </div>
              {average > 0 && <p className="text-xs text-gray-500 mt-3">Average <b className="text-gray-800">{minutesLabel(Math.round(average * 60))}</b> on the days worked.</p>}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

/** What they asked for: requests and leave, newest first. */
export function MyRequestsCard({ stats }) {
  const canAsk = useAuthStore((state) => state.can('leave:apply'))
  const requests = useMyRequests({ enabled: canAsk })
  return (
    <Card title="My requests" subtitle="Leave and other requests" action={<CardLink to="/requests">All</CardLink>}>
      <DataState queries={canAsk ? [requests, stats] : [stats]} compact>
        {(answers) => {
          const [mine, s] = canAsk ? answers : [[], answers[0]]
          const rows = [
            ...mine.map((r) => ({ key: `r${r.id}`, at: r.submitted_at ?? '', icon: Inbox, title: typeLabel(r.type), sub: summaryOf(r), status: statusOf(r.status), tone: r.status })),
            ...s.recentLeaves.map((l) => ({
              key: `l${l.id}`, at: l.applied_on ?? '', icon: CalendarDays, title: l.leave_type_name,
              sub: `${formatDay(l.from_date)}${l.from_date !== l.to_date ? ` – ${formatDay(l.to_date)}` : ''} · ${l.days} day${l.days === 1 ? '' : 's'}`,
              status: { label: l.status === 'pending' ? 'Waiting' : l.status[0].toUpperCase() + l.status.slice(1) }, tone: l.status,
            })),
          ].sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 4)
          if (rows.length === 0) return <EmptyState icon={Inbox} title="Nothing sent yet" />
          const tone = (t) => (t === 'approved' ? 'ok' : t === 'pending' ? 'warn' : t === 'rejected' ? 'bad' : 'gray')
          return (
            <ul className="divide-y divide-gray-100">
              {rows.map((r) => (
                <li key={r.key} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                  <IconBox icon={r.icon} tone={r.icon === Inbox ? 'brand' : 'leave'} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-semibold text-gray-900 truncate">{r.title}</p>
                    <p className="text-xs text-gray-500 truncate">{r.sub}</p>
                  </div>
                  <Chip tone={tone(r.tone)}>{r.status.label}</Chip>
                </li>
              ))}
            </ul>
          )
        }}
      </DataState>
    </Card>
  )
}

/** The newest payslip, a click from its PDF. */
export function PayslipCard() {
  const slips = useMyPayslips()
  const { busy, start } = useDownload()
  return (
    <Card title="Payslip" subtitle="Your latest" action={<CardLink to="/payslips">My Payslips</CardLink>}>
      <DataState query={slips} compact empty={<EmptyState icon={Receipt} title="No payslips yet">Your first payslip shows here once that month is paid.</EmptyState>}>
        {(list) => {
          const slip = list[0]
          return (
            <div className="flex items-center gap-3 rounded-xl bg-logo-soft p-3">
              <span className="w-10 h-10 rounded-[11px] bg-white text-brand-600 grid place-items-center shadow-sm shrink-0"><Receipt className="w-5 h-5" aria-hidden="true" /></span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-bold text-gray-900">{monthLabel(slip.year, slip.month)}</p>
                <p className="text-xs text-gray-600">Net {money(slip.net_payable, slip.currency)} · paid {formatDay(slip.paid_on)}</p>
              </div>
              <button type="button" onClick={() => start(slip.id, () => downloadMyPayslip(slip.id))} disabled={busy === slip.id} className={btn.secondarySm}
                aria-label={`Download the ${monthLabel(slip.year, slip.month)} payslip`}>
                {busy === slip.id ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} PDF
              </button>
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

/** Their own papers: how many of the required ones are verified. */
export function MyDocumentsCard() {
  const checklist = useChecklist(undefined)
  return (
    <Card title="My documents" subtitle="What HR needs from you" action={<CardLink to="/documents?tab=mine">Documents</CardLink>}>
      <DataState query={checklist} compact>
        {(data) => {
          const required = data.items.filter((i) => i.type.required)
          const verified = required.filter((i) => i.current?.status === 'verified').length
          const waiting = data.items.filter((i) => i.current?.status === 'pending').length
          const missing = required.filter((i) => !i.current).map((i) => i.type.label)
          return (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Ring value={verified} total={required.length || 1} size={56} stroke={6} label={`${verified} of ${required.length} required documents verified`}>
                  <b className="text-sm font-extrabold tabular-nums">{verified}/{required.length}</b>
                </Ring>
                <div className="min-w-0 text-xs">
                  <p className="text-[13px] font-bold text-gray-900">Required verified</p>
                  <p className="text-gray-500 truncate">
                    {missing.length ? `Still to upload: ${missing.join(', ')}` : waiting ? `${waiting} waiting for HR to check` : 'All in order'}
                  </p>
                </div>
              </div>
              {missing.length > 0 && (
                <Link to="/documents?tab=mine" className={btn.softSm}><Upload className="w-3.5 h-3.5" aria-hidden="true" />Upload</Link>
              )}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

