import { useSearchParams } from 'react-router-dom'
import { Building2, Users, CalendarDays, Bell, IndianRupee, Network, FolderOpen } from 'lucide-react'
import CompanySettings from '../features/settings/CompanySettings'
import UsersSettings from '../features/settings/UsersSettings'
import OrganisationSettings from '../features/settings/OrganisationSettings'
import LeaveSettings from '../features/settings/LeaveSettings'
import PayrollSettings from '../features/settings/PayrollSettings'
import NotificationSettings from '../features/settings/NotificationSettings'
import DocumentSettings from '../features/settings/DocumentSettings'
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
  { id: 'users', label: 'Users & Roles', icon: Users, permission: 'user:invite', Component: UsersSettings },
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
  { id: 'notifications', label: 'Notifications', icon: Bell, permission: 'settings:read', Component: NotificationSettings },
]

export default function Settings() {
  // The list itself, not canAny: subscribing to it re-draws the tabs if the
  // session's permissions change.
  const permissions = useAuthStore((state) => state.permissions)
  const tabs = TABS.filter((t) => [t.permission].flat().some((p) => permissions.includes(p)))

  const [params, setParams] = useSearchParams()
  const tab = tabs.find((t) => t.id === params.get('tab')) ?? tabs[0]
  const choose = (id) => setParams({ tab: id }, { replace: true })

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Settings</h2>
        <p className="text-sm text-gray-500 mt-0.5">Company configuration, users, leave and payroll rules</p>
      </div>

      {/* A column on a phone, side by side from lg up. */}
      <div className="flex flex-col lg:flex-row gap-4 lg:gap-6">
        <aside className="hidden lg:block w-52 shrink-0">
          <nav className="space-y-0.5">
            {tabs.map((item) => (
              <button key={item.id} type="button" onClick={() => choose(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all text-left
                  ${tab?.id === item.id
                    ? 'bg-blue-50 text-blue-700 border border-blue-200'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900 border border-transparent'
                  }`}>
                <item.icon className={`w-4 h-4 ${tab?.id === item.id ? 'text-blue-600' : 'text-gray-400'}`} />
                {item.label}
              </button>
            ))}
          </nav>
        </aside>

        <div className="lg:hidden flex gap-1 overflow-x-auto pb-1">
          {tabs.map((item) => (
            <button key={item.id} type="button" onClick={() => choose(item.id)}
              className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium whitespace-nowrap transition-colors shrink-0
                ${tab?.id === item.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              <item.icon className="w-3.5 h-3.5" />
              {item.label}
            </button>
          ))}
        </div>

        <div className="flex-1 min-w-0">
          {tab ? <tab.Component /> : <p className="text-sm text-gray-500">Nothing here is available to your role.</p>}
        </div>
      </div>
    </div>
  )
}
