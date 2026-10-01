import { createElement, useState, useMemo } from 'react'
import { toast } from 'sonner'
import {
  CheckCircle, XCircle, Clock, CalendarDays, Plus,
  Search, ChevronRight, Palmtree, Filter, Undo2, Ban, Users,
} from 'lucide-react'
import ApplyLeaveModal from '../features/leave/ApplyLeaveModal'
import TeamBalances from '../features/leave/TeamBalances'
import { useLeaveRequests, useLeaveBalances, useHolidays, useApplyLeave, useUpdateLeaveStatus, useWithdrawLeave, useReverseLeave } from '../hooks/useLeave'
import { useAuthStore } from '../stores/authStore'
import { calendarDayIn, formatDay, formatDayOf } from '../lib/dates'
import { typeColourOf } from '../lib/leaveTypes'
import DataState, { DataRows } from '../components/DataState'
import ConfirmDialog from '../components/ConfirmDialog'

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
  pending: { label: 'Pending', cls: 'bg-amber-100 text-amber-700', icon: Clock },
  approved: { label: 'Approved', cls: 'bg-green-100 text-green-700', icon: CheckCircle },
  rejected: { label: 'Rejected', cls: 'bg-red-100 text-red-600', icon: XCircle },
  cancelled: { label: 'Cancelled', cls: 'bg-gray-100 text-gray-600', icon: Ban },
}

/** The types the server sends. weekly_off appears only on older rows. */
const HOLIDAY_TYPE = {
  public: { cls: 'bg-green-100 text-green-700', label: 'Public' },
  optional: { cls: 'bg-purple-100 text-purple-700', label: 'Optional' },
  weekly_off: { cls: 'bg-gray-100 text-gray-600', label: 'Weekly off' },
}


const TABS = ['requests', 'team', 'balance', 'holidays']
const TAB_LABELS = { requests: 'Leave Requests', team: 'Team Balances', balance: 'Leave Balance', holidays: 'Holiday Calendar' }
const STATUS_FILTER = ['all', 'pending', 'approved', 'rejected', 'cancelled']

// ─── Leave Requests tab ───────────────────────────────────────────────────────

function initials(name) {
  return (name || '').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
}

/** One empty list, so the filters below are not recomputed on every render. */
const NO_REQUESTS = []

