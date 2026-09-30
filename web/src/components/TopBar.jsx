import { useState } from 'react'
import { Bell, Menu, ChevronDown, User } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useNotifications } from '../hooks/useNotifications'
import NotificationPanel from './NotificationPanel'
import { ROLE_LABELS } from '../lib/roles'

// The server's role names — the same labels as the sidebar.
export default function TopBar({ title, onMenuClick }) {
  const { user, profile, role, setProfileDrawerOpen } = useAuthStore()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [notificationOpen, setNotificationOpen] = useState(false)

  const { unreadCount } = useNotifications()

  const displayName = profile?.full_name || user?.email?.split('@')[0] || 'User'
  const displayEmail = user?.email ?? ''
  const displayRole = ROLE_LABELS[role] ?? role ?? 'User'

  const initials = displayName
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase()

  return (
    <header className="h-16 bg-white border-b border-gray-200 flex items-center px-6 gap-4 shrink-0">

      {/* Mobile menu toggle */}
      <button
        onClick={onMenuClick}
        className="lg:hidden text-gray-500 hover:text-gray-700 transition-colors"
      >
        <Menu className="w-5 h-5" />
      </button>

      {/* Page title */}
      <h1 className="text-lg font-semibold text-gray-900 flex-1 truncate">{title}</h1>

      <div className="flex items-center gap-3">

        {/* Notification bell & Dropdown Container */}
        <div className="relative">
          <button
            onClick={() => setNotificationOpen(!notificationOpen)}
            data-notification-toggle
            aria-expanded={notificationOpen}
            className="relative p-2 rounded-lg text-gray-500 hover:text-gray-700 hover:bg-gray-100 transition-colors"
            title="Notifications"
            aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
          >
            <Bell className="w-5 h-5" />
            {/* Dynamic Unread Badge */}
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-4 h-4 px-1 flex items-center justify-center bg-red-500 text-white text-[10px] font-bold rounded-full border-2 border-white">
                {unreadCount > 9 ? '9+' : unreadCount}
              </span>
            )}
          </button>

          <NotificationPanel
            isOpen={notificationOpen}
            onClose={() => setNotificationOpen(false)}
          />
        </div>

        {/* User menu */}
        <div className="relative">
          <button
            onClick={() => setDropdownOpen(!dropdownOpen)}
            className="flex items-center gap-2.5 pl-2 pr-3 py-1.5 rounded-lg hover:bg-gray-100 transition-colors"
          >
            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center shrink-0">
              <span className="text-white text-xs font-semibold">{initials}</span>
            </div>
            <div className="hidden sm:block text-left">
              <p className="text-sm font-medium text-gray-900 leading-none">{displayName}</p>
              <p className="text-xs text-gray-500 mt-0.5">{displayRole}</p>
            </div>
            <ChevronDown className="w-4 h-4 text-gray-400 hidden sm:block" />
          </button>

          {/* Dropdown */}
          {dropdownOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
              <div className="absolute right-0 top-full mt-1 w-56 bg-white rounded-xl border border-gray-200 shadow-lg z-20 overflow-hidden">
                <div className="px-4 py-3 border-b border-gray-100">
                  <p className="text-sm font-medium text-gray-900 truncate">{displayEmail}</p>
                  <p className="text-xs text-gray-500 mt-0.5">{displayRole}</p>
                </div>
                <div className="p-1">
                  <button
                    onClick={() => {
                      setDropdownOpen(false)
                      setProfileDrawerOpen(true)
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors"
                  >
                    <User className="w-4 h-4 text-gray-400" />
                    My Profile
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </header>
  )
}
