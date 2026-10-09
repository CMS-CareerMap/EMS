import { useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import PageHeader from '../components/ui/PageHeader'
import Tabs from '../components/ui/Tabs'
import { card } from '../components/ui/styles'
import { Building2, Users, CalendarDays, Bell, IndianRupee, Network, FolderOpen, ScrollText, ShieldCheck, GitBranch, CheckSquare, UserCog } from 'lucide-react'
import CompanyTree from '../features/settings/CompanyTree'
import ApprovalsSettings from '../features/settings/ApprovalsSettings'
import CompanySettings from '../features/settings/CompanySettings'
import UsersSettings from '../features/settings/UsersSettings'
import RolesSettings from '../features/settings/RolesSettings'
import OrganisationSettings from '../features/settings/OrganisationSettings'
import LeaveSettings from '../features/settings/LeaveSettings'
import PayrollSettings from '../features/settings/PayrollSettings'
import NotificationSettings from '../features/settings/NotificationSettings'
import DocumentSettings from '../features/settings/DocumentSettings'
import LifecycleSettings from '../features/settings/LifecycleSettings'
import AuditLog from '../features/settings/AuditLog'
import { useAuthStore } from '../stores/authStore'

/**
 * Settings: one tab per owner, each in its own file under features/settings.
 *
 * Every tab is drawn only for somebody holding its permission. The page used
 * to show all six to anybody who could open it — and only Super Admin could,
 * so HR, who run leave, had no way to reach leave types or holidays at all.
 * The route now opens for any of the permissions below, and this filters.
 *
 * The open tab is in the address (?tab=leave), so a reload — or a link sent to
 * somebody — lands on the same tab.
 */
const TABS = [
  { id: 'company', label: 'Company', icon: Building2, permission: 'settings:read', Component: CompanySettings },
  // Any of the four: since Day 21 a role can hold some of them and not others,
  // and the tab draws only the buttons each one allows.
  // HR too, who sets employees' passwords (client, 6 Oct 2026): the logins waiting for one are listed here.
  // Not where Settings opens for them, though — that stays the tab they work in (notLanding).
  { id: 'users', label: 'Users & Roles', icon: Users, permission: ['user:invite', 'membership:role:assign', 'user:status:update', 'user:delete', 'user:password:set'], Component: UsersSettings, notLanding: true },
  { id: 'roles', label: 'Roles & Permissions', icon: ShieldCheck, permission: 'role:manage', Component: RolesSettings },
  // Who reports to whom, the owner, and who decides when the tree has no answer (Day 22).
  { id: 'tree', label: 'Company Tree', icon: GitBranch, permission: 'role:manage', Component: CompanyTree },
  { id: 'approvals', label: 'Approvals', icon: CheckSquare, permission: 'role:manage', Component: ApprovalsSettings },
  { id: 'organisation', label: 'Organisation', icon: Network, permission: 'settings:read', Component: OrganisationSettings },
  {
    id: 'leave',
    label: 'Leave Config',
    icon: CalendarDays,
    permission: ['settings:read', 'leave:type:manage', 'holiday:manage'],
    Component: LeaveSettings,
  },
  { id: 'payroll', label: 'Payroll Config', icon: IndianRupee, permission: 'settings:read', Component: PayrollSettings },
  { id: 'documents', label: 'Documents', icon: FolderOpen, permission: ['settings:read', 'document:type:manage'], Component: DocumentSettings },
  // Probation and notice period (client §43): HR reads them, Settings changes them.
  // After the tabs HR works in, so HR still lands on Leave Config.
  { id: 'lifecycle', label: 'Employee Lifecycle', icon: UserCog, permission: ['settings:read', 'employee:lifecycle:manage'], Component: LifecycleSettings },
  { id: 'notifications', label: 'Notifications', icon: Bell, permission: 'settings:read', Component: NotificationSettings },
  { id: 'audit', label: 'Audit Log', icon: ScrollText, permission: 'audit:read', Component: AuditLog },
]

/** The menu's groups, for reading — the order above still decides which tab opens first. */
const GROUPS = [
  ['Organisation', ['company', 'organisation', 'tree']],
  ['People & access', ['users', 'roles', 'approvals', 'lifecycle']],
  ['Time & pay', ['leave', 'payroll']],
  ['Records', ['documents', 'notifications', 'audit']],
]

export default function Settings() {
  // The list itself, not canAny: subscribing to it re-draws the tabs if the
  // session's permissions change.
  const permissions = useAuthStore((state) => state.permissions)
  const tabs = TABS.filter((t) => [t.permission].flat().some((p) => permissions.includes(p)))

  const [params, setParams] = useSearchParams()
  const tab = tabs.find((t) => t.id === params.get('tab')) ?? tabs.find((t) => !t.notLanding) ?? tabs[0]
  const panelRef = useRef(null)
  const menuRef = useRef(null)
  const asideRef = useRef(null)
  // The menu ends 24px above the foot of the screen wherever it sits: below the
  // page title at first, held at the top once the page scrolls. Its height is
  // the room left, so it is never cut — where it does not fit, it scrolls itself.
  useEffect(() => {
    const aside = asideRef.current
    const main = aside?.closest('main')
    if (!aside || !main) return
    let frame = 0
    const fit = () => {
      frame = 0
      const room = Math.min(window.innerHeight, main.getBoundingClientRect().bottom) - aside.getBoundingClientRect().top - 24
      aside.style.maxHeight = `${Math.max(160, Math.floor(room))}px`
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(fit) }
    fit()
    main.addEventListener('scroll', schedule, { passive: true })
    window.addEventListener('resize', schedule)
    return () => {
      main.removeEventListener('scroll', schedule)
      window.removeEventListener('resize', schedule)
      cancelAnimationFrame(frame)
    }
  }, [])
  // Another section opens at its top: one chosen from halfway down the last
  // used to open halfway down itself (Devesh, 9 Oct 2026).
  const choose = (id) => {
    if (id !== tab?.id) panelRef.current?.closest('main')?.scrollTo({ top: 0 })
    setParams({ tab: id }, { replace: true })
  }
  // The open section stays in view in the menu, when the menu scrolls itself.
  useEffect(() => {
    const menu = menuRef.current
    const item = menu?.querySelector('[aria-current="page"]')
    if (!menu || !item) return
    const m = menu.getBoundingClientRect()
    const r = item.getBoundingClientRect()
    if (r.top < m.top) menu.scrollTop -= m.top - r.top + 8
    else if (r.bottom > m.bottom) menu.scrollTop += r.bottom - m.bottom + 8
  }, [tab?.id])
  const groups = GROUPS
    .map(([label, ids]) => [label, ids.map((id) => tabs.find((t) => t.id === id)).filter(Boolean)])
    .filter(([, items]) => items.length > 0)

  return (
    <>
      <PageHeader title="Settings" subtitle="Company configuration, users, leave and payroll rules" />

      {/* A strip on a phone — it scrolls itself, never the page, to keep the open tab in view
          (a link to ?tab=audit used to open on a tab cut off at the edge). */}
      {tabs.length > 1 && (
        <div className={`${card} lg:hidden px-3 mb-4`}>
          <Tabs items={tabs.map((t) => ({ key: t.id, label: t.label, icon: t.icon }))} value={tab?.id} onChange={choose} label="Settings sections" panelId="settings-panel" />
        </div>
      )}

      {/* Side by side from lg up: the grouped menu, then the open section. The
          page scrolls the section; the menu stays put beside it and is never
          taller than the room it has (see the effect above) — where it does not
          fit (a short screen, a zoomed browser) it scrolls itself, so every
          section is always in reach (Devesh, 9 Oct 2026: at 160% zoom it was cut
          at the foot, then at the top). Before the script runs: the screen less
          the top bar (58px) and the page's padding above and below (24px each). */}
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 items-start">
        <aside ref={asideRef} className="hidden lg:flex lg:flex-col w-60 shrink-0 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-106px)]">
          <nav ref={menuRef} className={`${card} p-2 min-h-0 overflow-y-auto overscroll-contain [scrollbar-width:thin] [scrollbar-color:var(--color-gray-300)_transparent]`} aria-label="Settings sections">
            {groups.map(([label, items]) => (
              <div key={label} className="mb-1 last:mb-0">
                <p className="px-3 pt-2 pb-0.5 text-[10.5px] font-extrabold uppercase tracking-wider text-gray-400">{label}</p>
                {items.map((item) => (
                  <button key={item.id} type="button" onClick={() => choose(item.id)} aria-current={tab?.id === item.id ? 'page' : undefined}
                    className={`relative w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] font-semibold transition-colors text-left
                      ${tab?.id === item.id ? 'bg-brand-50 text-brand-700' : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'}`}>
                    {tab?.id === item.id && <span aria-hidden="true" className="absolute left-0 top-2 bottom-2 w-0.75 rounded-r bg-logo" />}
                    <item.icon className={`w-4 h-4 ${tab?.id === item.id ? 'text-brand-600' : 'text-gray-400'}`} aria-hidden="true" />
                    {item.label}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        </aside>

        {/* The phone's tabs point here. Not a tab panel: from lg up those tabs are
            hidden and the side menu chooses — a panel would be announced with no tabs. */}
        <div id="settings-panel" ref={panelRef} className="flex-1 min-w-0 w-full">
          {tab ? <tab.Component /> : <p className="text-sm text-gray-500">Nothing here is available to your role.</p>}
        </div>
      </div>
    </>
  )
}
