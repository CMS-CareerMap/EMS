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
  { id: 'users', label: 'Users & Roles', icon: Users, permission: ['user:invite', 'membership:role:assign', 'user:status:update', 'user:delete'], Component: UsersSettings },
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
  const tab = tabs.find((t) => t.id === params.get('tab')) ?? tabs[0]
  const choose = (id) => setParams({ tab: id }, { replace: true })
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

      {/* Side by side from lg up: the grouped menu, then the open section. */}
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6 items-start">
        <aside className="hidden lg:block w-60 shrink-0 lg:sticky lg:top-0">
          <nav className={`${card} p-2`} aria-label="Settings sections">
            {groups.map(([label, items]) => (
              <div key={label} className="mb-1 last:mb-0">
                <p className="px-3 pt-2.5 pb-1 text-[10.5px] font-extrabold uppercase tracking-wider text-gray-400">{label}</p>
                {items.map((item) => (
                  <button key={item.id} type="button" onClick={() => choose(item.id)} aria-current={tab?.id === item.id ? 'page' : undefined}
                    className={`relative w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-[13px] font-semibold transition-colors text-left
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
        <div id="settings-panel" className="flex-1 min-w-0 w-full">
          {tab ? <tab.Component /> : <p className="text-sm text-gray-500">Nothing here is available to your role.</p>}
        </div>
      </div>
    </>
  )
}