function RequestsTab({ query, onApprove, onReject, onWithdraw, onReverse, isManagement, myEmployeeId }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('all')

  const requests = query.data ?? NO_REQUESTS
  // Figures only from a list the server actually sent — counted from a failed
  // one they would be zeros nobody reported.
  const known = query.data !== undefined && !query.isError

  // The types in this list, by name — the company's own, not a guess.
  const types = useMemo(() => {
    const byCode = new Map()
    for (const r of requests) byCode.set(r.leave_type, r.leave_type_name)
    return [...byCode.entries()].sort((a, b) => a[1].localeCompare(b[1]))
  }, [requests])

  const filtered = useMemo(() => requests.filter((r) => {
    if (statusFilter !== 'all' && r.status !== statusFilter) return false
    if (typeFilter !== 'all' && r.leave_type !== typeFilter) return false
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

  return (
    <div className="space-y-4">

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { key: 'pending', label: 'Pending', Icon: Clock, bg: 'bg-amber-100', text: 'text-amber-600' },
          { key: 'approved', label: 'Approved', Icon: CheckCircle, bg: 'bg-green-100', text: 'text-green-600' },
          { key: 'rejected', label: 'Rejected', Icon: XCircle, bg: 'bg-red-100', text: 'text-red-600' },
        ].map(({ key, label, Icon, bg, text }) => (
          <button key={key} onClick={() => setStatusFilter(statusFilter === key ? 'all' : key)}
            className={`bg-white rounded-xl border shadow-sm p-4 flex items-center gap-4 transition-all text-left
              ${statusFilter === key ? 'border-blue-400 ring-1 ring-blue-400' : 'border-gray-200 hover:border-gray-300'}`}>
            <div className={`${bg} rounded-xl p-3 shrink-0`}>
              {createElement(Icon, { className: `w-5 h-5 ${text}` })}
            </div>
            <div>
              <p className="text-2xl font-bold text-gray-900">{known ? counts[key] : '—'}</p>
              <p className="text-sm text-gray-500">{label}</p>
            </div>
          </button>
        ))}
      </div>

      {/* Filters row */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input type="text" placeholder="Search employee…" value={search} onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm
              focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent placeholder:text-gray-400" />
        </div>
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-gray-400" />
          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white">
            <option value="all">All Types</option>
            {types.map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </div>
        <div className="flex gap-1 ml-auto">
          {STATUS_FILTER.map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors capitalize
                ${statusFilter === s ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
              {s === 'all' ? 'All' : s}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-187.5">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200">
                <th className="px-5 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Employee</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Leave Type</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Duration</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Applied On</th>
                <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-5 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {/* Empty means none match the filters — and only once the list has
                  loaded; a list that failed shows the error instead. */}
              <DataRows query={query} colSpan={6} empty="No leave requests found." isEmpty={() => filtered.length === 0}>
                {() => filtered.map((req) => {
                  const stMeta = STATUS_META[req.status] ?? STATUS_META.cancelled
                  const StIcon = stMeta.icon
                  const own = Boolean(myEmployeeId) && req.employee_id === myEmployeeId
                  return (
                    <tr key={req.id} className="border-b border-gray-100 hover:bg-gray-50 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
                            <span className="text-blue-700 text-xs font-semibold">{initials(req.full_name)}</span>
                          </div>
                          <div>
                            <p className="text-sm font-medium text-gray-900">{req.full_name}</p>
                            <p className="text-xs text-gray-400">{[req.employee_code, req.department].filter(Boolean).join(' · ')}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${typeColourOf(req.leave_type)}`}>
                          {req.leave_type_name}
                        </span>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="text-sm text-gray-900">{formatDay(req.from_date, { year: false })} – {formatDay(req.to_date)}</p>
                        <p className="text-xs text-gray-400">{req.days} working day{req.days !== 1 ? 's' : ''}</p>
                      </td>
                      <td className="px-4 py-3.5">
                        <p className="text-sm text-gray-600">{formatDayOf(req.applied_on, timezone)}</p>
                        {req.reason && <p className="text-xs text-gray-400 truncate max-w-36" title={req.reason}>{req.reason}</p>}
                      </td>
                      <td className="px-4 py-3.5">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium ${stMeta.cls}`}>
                          <StIcon className="w-3 h-3" />
                          {stMeta.label}
                        </span>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex items-center justify-end gap-2">
                          {/*
                            Nobody decides their own leave (the server refuses it too):
                            their own pending request can only be withdrawn, and their
                            own approved leave reversed by somebody else.
                          */}
                          {own && req.status === 'pending' ? (
                            <button onClick={() => onWithdraw(req)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium transition-colors">
                              <Undo2 className="w-3.5 h-3.5" /> Withdraw
                            </button>
                          ) : isManagement && req.status === 'pending' ? (
                            <>
                              <button onClick={() => onApprove(req.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-green-50 hover:bg-green-100 text-green-700 text-xs font-medium transition-colors">
                                <CheckCircle className="w-3.5 h-3.5" /> Approve
                              </button>
                              <button onClick={() => onReject(req.id)}
                                className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-600 text-xs font-medium transition-colors">
                                <XCircle className="w-3.5 h-3.5" /> Reject
                              </button>
                            </>
                          ) : isManagement && !own && req.status === 'approved' ? (
                            <button onClick={() => onReverse(req)}
                              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium transition-colors">
                              <Undo2 className="w-3.5 h-3.5" /> Reverse
                            </button>
                          ) : req.status === 'pending' ? (
                            <span className="text-xs text-amber-600 font-medium">Pending Approval</span>
                          ) : (
                            <span className="text-xs text-gray-400 italic">No action</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </DataRows>
            </tbody>
          </table>
        </div>
        {known && (
          <div className="px-5 py-3 border-t border-gray-100">
            <p className="text-xs text-gray-400">Showing {filtered.length} of {requests.length} requests</p>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Leave Balance tab ────────────────────────────────────────────────────────

/**
 * Leave balances for whoever is signed in.
 *
 * TWO THINGS CHANGED HERE, and both were the same bug.
 *
 * The quotas used to be hardcoded — casual 12, earned 18, work-from-home 24 —
 * so the progress bars were a percentage of a number nobody had configured. A
 * company that sets casual leave to fifteen days got bars that were quietly
 * wrong. Every figure below now comes from the server, including the quota.
 *
 * The table also used to list EVERY employee under a heading that said "per
 * employee", while showing only the caller's own numbers. This tab is the
 * person's own; everybody's is the Team Balances tab, for whoever decides
 * leave, with the year's grant and corrections for HR.
 */
function BalanceTab() {
  // No arguments: the server decides whose balances these are. Passing a user
  // id from the browser was never a filter, only a suggestion — see §A11.
  const balances = useLeaveBalances()

  const colours = ['bg-blue-500', 'bg-red-400', 'bg-purple-500', 'bg-teal-500', 'bg-amber-500']

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <p className="text-base font-semibold text-gray-900">My Leave Balance</p>
          <p className="text-xs text-gray-400 mt-0.5">
            Days remaining this leave year, after anything already applied for
          </p>
        </div>

        <DataState query={balances} empty="No leave types are configured yet.">
          {(list) => (
          <div className="p-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((b, index) => {
              // Against the quota the SERVER reports, not a number in this file.
              // A quota of zero means the type is granted rather than accrued —
              // comp off, work from home — and a percentage of zero is not a
              // number worth drawing.
              const quota = b.annual_quota ?? 0
              const pct = quota > 0 ? Math.min(100, Math.round((b.available / quota) * 100)) : null

              return (
                <div key={b.leave_type_id} className="border border-gray-200 rounded-xl p-4 space-y-2.5">
                  <div className="flex items-baseline justify-between">
                    <div>
                      <p className="text-sm font-semibold text-gray-900">{b.name}</p>
                      <p className="text-xs text-gray-400">{b.code}</p>
                    </div>
                    <p className="text-2xl font-bold text-gray-900">{b.available}</p>
                  </div>

                  {pct === null ? (
                    <p className="text-xs text-gray-400">Granted as needed, not accrued</p>
                  ) : (
                    <>
                      <div className="w-full h-1.5 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full ${colours[index % colours.length]} rounded-full`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-gray-400">of {quota} days</p>
                    </>
                  )}

                  {b.pending > 0 && (
                    // Shown separately because it is a different fact: these
                    // days are not spent, they are spoken for. One number that
                    // meant both would mean neither.
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1">
                      {b.pending} day{b.pending === 1 ? '' : 's'} awaiting approval
                    </p>
                  )}
                </div>
              )
            })}
          </div>
          )}
        </DataState>
      </div>
    </div>
  )
}


/**
 * The holiday calendar, for everybody who applies for leave.
 *
 * It used to look types up in a table of national / festival / regional —
 * names the server has never sent. Every holiday is PUBLIC or OPTIONAL, so the
 * lookup came back empty and reading `.cls` off it took the whole Leave page
 * down the moment the tab opened. It also showed every year under a heading
 * that said 2026, and read dates in the browser's zone, which moves them a day
 * west of India.
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
    <div className="space-y-5">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p className="text-base font-semibold text-gray-900">Holiday Calendar — {year}</p>
            {/* While loading, the list below says so; saying it twice is noise. */}
            <p className="text-xs text-gray-400 mt-0.5">
              {list && `${list.length} holiday${list.length === 1 ? '' : 's'}`}
            </p>
          </div>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {[thisYear - 1, thisYear, thisYear + 1].map((y) => (
              <button key={y} type="button" onClick={() => setYear(y)}
                className={`px-3 py-1.5 text-sm font-medium ${y === year ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {y}
              </button>
            ))}
          </div>
        </div>

        <DataState query={holidays} empty={
          <p className="px-5 py-8 text-sm text-gray-500 text-center">No holidays have been entered for {year}.</p>
        }>
          {hasOptional && (
            <p className="px-5 py-2.5 text-xs text-gray-500 border-b border-gray-100">
              An optional holiday is not a day off by itself — apply for leave to take one.
            </p>
          )}

          {upcoming.length > 0 && (
            <>
              <div className="px-5 py-3 bg-blue-50 border-b border-blue-100">
                <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider">Upcoming</p>
              </div>
              <div className="divide-y divide-gray-50">
                {upcoming.map((h, i) => <HolidayRow key={h.id} holiday={h} next={i === 0} />)}
              </div>
            </>
          )}

          {past.length > 0 && (
            <>
              <div className="px-5 py-3 bg-gray-50 border-y border-gray-100">
                <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Past Holidays</p>
              </div>
              <div className="divide-y divide-gray-50">
                {past.map((h) => <HolidayRow key={h.id} holiday={h} past />)}
              </div>
            </>
          )}
        </DataState>
      </div>
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
  const meta = HOLIDAY_TYPE[holiday.type] ?? { cls: 'bg-gray-100 text-gray-600', label: holiday.type }
  const { month, date, weekday } = dayParts(holiday.date)

  return (
    <div className={`flex items-center gap-4 px-5 ${past ? 'py-3.5 opacity-50 hover:opacity-70' : 'py-4 hover:bg-gray-50'} ${next ? 'bg-blue-50/40' : ''} transition-colors`}>
      <div className={`w-12 h-12 rounded-xl flex flex-col items-center justify-center shrink-0 ${next ? 'bg-blue-600' : 'bg-gray-100'}`}>
        <span className={`text-xs font-medium ${next ? 'text-blue-100' : 'text-gray-500'}`}>{month}</span>
        <span className={`text-lg font-bold leading-none ${next ? 'text-white' : 'text-gray-900'}`}>{date}</span>
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900">{holiday.name}</p>
        <p className="text-xs text-gray-400 mt-0.5">{weekday}</p>
      </div>
      <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${meta.cls}`}>{meta.label}</span>
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Leave() {
  // Who sees Approve and Reject is a PERMISSION, not a list of role names. The
  // list this replaced included admin, whom the client's matrix bars from leave
  // decisions — so admin got buttons that could only ever return 403.
  const isManagement = useAuthStore((state) => state.can('leave:approve'))
  // Leave belongs to an employee record. An account without one — the Super
  // Admin the installer creates is the usual case — has no balance and cannot
  // apply, and asking the server anyway put an error on screen every time this
  // page opened.
  const hasEmployee = useAuthStore((state) => Boolean(state.profile))
  const canApply = useAuthStore((state) => state.can('leave:apply')) && hasEmployee
  // Everybody's balances go with deciding leave; the scope narrows a manager to their team.
  const seesTeam = isManagement
  const tabs = TABS.filter((t) => (t !== 'balance' || hasEmployee) && (t !== 'team' || seesTeam))
  // Same: scoping moved to the server. HR sees the company, a manager their
  // direct reports, an employee their own.
  const requests = useLeaveRequests()
  const updateLeaveStatus = useUpdateLeaveStatus()
  const applyLeave = useApplyLeave()
  const withdrawLeave = useWithdrawLeave()
  const reverseLeave = useReverseLeave()
  const myEmployeeId = useAuthStore((state) => state.profile?.id ?? null)
  const [tab, setTab] = useState('requests')
  const [applyOpen, setApplyOpen] = useState(false)
  const [withdrawing, setWithdrawing] = useState(null)
  const [reversing, setReversing] = useState(null)
  const [reverseNote, setReverseNote] = useState('')

  // Only the id and the decision. Who decided is whoever is signed in, which
  // the server knows; the old version sent a reviewer id from the browser, and
  // the client does not get to say who approved something.
  function handleApprove(id) {
    updateLeaveStatus.mutate({ id, status: 'approved' })
  }

  function handleReject(id) {
    updateLeaveStatus.mutate({ id, status: 'rejected' })
  }

  // Returned, not fired and forgotten: the modal stays open until the server
  // has accepted the request, so a refusal does not throw away what was typed.
  //
  // No employee id. This used to send the signed-in USER's id as the employee
  // id — a different table's key — which the server read as applying on
  // somebody else's behalf and refused, for every employee who tried.
  function handleApply(data) {
    return applyLeave.mutateAsync(data)
  }

  // Null until the list has loaded: a list that failed is not "all requests
  // are up to date".
  const pendingCount = requests.data === undefined || requests.isError
    ? null
    : requests.data.filter((r) => r.status === 'pending').length

  return (
    <>
      <div className="space-y-5">

        {/* Header */}
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div>
            <h2 className="text-2xl font-bold text-gray-900">Leave Management</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {pendingCount === null ? null
                : pendingCount > 0
                  ? <span className="text-amber-600 font-medium">{pendingCount} request{pendingCount !== 1 ? 's' : ''} pending approval</span>
                  : 'All requests are up to date'}
            </p>
          </div>
          {canApply && (
            <button onClick={() => setApplyOpen(true)}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium transition-colors">
              <Plus className="w-4 h-4" />
              Apply for Leave
            </button>
          )}
        </div>

        {/* Tabs */}
        {/* Scrolls sideways on a phone rather than pushing the page wider. */}
        <div className="flex items-center gap-1 border-b border-gray-200 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px flex items-center gap-2 whitespace-nowrap shrink-0
                ${tab === t
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}>
              {t === 'requests' && <CalendarDays className="w-4 h-4" />}
              {t === 'team' && <Users className="w-4 h-4" />}
              {t === 'balance' && <ChevronRight className="w-4 h-4" />}
              {t === 'holidays' && <Palmtree className="w-4 h-4" />}
              {TAB_LABELS[t]}
              {t === 'requests' && pendingCount > 0 && (
                <span className="px-1.5 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 font-medium">{pendingCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Tab content */}
        {tab === 'requests' && (
          <RequestsTab query={requests} onApprove={handleApprove} onReject={handleReject}
            onWithdraw={setWithdrawing} onReverse={(req) => { setReverseNote(''); setReversing(req) }}
            isManagement={isManagement} myEmployeeId={myEmployeeId} />
        )}
        {tab === 'team' && seesTeam && <TeamBalances />}
        {tab === 'balance' && hasEmployee && <BalanceTab />}
        {tab === 'holidays' && <HolidaysTab />}
      </div>

      {withdrawing && (
        <ConfirmDialog title="Withdraw this leave request?" confirmLabel="Withdraw" danger
          onConfirm={() => withdrawLeave.mutateAsync({ id: withdrawing.id }).then(() => toast.success('Leave request withdrawn'))}
          onClose={() => setWithdrawing(null)}>
          <p>
            <strong>{withdrawing.leave_type_name}</strong>, {formatDay(withdrawing.from_date)} to {formatDay(withdrawing.to_date)} ({withdrawing.days} working day{withdrawing.days === 1 ? '' : 's'}).
          </p>
          <p>It has not been decided yet, so nothing has been taken from the balance. The approvers are told it was withdrawn.</p>
        </ConfirmDialog>
      )}

      {reversing && (
        <ConfirmDialog title={`Reverse ${reversing.full_name}’s approved leave?`} confirmLabel="Reverse leave" danger
          onConfirm={() => reverseLeave.mutateAsync({ id: reversing.id, note: reverseNote.trim() || undefined }).then(() => toast.success('Leave reversed; the days are back in the balance'))}
          onClose={() => setReversing(null)}>
          <p>
            <strong>{reversing.leave_type_name}</strong>, {formatDay(reversing.from_date)} to {formatDay(reversing.to_date)}: {reversing.days} working day{reversing.days === 1 ? '' : 's'} go back into {reversing.full_name}’s balance, and the leave days on their attendance are removed.
          </p>
          <p>A month whose payroll is already approved cannot be changed; if this leave falls in one, it is refused and says so.</p>
          <label className="block text-xs font-medium text-gray-600 space-y-1 pt-1">
            <span>Why (optional — {reversing.full_name} sees this)</span>
            <input type="text" value={reverseNote} onChange={(e) => setReverseNote(e.target.value)} maxLength={500}
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </label>
        </ConfirmDialog>
      )}

      {/* Mounted only while open, so its balance lookup runs when somebody applies, not on every visit. */}
      {applyOpen && (
        <ApplyLeaveModal open onClose={() => setApplyOpen(false)} onSave={handleApply} saving={applyLeave.isPending} />
      )}
    </>
  )
}
