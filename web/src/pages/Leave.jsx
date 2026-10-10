import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import {
  CheckCircle, XCircle, Clock, Plus, Search, Undo2, Gift, Sparkles, ScrollText,
} from 'lucide-react'
import ApplyLeaveModal from '../features/leave/ApplyLeaveModal'
import TeamAway from '../features/leave/TeamAway'
import StatementDialog from '../features/leave/StatementDialog'
import TeamBalances from '../features/leave/TeamBalances'
import { useLeaveRequests, useTeamLeave, useLeaveBalances, useHolidays, useApplyLeave, useUpdateLeaveStatus, useWithdrawLeave, useReverseLeave } from '../hooks/useLeave'
import { useAuthStore } from '../stores/authStore'
import { addDays, calendarDayIn, formatDay, formatDayOf } from '../lib/dates'
import { leaveCodesOf, leaveLabel, typeColourOf } from '../lib/leaveTypes'
import DataState, { DataRows } from '../components/DataState'
import ConfirmDialog from '../components/ConfirmDialog'
import PageHeader from '../components/ui/PageHeader'
import { TabPanel } from '../components/ui/Tabs'
import Segmented from '../components/ui/Segmented'
import { Avatar, Card, Chip, EmptyState, Ring, StatTile } from '../components/ui/bits'
import { btn, card, field, th, td } from '../components/ui/styles'

// ─── Helpers ──────────────────────────────────────────────────────────────────

/*
 * Leave types are the company's own (Settings → Leave): the badge shows the
 * name the server sends and the filter offers the types actually in the list.
 * A table of casual/sick/earned written here matched none of the codes a
 * company sets (CL, SL, EL), so every badge showed a raw code and the type
 * filter found nothing.
 */

/**
 * Every status the server has. "Cancelled" is a request withdrawn while
 * pending, or approved leave reversed — without it here, one such request
 * took the whole page down.
 */
