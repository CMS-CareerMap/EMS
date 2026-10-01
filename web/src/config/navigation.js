import {
  LayoutDashboard,
  Users,
  Clock,
  CalendarDays,
  Wallet,
  Receipt,
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
      // Any of these: HR enters Incentive here without seeing anybody's pay.
      { to: '/payroll', icon: Wallet, label: 'Payroll', permission: ['payroll:structure:read', 'payroll:entry:manage'] },
      { to: '/payslips', icon: Receipt, label: 'My Payslips', permission: 'payslip:read' },
    ],
  },
  {
    label: 'Resources',
    items: [
      // Any of these: everybody reads the company's policies (§5); employee files are document:read.
      { to: '/documents', icon: FileText, label: 'Documents', permission: ['document:read', 'document:company:read'] },
      { to: '/reports', icon: BarChart2, label: 'Reports', permission: 'report:read' },
    ],
  },
  {
    label: 'System',
    items: [
      // Any of these. HR keeps leave types and holidays here without holding
      // company settings; the tabs inside are filtered the same way. Since
      // Day 21 a role can be given user management, or the Super Admin's Roles
      // screen, without company settings — so those open it too.
      {
        to: '/settings',
        icon: Settings,
        label: 'Settings',
        permission: [
          'settings:read',
          'leave:type:manage',
          'holiday:manage',
          'document:type:manage',
          'audit:read',
          'user:invite',
          'user:status:update',
          'user:delete',
          'membership:role:assign',
          'role:manage',
        ],
      },
    ],
  },
]

/** Flattened path → permission, for the router. */
export const ROUTE_PERMISSIONS = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.permission])),
)
