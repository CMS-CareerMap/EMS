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
  Inbox,
} from 'lucide-react'
import { DECIDES_LEAVE } from '../stores/authStore'

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
      { to: '/dashboard', icon: LayoutDashboard, label: 'Home', title: 'Home', permission: 'dashboard:read' },
      { to: '/employees', icon: Users, label: 'Employees', permission: 'employee:read' },
      { to: '/attendance', icon: Clock, label: 'Attendance', permission: 'attendance:read' },
      // Or deciding somebody's leave (Day 22): whoever has people under them
      // approves their leave, whatever their role's leave rights.
      { to: '/leave', icon: CalendarDays, label: 'Leave', permission: ['leave:read', DECIDES_LEAVE] },
      // Requests (client §28–29): anybody who asks for leave asks here too; and
      // whoever decides — the person somebody reports to, or HR.
      { to: '/requests', icon: Inbox, label: 'Requests', permission: ['leave:apply', 'attendance:update', 'employee:update', 'leave:balance:manage', DECIDES_LEAVE] },
      // Any of these: HR enters Incentive here without seeing anybody's pay,
      // and a role given only bank accounts reaches its Bank accounts tab.
      { to: '/payroll', icon: Wallet, label: 'Payroll', permission: ['payroll:structure:read', 'payroll:entry:manage', 'employee:bank:read'] },
      // "Payslips" in the narrow sidebar; the page itself is still "My Payslips".
      { to: '/payslips', icon: Receipt, label: 'Payslips', title: 'My Payslips', permission: 'payslip:read' },
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
          // Users & Roles, for whoever sets employees' passwords (client, 6 Oct 2026).
          'user:password:set',
          // Roles & Permissions, the Company tree and Approvals (Days 21–22).
          'role:manage',
          // The probation and notice period the lifecycle runs on (client §43).
          'employee:lifecycle:manage',
        ],
      },
    ],
  },
]

/** Flattened path → permission, for the router. */
export const ROUTE_PERMISSIONS = Object.fromEntries(
  NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.permission])),
)

/** Every page's name, for the browser tab — the pages outside the menu too. */
export const PAGE_TITLES = {
  ...Object.fromEntries(NAV_GROUPS.flatMap((group) => group.items.map((item) => [item.to, item.title ?? item.label]))),
  '/profile': 'My Profile',
}

/** The menu items this login may open, in order — for the sidebar, the phone's tab bar and search. */
export function visibleNavItems(canAny) {
  return NAV_GROUPS.flatMap((group) => group.items).filter((item) => canAny(item.permission))
}
