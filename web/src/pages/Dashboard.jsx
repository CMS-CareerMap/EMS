import { Navigate } from 'react-router-dom'
import { CalendarPlus, FilePlus2, Landmark, Upload, UserPlus, Wallet } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { NAV_GROUPS, ROUTE_PERMISSIONS } from '../config/navigation'
import { roleLabel } from '../lib/roles'
import { useMyDashboardStats, usePayrollSummary, useTodayAtWork } from '../hooks/useDashboard'
import { useTeamLeave } from '../hooks/useLeave'
import { useWaitingRequests } from '../hooks/useRequests'
import { useWaitingResignations } from '../hooks/useLifecycle'
import PunchCard from '../features/attendance/PunchCard'
import HomeBanner from '../features/home/HomeBanner'
import LifecycleCard from '../features/home/LifecycleCard'
import { MyMonthCard, LeaveBalanceCard, MyWeekCard, MyRequestsCard, PayslipCard, MyDocumentsCard } from '../features/home/MyCards'
import { WaitingCard, TodayCard, PendingLeaveCard } from '../features/home/TeamCards'
import { PeopleCard, DocumentsCard, CompanyDocumentsCard, HolidaysCard } from '../features/home/CompanyCards'
import { PayrollRunCard, BankAccountsCard, NextMonthCard, EntriesCard, LoansCard } from '../features/home/PayrollCards'

/**
 * The home page — one page for every login, built from sections, each shown
 * only when the login's permissions open it:
 *
 *   My day            an employee record (Check In when it may punch from the app)
 *   Waiting for you   anything waiting for this login's decision
 *   Today at work     attendance beyond one's own — a team, or the company
 *   Payroll           payroll:structure:read
 *   People            adding staff (employee:create)
 *   Leave waiting     leave:read beyond one's own — others' decisions (HR)
 *   Joining to exit   employee:lifecycle:manage
 *   Documents         document:verify
 *   Holidays          leave:read
 *
 * Never the role's name: a role the Super Admin makes gets the sections its
 * permissions open, with nothing to change here. (The page used to pick one of
 * two dashboards on a single permission — Accounts got no payroll, managers no
 * Check In, Admin a "company" of one.)
 *
 * Since Day 21 a role can be made without "Open the dashboard"; such a login
 * goes on to the first area its role opens.
 */
export default function Dashboard() {
  // Subscribed, so the page follows a role edit at once.
  useAuthStore((state) => state.permissions)
  useAuthStore((state) => state.decidesLeave)
  const holds = useAuthStore((state) => state.canAny)

  if (holds('dashboard:read')) return <Home />

  const first = NAV_GROUPS.flatMap((group) => group.items).find((item) => item.to !== '/dashboard' && holds(item.permission))
  if (first) return <Navigate to={first.to} replace />
  return (
    <div className="max-w-md mx-auto mt-16 text-center space-y-2">
      <h1 className="text-lg font-semibold text-gray-900">Nothing to open yet</h1>
      <p className="text-sm text-gray-500">Your role does not open any part of EMS yet. Ask the Super Admin to give it what you need.</p>
    </div>
  )
}

