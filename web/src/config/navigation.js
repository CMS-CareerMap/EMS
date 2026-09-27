import {
  LayoutDashboard,
  Users,
  Clock,
  CalendarDays,
  Wallet,
  FileText,
  BarChart2,
  Settings,
} from 'lucide-react'

/**
 * Which permission each page needs — named once, read by both the router and
 * the sidebar.
 *
 * Before this, the sidebar carried a list of role names per link and App.jsx
 * carried its own. They agreed by coincidence, and the failure mode was quiet:
 * a link visible in the sidebar that bounces you back to the dashboard when you
 * click it, or worse, a page reachable by URL that the sidebar had hidden.
 *
 * Permissions rather than roles, because the client will move rights between
 * roles and that must not be a code change here.
 */
export const NAV_GROUPS = [
  {
    label: 'Main',
    items: [
      { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', permission: 'dashboard:read' },
      { to: '/employees', icon: Users, label: 'Employees', permission: 'employee:read' },
      { to: '/attendance', icon: Clock, label: 'Attendance', permission: 'attendance:read' },
      { to: '/leave', icon: CalendarDays, label: 'Leave', permission: 'leave:read' },
      { to: '/payroll', icon: Wallet, label: 'Payroll', permission: 'payroll:structure:read' },
    ],
  },
  {
    label: 'Resources',
    items: [
      { to: '/documents', icon: FileText, label: 'Documents', permission: 'document:read' },
      { to: '/reports', icon: BarChart2, label: 'Reports', permission: 'report:read' },
    ],
  },
  {
    label: 'System',
    items: [
      // Any of these. HR keeps leave types and holidays here without holding
      // company settings; the tabs inside are filtered the same way.
      { to: '/settings', icon: Settings, label: 'Settings', permission: ['settings:read', 'leave:type:manage', 'holiday:manage'] },
    ],
  },
]

/** Flattened path → permission, for the router. */
export const ROUTE_PERMISSIONS = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.permission])),
)