const STATUS_META = {
  pending: { label: 'Pending', tone: 'warn' },
  approved: { label: 'Approved', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'bad' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
}

/** The types the server sends. weekly_off appears only on older rows. */
const HOLIDAY_TYPE = {
  public: { tone: 'ok', label: 'Public' },
  optional: { tone: 'brand', label: 'Optional' },
  weekly_off: { tone: 'gray', label: 'Weekly off' },
}

const TABS = ['requests', 'decide', 'team', 'balance', 'holidays']
const TAB_LABELS = { requests: 'Leave Requests', decide: 'Team Requests', team: 'Team Balances', balance: 'Leave Balance', holidays: 'Holiday Calendar' }
const STATUS_FILTER = ['all', 'pending', 'approved', 'rejected', 'cancelled']

/** A ring's colour per leave type, in the logo's colours. */
const RING_COLOURS = ['#8B2FE6', '#F2479A', '#3BB8F5', '#0E9F6E', '#FF8A3D', '#5B7CF0']

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What reversing gives back, part by part: paid days return to their balance;
 * unpaid ones (Loss of Pay) have none — they are simply no longer cut from pay.
 */
function reverseWords(req) {
  return (req.parts ?? [req]).map((p) => (p.is_paid === false
    ? `${plural(p.days, 'day')} of ${p.leave_type_name} ${p.days === 1 ? 'is' : 'are'} no longer cut from pay.`
    : `${plural(p.days, 'day')} go${p.days === 1 ? 'es' : ''} back to ${req.full_name}’s ${p.leave_type_name}.`)).join(' ')
}

// ─── Leave Requests tab ───────────────────────────────────────────────────────

/** One empty list, so the filters below are not recomputed on every render. */
const NO_REQUESTS = []

/**
 * A list of requests, each with the buttons the server says the caller may
 * use on it (Day 22: `can_decide`, `can_reverse` — who decides is the company
 * tree, not a role). Everybody else sees who decides it. `note` is said above
 * the list — the backup list explains itself.
 *
 * `deciding` is the request a decision is being sent for: its Approve and
 * Reject are held until the answer comes, so a second tap on a slow line does
 * not send a second decision that is refused after the first succeeded.
 *
 * A list of one's own requests only has no Employee column and no search:
 * every line would say the same name.
 */
function RequestsTab({ query, onApprove, onReject, onWithdraw, onReverse, myEmployeeId, deciding = null, note = null, emptyText = 'No leave requests found.', tiles = true, title = null, othersPossible = true }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const requests = query.data ?? NO_REQUESTS
  // Figures only from a list the server actually sent — counted from a failed
  // one they would be zeros nobody reported.
  const known = query.data !== undefined && !query.isError
  const own = (r) => Boolean(myEmployeeId) && r.employee_id === myEmployeeId
  // An empty list says nothing about whose it is: then whether this login could see anybody else's decides.
  const selfOnly = known && (requests.length > 0 ? requests.every(own) : !othersPossible)

  // The types in this list, by name — the company's own, not a guess. Every
  // part's, for an application in parts.
  const types = useMemo(() => {
    const byCode = new Map()
    for (const r of requests) for (const p of r.parts ?? [r]) byCode.set(p.leave_type, p.leave_type_name)
    return [...byCode.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [requests])

  const filtered = useMemo(() => requests.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (typeFilter !== 'all' && !leaveCodesOf(r).includes(typeFilter)) return false
    if (search.trim()) {
      const q = search.toLowerCase()
      const name = (r.full_name || '').toLowerCase()
      const code = (r.employee_code || '').toLowerCase()
      if (!name.includes(q) && !code.includes(q)) return false
    }
    return true
  }), [requests, statusFilter, typeFilter, search])

  const counts = useMemo(() => ({
    pending: requests.filter((r) => r.status === 'pending').length,
    approved: requests.filter((r) => r.status === 'approved').length,
    rejected: requests.filter((r) => r.status === 'rejected').length,
  }), [requests])

  const actions = (req) => (
    <RowActions req={req} own={own(req)} deciding={deciding} onApprove={onApprove} onReject={onReject} onWithdraw={onWithdraw} onReverse={onReverse} />
  )

  return (
    <div className="space-y-4">
      {note}

      {tiles && (
        <div className="grid grid-cols-3 gap-2 sm:gap-3">
          {[
            { key: 'pending', label: 'Pending', icon: Clock, tone: 'warn' },
            { key: 'approved', label: 'Approved', icon: CheckCircle, tone: 'ok' },
            { key: 'rejected', label: 'Rejected', icon: XCircle, tone: 'bad' },
          ].map((tile) => (
            <StatTile key={tile.key} label={tile.label} value={known ? counts[tile.key] : '—'} icon={tile.icon} tone={tile.tone}
              onClick={() => setStatusFilter(statusFilter === tile.key ? 'all' : tile.key)} active={statusFilter === tile.key} />
          ))}
        </div>
      )}

      <div className={`${card} overflow-hidden`}>
        <div className="px-4 py-3 flex flex-wrap gap-2.5 items-center border-b border-gray-200">
          {selfOnly ? (
            <p className="text-sm font-bold text-gray-900 flex-1">{title ?? 'My leave requests'}</p>
          ) : (
            <label className="relative flex-1 min-w-48">
              <span className="sr-only">Search by employee</span>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
              <input type="text" placeholder="Search employee…" value={search} onChange={(e) => setSearch(e.target.value)} className={`w-full pl-9 ${field}`} />
            </label>
          )}
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} aria-label="Leave type" className={`${field} flex-1 sm:flex-none`}>
            <option value="all">All Types</option>
            {types.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
          {/* Scrolls sideways on a phone rather than pushing the page wider. */}
          <div className="w-full sm:w-auto flex gap-1.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden" role="group" aria-label="Status">
            {STATUS_FILTER.map((s) => (
              <button key={s} type="button" onClick={() => setStatusFilter(s)} aria-pressed={statusFilter === s}
                className={`shrink-0 h-8 px-3 rounded-full text-[12.5px] font-semibold border transition-colors capitalize
                  ${statusFilter === s ? 'bg-gray-900 border-gray-900 text-white' : 'bg-white border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                {s === 'all' ? 'All' : s}
              </button>
            ))}
          </div>
        </div>

        {/* A computer: the table. */}
        <div className="hidden md:block overflow-x-auto">
          <table className="w-full min-w-175">
            <thead>
              <tr>
                {!selfOnly && <th className={`${th} pl-5`}>Employee</th>}
                <th className={`${th} ${selfOnly ? 'pl-5' : ''}`}>Leave Type</th>
                <th className={th}>Duration</th>
                <th className={th}>Applied On</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right pr-5`}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Empty means none match the filters — and only once the list has
                  loaded; a list that failed shows the error instead. */}
              <DataRows query={query} colSpan={selfOnly ? 5 : 6} empty={emptyText} isEmpty={() => filtered.length === 0}>
                {() => filtered.map((req) => (
                  <tr key={req.id} className="hover:bg-gray-50 transition-colors">
                    {!selfOnly && (
                      <td className={`${td} pl-5`}>
                        <div className="flex items-center gap-3">
                          <Avatar name={req.full_name} size="sm" />
                          <div className="min-w-0">
                            <p className="text-sm font-semibold text-gray-900">{req.full_name}</p>
                            <p className="text-xs text-gray-400">{[req.employee_code, req.department].filter(Boolean).join(' · ')}</p>
                          </div>
                        </div>
                      </td>
                    )}
                    <td className={`${td} ${selfOnly ? 'pl-5' : ''}`}><TypeChip req={req} /></td>
                    <td className={td}>
                      <p className="font-semibold text-gray-900 whitespace-nowrap">{formatDay(req.from_date, { year: false })} – {formatDay(req.to_date)}</p>
                      <p className="text-xs text-gray-400">{plural(req.days, 'working day')}</p>
                      <div className="max-w-72 mt-1"><TeamAway req={req} /></div>
                    </td>
                    <td className={td}><Applied req={req} /></td>
                    <td className={td}><StatusCell req={req} /></td>
                    <td className={`${td} pr-5`}><div className="flex items-center justify-end gap-2">{actions(req)}</div></td>
                  </tr>
                ))}
              </DataRows>
            </tbody>
          </table>
        </div>

        {/* A phone: one card a request, its buttons under it. */}
        <div className="md:hidden">
          <DataState query={query} empty={emptyText} isEmpty={() => filtered.length === 0}>
            {() => (
              <ul className="divide-y divide-gray-100" aria-label="Leave requests">
                {filtered.map((req) => (
                  <li key={req.id} className="px-4 py-3.5 space-y-2">
                    {!selfOnly && (
                      <div className="flex items-center gap-2.5">
                        <Avatar name={req.full_name} size="sm" />
                        <p className="text-sm font-semibold text-gray-900 truncate">{req.full_name}</p>
                      </div>
                    )}
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <TypeChip req={req} />
                        <p className="text-sm font-semibold text-gray-900 mt-1.5">{formatDay(req.from_date, { year: false })} – {formatDay(req.to_date)}</p>
                        <p className="text-xs text-gray-500">{plural(req.days, 'working day')}{req.reason ? ` · ${req.reason}` : ''}</p>
                      </div>
                      <StatusCell req={req} />
                    </div>
                    <TeamAway req={req} />
                    <div className="flex flex-wrap items-center gap-2 *:flex-1">{actions(req)}</div>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </div>

        {known && (
          <div className="px-4 sm:px-5 py-3 border-t border-gray-100 text-xs text-gray-500">
            Showing {filtered.length} of {plural(requests.length, 'request')}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * The type, as a chip in its colour — unpaid leave in its own, so a pay cut is
 * seen. An application in parts (client, 9 Oct 2026) shows each part with its
 * days: "Casual Leave · 1" and "Loss of Pay · 2".
 */
function TypeChip({ req }) {
  const chip = (p, days) => (
    <span key={p.id ?? p.leave_type} className={`inline-flex items-center h-5.5 px-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap ${typeColourOf(p.leave_type, p.is_paid)}`}>
      {p.leave_type_name}{days != null ? ` · ${days}` : ''}{p.is_paid === false && days == null ? ' · unpaid' : ''}
    </span>
  )
  if (req.parts?.length > 1) {
    return <span className="inline-flex flex-wrap items-center gap-1" aria-label={leaveLabel(req)}>{req.parts.map((p) => chip(p, p.days))}</span>
  }
  return chip(req, null)
}

function Applied({ req }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  return (
    <>
      <p className="text-gray-600 whitespace-nowrap">{formatDayOf(req.applied_on, timezone)}</p>
      {req.reason && <p className="text-xs text-gray-400 truncate max-w-40" title={req.reason}>{req.reason}</p>}
    </>
  )
}

function StatusCell({ req }) {
  const meta = STATUS_META[req.status] ?? STATUS_META.cancelled
  return (
    <div className="shrink-0">
      <Chip tone={meta.tone}>{meta.label}</Chip>
      {/* Who decides it, from the company tree — said wherever the decision is not the caller's. */}
      {req.status === 'pending' && !req.can_decide && req.decided_by && (
        <p className="text-xs text-gray-400 mt-1">Goes to {req.decided_by}</p>
      )}
    </div>
  )
}

/**
 * The buttons the server says this caller may use. Nobody decides their own
 * leave: their own pending request can only be withdrawn. (The owner may
 * settle their own request from before they were marked.)
 */
function RowActions({ req, own, deciding, onApprove, onReject, onWithdraw, onReverse }) {
  if (own && req.status === 'pending' && !req.can_decide) {
    return <button type="button" onClick={() => onWithdraw(req)} className={btn.secondarySm}><Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> Withdraw</button>
  }
  if (req.can_decide) {
    const standing = req.as_backup ? `Standing in for ${req.decided_by}` : undefined
    return (
      <>
        <button type="button" onClick={() => onApprove(req.id)} disabled={deciding === req.id} title={standing} className={btn.okSm}>
          <CheckCircle className="w-3.5 h-3.5" aria-hidden="true" /> Approve
        </button>
        <button type="button" onClick={() => onReject(req.id)} disabled={deciding === req.id} title={standing} className={btn.dangerSm}>
          <XCircle className="w-3.5 h-3.5" aria-hidden="true" /> Reject
        </button>
      </>
    )
  }
  if (req.can_reverse) {
    return <button type="button" onClick={() => onReverse(req)} className={btn.secondarySm}><Undo2 className="w-3.5 h-3.5" aria-hidden="true" /> Reverse</button>
  }
  if (req.status === 'pending') return <span className="text-xs text-amber-600 font-semibold">Pending Approval</span>
  return <span className="text-xs text-gray-400 italic">No action</span>
}

// ─── Leave Balance tab ────────────────────────────────────────────────────────

/**
 * Leave balances for whoever is signed in.
 *
 * Every figure comes from the server, including the quota: the bars used to
 * be a percentage of hardcoded quotas nobody had configured. This tab is the
 * person's own; everybody's is the Team Balances tab, for whoever decides
 * leave, with the year's grant and corrections for HR.
 *
 * A type with nothing in it — granted as needed, and none granted yet — is
 * named once at the foot rather than drawn as a ring of 0 of 0.
 */
function BalanceTab() {
  // No arguments: the server decides whose balances these are. Passing a user
  // id from the browser was never a filter, only a suggestion — see §A11.
  const balances = useLeaveBalances()
  // The type whose statement is open — every movement in its balance (client, 10 Oct 2026).
  const [statementOf, setStatementOf] = useState(null)
  const statementButton = (b) => (
    <button type="button" onClick={() => setStatementOf(b)} aria-label={`${b.name} statement`}
      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline">
      <ScrollText className="w-3.5 h-3.5" aria-hidden="true" />Statement
    </button>
  )

  return (
    <>
    {statementOf && <StatementDialog leaveTypeId={statementOf.leave_type_id} title={`${statementOf.name} — statement`} onClose={() => setStatementOf(null)} />}
    <DataState query={balances} empty={<Card><EmptyState icon={Gift} title="No leave types are configured yet." /></Card>}>
      {(list) => {
        // Unpaid with no limit (Loss of Pay) has no balance: it is its own card, with the days taken.
        const unlimited = list.filter((b) => b.unlimited)
        const counted = list.filter((b) => !b.unlimited)
        const empty = (b) => !(b.annual_quota > 0) && !(b.balance > 0) && !(b.available > 0) && !(b.pending > 0)
        const shown = counted.filter((b) => !empty(b))
        const none = counted.filter(empty)
        return (
          <div className="space-y-4">
            {shown.length === 0 && (
              <Card><EmptyState icon={Gift} title="No leave to take yet">Your leave for the year has not been given.</EmptyState></Card>
            )}
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shown.map((b, index) => {
                // Against the quota the SERVER reports. A quota of zero means the
                // type is granted rather than accrued — comp off, work from home.
                const quota = b.annual_quota ?? 0
                const colour = RING_COLOURS[index % RING_COLOURS.length]
                return (
                  <section key={b.leave_type_id} className={`${card} p-4 flex items-center gap-4`} aria-label={b.name}>
                    {quota > 0 ? (
                      <Ring value={b.available} total={Math.max(quota, b.available)} size={84} stroke={9} color={colour} label={`${b.available} of ${quota} days available`}>
                        <span><b className="block text-xl font-extrabold tabular-nums">{b.available}</b><span className="block text-[10px] font-semibold text-gray-500">available</span></span>
                      </Ring>
                    ) : (
                      <span className="w-21 h-21 rounded-full bg-gray-50 grid place-items-center shrink-0" style={{ color: colour }}>
                        <span className="text-center"><Sparkles className="w-5 h-5 mx-auto" aria-hidden="true" /><b className="block text-lg font-extrabold tabular-nums text-gray-900">{b.available}</b></span>
                      </span>
                    )}
                    <div className="min-w-0 space-y-1.5">
                      <div>
                        <p className="text-[15px] font-bold text-gray-900">{b.name}</p>
                        <p className="text-xs text-gray-500">{quota > 0 ? `${b.code} · ${quota} days a year` : `${b.code} · granted as needed, not accrued`}</p>
                      </div>
                      {b.pending > 0 && (
                        // Shown separately because it is a different fact: these
                        // days are not spent, they are spoken for.
                        <Chip tone="warn">{plural(b.pending, 'day')} awaiting approval</Chip>
                      )}
                      {/* Earned a twelfth a month (client §36): what is granted but not earned yet. */}
                      {b.unearned > 0 && (
                        <p className="text-xs text-indigo-700">{plural(b.unearned, 'more day')} earned through the year, a month at a time</p>
                      )}
                      {statementButton(b)}
                    </div>
                  </section>
                )
              })}
            </div>
            {unlimited.length > 0 && (
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {unlimited.map((b) => (
                  <section key={b.leave_type_id} className={`${card} p-4 flex items-center gap-4 border-amber-200`} aria-label={b.name}>
                    <span className="w-14 h-14 rounded-full bg-amber-50 ring-1 ring-amber-200 grid place-items-center shrink-0">
                      <b className="text-lg font-extrabold tabular-nums text-amber-900">{b.taken}</b>
                    </span>
                    <div className="min-w-0 space-y-1">
                      <p className="text-[15px] font-bold text-gray-900">{b.name}</p>
                      <p className="text-xs text-gray-600">{b.code} · unpaid, no limit · {plural(b.taken, 'day')} taken this year</p>
                      <p className="text-xs text-amber-800">Each day is cut from pay. It needs approval like any leave.</p>
                      {b.pending > 0 && <Chip tone="warn">{plural(b.pending, 'day')} awaiting approval</Chip>}
                      {statementButton(b)}
                    </div>
                  </section>
                ))}
              </div>
            )}
            {none.length > 0 && (
              <p className="text-xs text-gray-500">{none.map((b) => b.name).join(', ')} {none.length === 1 ? 'is' : 'are'} granted as needed; {none.length === 1 ? 'it shows' : 'they show'} here once you have days in {none.length === 1 ? 'it' : 'them'}.</p>
            )}
          </div>
        )
      }}
    </DataState>
    </>
  )
}

// ─── Holidays tab ─────────────────────────────────────────────────────────────

/**
 * The holiday calendar, for everybody who applies for leave. Every holiday is
 * PUBLIC or OPTIONAL (weekly-off rows are older entries); dates are read as
 * calendar days, never in the browser's zone, which moves them a day west of
 * India.
 */
function HolidaysTab() {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const today = calendarDayIn(timezone)
  const thisYear = Number(today.slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const holidays = useHolidays(year)
  // Counted only from a year the server sent: a failed one is not "0 holidays".
  const list = holidays.isError ? undefined : holidays.data

  const upcoming = (list ?? []).filter((h) => h.date >= today)
  const past = (list ?? []).filter((h) => h.date < today)
  const hasOptional = (list ?? []).some((h) => h.type === 'optional')

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Segmented label="Year" value={year} onChange={setYear}
          items={[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ key: y, label: String(y) }))} />
        {/* While loading, the list below says so; saying it twice is noise. */}
        {list && <p className="text-xs font-medium text-gray-500">{plural(list.length, 'holiday')} in {year}</p>}
      </div>

      <DataState query={holidays} empty={<Card><EmptyState icon={Gift} title={`No holidays have been entered for ${year}.`} /></Card>}>
        {() => (
          <>
            {hasOptional && (
              <p className="text-xs text-gray-500">An optional holiday is not a day off by itself — apply for leave to take one.</p>
            )}
            {upcoming.length > 0 && (
              <Card title="Upcoming" bodyClassName="p-2 pt-1">
                <ul className="divide-y divide-gray-50">
                  {upcoming.map((h, i) => <HolidayRow key={h.id} holiday={h} next={i === 0} />)}
                </ul>
              </Card>
            )}
            {past.length > 0 && (
              <Card title="Past holidays" bodyClassName="p-2 pt-1">
                <ul className="divide-y divide-gray-50">
                  {past.map((h) => <HolidayRow key={h.id} holiday={h} past />)}
                </ul>
              </Card>
            )}
          </>
        )}
      </DataState>
    </div>
  )
}

/** A calendar day's parts, read in UTC so no browser zone can move the day. */
function dayParts(day) {
  const d = new Date(`${day}T00:00:00Z`)
  return {
    // "Sep", from the app's one month table — the browser's says "Sept".
    month: formatDay(day, { year: false }).split(' ')[1],
    date: d.getUTCDate(),
    weekday: d.toLocaleString('en-IN', { weekday: 'long', timeZone: 'UTC' }),
  }
}

function HolidayRow({ holiday, next = false, past = false }) {
  const meta = HOLIDAY_TYPE[holiday.type] ?? { tone: 'gray', label: holiday.type }
  const { month, date, weekday } = dayParts(holiday.date)

  return (
    <li className={`flex items-center gap-4 px-2 py-3 rounded-lg ${past ? 'opacity-60' : ''} ${next ? 'bg-brand-50/50' : ''}`}>
      <div className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 ${next ? 'bg-logo text-white' : 'bg-gray-100 text-gray-900'}`}>
        <span className={`text-[10px] font-bold uppercase ${next ? 'text-white/85' : 'text-gray-500'}`}>{month}</span>
        <span className="text-lg font-extrabold leading-none">{date}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-gray-900">{holiday.name}</p>
        <p className="text-xs text-gray-500 mt-0.5">{weekday}{next ? ' · next' : ''}</p>
      </div>
      <Chip tone={meta.tone} dot={false}>{meta.label}</Chip>
    </li>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Leave() {
  // Who sees Approve and Reject is the company tree (Day 22), not a role: the
  // server says on every request whether the caller decides it. Somebody with
  // people under them gets Team Requests whatever their role's leave rights —
  // an Accounts head approves the accountant's leave.
  const readsLeave = useAuthStore((state) => state.can('leave:read'))
  const decidesLeave = useAuthStore((state) => state.decidesLeave)
  // Leave belongs to an employee record. An account without one — the Super
  // Admin the installer creates is the usual case — has no balance and cannot
  // apply, and asking the server anyway put an error on screen every time this
  // page opened.
  const hasEmployee = useAuthStore((state) => Boolean(state.profile))
  const canApply = useAuthStore((state) => state.can('leave:apply')) && hasEmployee
  // Everybody's balances: for whoever corrects them, and for whoever decides
  // leave and may see it — the leave scope narrows a manager to their team.
  const seesTeam = useAuthStore((state) => state.can('leave:balance:manage')) || (decidesLeave && readsLeave)
  const tabs = TABS.filter((t) => {
    if (t === 'decide') return decidesLeave
    if (t === 'team') return seesTeam
    if (t === 'balance') return hasEmployee && readsLeave
    return readsLeave
  })
  // Same: scoping moved to the server. HR sees the company, a manager their
  // direct reports, an employee their own.
  const requests = useLeaveRequests({}, { enabled: readsLeave })
  const team = useTeamLeave({ enabled: decidesLeave })
  const updateLeaveStatus = useUpdateLeaveStatus()
  const applyLeave = useApplyLeave()
  const withdrawLeave = useWithdrawLeave()
  const reverseLeave = useReverseLeave()
  const myEmployeeId = useAuthStore((state) => state.profile?.id ?? null)
  // ?tab=decide opens Team Requests — the link a "waiting for you" notice
  // carries. Read from the address every time, not once: a notice clicked
  // while Leave is already open changes the address, not the page.
  const [params, setParams] = useSearchParams()
  const chosenTab = params.get('tab')
  const setTab = (next) => setParams((current) => {
    const p = new URLSearchParams(current)
    p.set('tab', next)
    return p
  }, { replace: true })
  // The first tab there is, unless one was chosen — an Accounts head with a
  // team has Team Requests and nothing else.
  const tab = chosenTab && tabs.includes(chosenTab) ? chosenTab : tabs[0]
  const [applyOpen, setApplyOpen] = useState(false)
  const [withdrawing, setWithdrawing] = useState(null)
  const [reversing, setReversing] = useState(null)
  const [reverseNote, setReverseNote] = useState('')

  // "Apply leave" from the home page or the search (?apply=1) opens the form —
  // once per link, followed while this page is already open. An absent day's
  // "Apply leave" (client, 10 Oct 2026) brings its dates too (&from=&to=): the
  // form opens on them.
  const applyLink = `${params.get('apply') ?? ''}|${params.get('from') ?? ''}|${params.get('to') ?? ''}`
  const [followedApply, setFollowedApply] = useState(null)
  const [applyDates, setApplyDates] = useState(null)
  if (applyLink !== followedApply) {
    setFollowedApply(applyLink)
    if (params.get('apply') === '1' && canApply) {
      // A real day: 2026-02-31 has the shape, and no date input can show it.
      const isDay = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v ?? '') && addDays(v, 0) === v
      const from = params.get('from')
      const to = params.get('to') ?? from
      setApplyDates(isDay(from) && isDay(to) && to >= from ? { from_date: from, to_date: to } : null)
      setApplyOpen(true)
    }
  }
  // The link opened on a login that applies for nobody's leave — a role login beside the person's own (Day 23).
  const applyElsewhere = params.get('apply') === '1' && !canApply
  useEffect(() => {
    if (applyElsewhere) toast.info('Leave is applied for from your own employee login.', { id: 'apply-elsewhere' })
  }, [applyElsewhere])
  const closeApply = () => {
    setApplyOpen(false)
    setApplyDates(null)
    // The link is done with, so a reload does not open the form again.
    if (params.get('apply')) setParams((p) => { p.delete('apply'); p.delete('from'); p.delete('to'); return p }, { replace: true })
  }

  // Only the id and the decision. Who decided is whoever is signed in, which
  // the server knows; the client does not get to say who approved something.
  function handleApprove(id) {
    updateLeaveStatus.mutate({ id, status: 'approved' })
  }
  // The request a decision is on its way for, if any.
  const deciding = updateLeaveStatus.isPending ? (updateLeaveStatus.variables?.id ?? null) : null

  function handleReject(id) {
    updateLeaveStatus.mutate({ id, status: 'rejected' })
  }

  // Returned, not fired and forgotten: the modal stays open until the server
  // has accepted the request, so a refusal does not throw away what was typed.
  // No employee id: the server applies for whoever is signed in.
  function handleApply(data) {
    return applyLeave.mutateAsync(data)
  }

  // Null until the list has loaded: a list that failed is not "all requests
  // are up to date". Counted from the requests the caller decides: HR sees
  // every request, and is waited on for none of them.
  const pendingCount = (() => {
    if (decidesLeave) {
      if (team.data === undefined || team.isError) return null
      return team.data.requests.filter((r) => r.status === 'pending' && r.can_decide).length
    }
    return null
  })()
  const backupCount = team.data?.backup?.length ?? 0
  const openReverse = (req) => { setReverseNote(''); setReversing(req) }

  return (
    <>
      <PageHeader
        title="Leave"
        subtitle={pendingCount === null ? null
          : pendingCount > 0
            ? <span className="text-amber-700 font-semibold">{plural(pendingCount, 'request')} waiting for you</span>
            : 'Nothing is waiting for you'}
        actions={canApply && (
          <button onClick={() => setApplyOpen(true)} className={btn.primary}>
            <Plus className="w-4 h-4" aria-hidden="true" />Apply for Leave
          </button>
        )}
        tabs={tabs.map((t) => ({ key: t, label: TAB_LABELS[t], count: t === 'decide' ? pendingCount ?? 0 : 0 }))}
        tab={tab}
        onTab={setTab}
        panelId="leave-panel"
      />

      <TabPanel id="leave-panel" tab={tabs.length > 1 ? tab : null}>
      {tab === 'requests' && (
        <RequestsTab query={requests} onApprove={handleApprove} onReject={handleReject}
          onWithdraw={setWithdrawing} onReverse={openReverse}
          myEmployeeId={myEmployeeId} deciding={deciding} othersPossible={decidesLeave || seesTeam || !hasEmployee} />
      )}
      {tab === 'decide' && (
        <div className="space-y-8">
          <RequestsTab query={{ ...team, data: team.data?.requests }} onApprove={handleApprove} onReject={handleReject}
            onWithdraw={setWithdrawing} onReverse={openReverse}
            myEmployeeId={myEmployeeId} deciding={deciding}
            emptyText="Nobody whose leave you decide has asked for any."
            note={
              <p className="text-sm text-gray-600">
                The leave of the people who report to you in the company tree. You decide it whatever your role.
              </p>
            } />
          {backupCount > 0 && (
            <RequestsTab query={{ ...team, data: team.data?.backup }} onApprove={handleApprove} onReject={handleReject}
              onWithdraw={setWithdrawing} onReverse={openReverse}
              myEmployeeId={myEmployeeId} deciding={deciding} tiles={false}
              note={
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                  <p className="text-sm font-semibold text-amber-900">Waiting for somebody else — you may stand in</p>
                  <p className="text-sm text-amber-800 mt-0.5">
                    These are other managers&rsquo; to decide. Settings → Approvals lets you decide instead when they are away; the log records that you stood in.
                  </p>
                </div>
              } />
          )}
        </div>
      )}
      {tab === 'team' && seesTeam && <TeamBalances />}
      {tab === 'balance' && hasEmployee && <BalanceTab />}
      {tab === 'holidays' && <HolidaysTab />}
      </TabPanel>
      {tabs.length === 0 && (
        <Card><EmptyState icon={Gift} title="Nothing here for this login">Your role does not read leave.</EmptyState></Card>
      )}

      {withdrawing && (
        <ConfirmDialog title="Withdraw this leave request?" confirmLabel="Withdraw" danger
          onConfirm={() => withdrawLeave.mutateAsync({ id: withdrawing.id }).then(() => toast.success('Leave request withdrawn'))}
          onClose={() => setWithdrawing(null)}>
          <p>
            <strong>{leaveLabel(withdrawing)}</strong>, {formatDay(withdrawing.from_date)} to {formatDay(withdrawing.to_date)} ({plural(withdrawing.days, 'working day')}).
          </p>
          {withdrawing.parts?.length > 1 && <p>Both parts of this application are withdrawn together.</p>}
          <p>It has not been decided yet, so nothing has been taken from the balance. The approvers are told it was withdrawn.</p>
        </ConfirmDialog>
      )}

      {reversing && (
        <ConfirmDialog title={`Reverse ${reversing.full_name}’s approved leave?`} confirmLabel="Reverse leave" danger
          onConfirm={() => reverseLeave.mutateAsync({ id: reversing.id, note: reverseNote.trim() || undefined }).then(() => toast.success(
            (reversing.parts ?? [reversing]).some((p) => p.is_paid !== false) ? 'Leave reversed; the days are back in the balance' : 'Leave reversed; those days are no longer cut from pay'))}
          onClose={() => setReversing(null)}>
          <p>
            <strong>{leaveLabel(reversing)}</strong>, {formatDay(reversing.from_date)} to {formatDay(reversing.to_date)}: {reverseWords(reversing)} The leave days on their attendance are removed.
          </p>
          {reversing.parts?.length > 1 && <p>Both parts of this application are reversed together.</p>}
          <p>A month whose payroll is already approved cannot be changed; if this leave falls in one, it is refused and says so.</p>
          <label className="block text-xs font-semibold text-gray-600 space-y-1 pt-1">
            <span>Why (optional — {reversing.full_name} sees this)</span>
            <input type="text" value={reverseNote} onChange={(e) => setReverseNote(e.target.value)} maxLength={500} className={`w-full ${field}`} />
          </label>
        </ConfirmDialog>
      )}

      {/* Mounted only while open, so its balance lookup runs when somebody applies, not on every visit. */}
      {applyOpen && (
        // Keyed by the link: a second absent day's link while the form is open starts it afresh on that day.
        <ApplyLeaveModal key={followedApply ?? 'open'} open onClose={closeApply} onSave={handleApply} saving={applyLeave.isPending} initialDates={applyDates} />
      )}
    </>
  )
}