function Home() {
  const { can, canAny, profile, attendanceReach, leaveReach, role, roleName, user } = useAuthStore()
  const me = Boolean(profile)

  const show = {
    punch: me && can('attendance:punch') && profile.attendance_mode === 'app',
    today: can('attendance:read') && Boolean(attendanceReach) && attendanceReach !== 'SELF',
    payroll: can('payroll:structure:read'),
    people: can('employee:create') && can('employee:read'),
    lifecycle: can('employee:lifecycle:manage'),
    // Leave waiting for others' decisions, beyond one's own leave reach (HR).
    leaveWatch: can('leave:read') && Boolean(leaveReach) && leaveReach !== 'SELF',
    documents: can('document:verify'),
    holidays: can('leave:read'),
  }
  const selfOnly = !show.today && !show.people && !show.payroll
  const payrollFocus = show.payroll && !show.today && !show.people

  const stats = useMyDashboardStats({ enabled: me })
  const team = useTeamLeave({ enabled: canAny(ROUTE_PERMISSIONS['/leave']) })
  const requests = useWaitingRequests({ enabled: canAny(ROUTE_PERMISSIONS['/requests']) })
  const resignations = useWaitingResignations()
  const today = useTodayAtWork({ enabled: show.today })
  const payroll = usePayrollSummary({ enabled: show.payroll })

  // What waits for this login: leave asked of it, requests it decides, resignations it accepts.
  const waiting = {
    leave: (team.data?.requests ?? []).filter((r) => r.status === 'pending' && r.can_decide),
    requests: requests.data ?? [],
    resignations: resignations.data ?? [],
  }
  const waitingTotal = waiting.leave.length + waiting.requests.length + waiting.resignations.length
  // A list that failed to load is not an empty one: the card says so rather than vanishing.
  const waitingFailed = [
    ['leave asked of you', team],
    ['requests', requests],
    ['resignations', resignations],
  ].filter(([, query]) => query.isError)
  // Still asking: not yet "nothing".
  const waitingLoading = [team, requests, resignations].some((query) => query.isLoading)

  // ── The cards, wide and narrow, each with a rough height for balancing rows ──
  const wide = []
  const narrow = []
  if (waitingTotal > 0 || waitingFailed.length > 0) {
    wide.push({ key: 'waiting', h: 1.6 + Math.min(5, Math.max(1, waitingTotal)) * 1.15, el: <WaitingCard {...waiting} failed={waitingFailed} /> })
  }
  if (show.today) wide.push({ key: 'today', h: today.data?.reach === 'team' ? 3 + (today.data.people.length * 0.75) : 5.5, el: <TodayCard today={today} /> })
  if (show.payroll) (payrollFocus ? wide : narrow).push({ key: 'payroll', h: 6, el: <PayrollRunCard summary={payroll} wide={payrollFocus} /> })
  if (show.people) wide.push({ key: 'people', h: 3.5, el: <PeopleCard /> })

  // My day and my month. How the days are recorded, when not by checking in
  // here: the machine, HR, or (Day 23) the person's own employee login.
  const mayPunch = can('attendance:punch')
  const mayApply = can('leave:apply')
  const monthNote = !mayPunch && !mayApply
    ? 'This login does not check in or ask for leave. Those are on your own employee login.'
    : !mayPunch
      ? 'This login does not check in. Checking in is done from your own employee login.'
      : profile?.attendance_mode === 'biometric'
        ? 'You check in at the biometric machine. Your days show here once HR imports its file.'
        : profile?.attendance_mode === 'manual'
          ? 'HR marks your attendance. Your days show here as they are marked.'
          : null
  const monthCard = { key: 'month', h: 3.4, el: <MyMonthCard stats={stats} note={monthNote} showBalances={!mayApply} /> }
  if (me) narrow.unshift(...(show.punch ? [{ key: 'punch', h: 4.3, el: <PunchCard /> }, monthCard] : [monthCard]))
  if (me && can('leave:apply')) narrow.push({ key: 'leave', h: 2.8, el: <LeaveBalanceCard stats={stats} canApply /> })
  if (payrollFocus) {
    narrow.push({ key: 'bank', h: 2.6, el: <BankAccountsCard summary={payroll} /> })
    narrow.push({ key: 'next', h: 2.2, el: <NextMonthCard summary={payroll} /> })
    narrow.push({ key: 'entries', h: 2, el: <EntriesCard summary={payroll} /> })
    narrow.push({ key: 'loans', h: 1.6, el: <LoansCard summary={payroll} /> })
  }
  if (show.leaveWatch) narrow.push({ key: 'leave-watch', h: 2.6, el: <PendingLeaveCard /> })
  if (show.lifecycle) narrow.push({ key: 'lifecycle', h: 3, el: <LifecycleCard /> })
  if (show.documents) narrow.push({ key: 'documents', h: 2.2, el: <DocumentsCard /> })
  if (selfOnly && me) {
    narrow.push({ key: 'week', h: 3, el: <MyWeekCard stats={stats} /> })
    narrow.push({ key: 'requests', h: 2.6, el: <MyRequestsCard stats={stats} /> })
  }
  if (show.holidays) narrow.push({ key: 'holidays', h: 3, el: <HolidaysCard /> })
  if (me && can('payslip:read') && !show.people && !payrollFocus) narrow.push({ key: 'payslip', h: 1.8, el: <PayslipCard /> })
  if (selfOnly && me && can('document:read')) narrow.push({ key: 'mydocs', h: 2, el: <MyDocumentsCard /> })
  if (can('document:company:read') && !show.documents && !payrollFocus) narrow.push({ key: 'company-docs', h: 1.8, el: <CompanyDocumentsCard /> })

  // Each wide card takes narrow ones beside it until their heights roughly match.
  const rows = []
  let next = 0
  for (const w of wide) {
    const side = []
    let height = 0
    while (next < narrow.length && (side.length === 0 || height + narrow[next].h * 0.5 < w.h)) {
      side.push(narrow[next])
      height += narrow[next].h
      next += 1
    }
    rows.push({ wide: w, side })
  }
  const rest = narrow.slice(next)

  // The banner's line and buttons.
  const firstName = (profile?.full_name || user?.email?.split('@')[0] || '').split(' ')[0]
  const roleText = roleLabel(role, roleName)
  const line = selfOnly && stats.data?.profile
    ? [stats.data.profile.designation, stats.data.profile.department].filter(Boolean).join(' · ') || roleText
    : `${roleText} · ${waitingTotal
      ? `${waitingTotal} thing${waitingTotal === 1 ? '' : 's'} waiting for you${waitingFailed.length ? ' (some could not be loaded)' : ''}`
      : waitingFailed.length ? 'what waits for you could not be loaded' : waitingLoading ? 'checking what waits for you…' : 'nothing is waiting for you'}`
  const actions = [
    can('employee:create') && { label: 'Add employee', to: '/employees?add=1', icon: UserPlus },
    me && can('leave:apply') && { label: 'Apply leave', to: '/leave?apply=1', icon: CalendarPlus },
    me && can('leave:apply') && { label: 'New request', to: '/requests?new=choose', icon: FilePlus2 },
    show.payroll && { label: 'Open payroll', to: '/payroll', icon: Wallet },
    can('employee:bank:read') && !can('employee:create') && { label: 'Bank accounts', to: '/payroll?tab=bank', icon: Landmark },
    can('document:company:manage') && !can('leave:apply') && { label: 'Publish a document', to: '/documents?tab=company', icon: Upload },
  ].filter(Boolean).slice(0, 3)

  return (
    <div className="space-y-4 sm:space-y-5">
      <HomeBanner name={firstName} line={line} actions={actions} />

      {/*
        Narrow cards on the left on a computer. On a phone the first row keeps
        them first — My day at the top — and every later row puts its wide
        card first, so "today at work" is not pushed below the holidays.
      */}
      {rows.map(({ wide: w, side }, i) => (
        <div key={w.key} className="grid grid-cols-1 lg:grid-cols-12 gap-4 sm:gap-5 items-stretch">
          {side.length > 0 && (
            <div className={`lg:col-span-4 flex flex-col gap-4 sm:gap-5 min-w-0 *:last:flex-1 ${i > 0 ? 'order-2 lg:order-0' : ''}`}>
              {side.map((n) => <div key={n.key} className="flex flex-col *:flex-1">{n.el}</div>)}
            </div>
          )}
          <div className={`${side.length ? 'lg:col-span-8' : 'lg:col-span-12'} flex flex-col min-w-0 *:flex-1 ${i > 0 ? 'order-1 lg:order-0' : ''}`}>{w.el}</div>
        </div>
      ))}

      {rest.length > 0 && (
        <div className="columns-1 md:columns-2 xl:columns-3 gap-4 sm:gap-5 *:break-inside-avoid *:mb-4 sm:*:mb-5">
          {rest.map((n) => <div key={n.key}>{n.el}</div>)}
        </div>
      )}
    </div>
  )
}
