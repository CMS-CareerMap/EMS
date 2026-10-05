import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, Menu, ChevronDown, User, Search, LogOut } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useNotifications } from '../hooks/useNotifications'
import { useSignOut } from '../hooks/useSignOut'
import NotificationPanel from './NotificationPanel'
import { EscapeCloses } from '../hooks/useEscape'
import { Avatar } from './ui/bits'
import { roleLabel } from '../lib/roles'

/**
 * The white bar across the top: the company's logo in its own colours, the
 * search, the bell, and who is signed in.
 *
 * "Signed in as HR" stays in the user button: somebody with two logins
 * (Day 23) sees at a glance which one is open.
 */
export default function TopBar({ onMenuClick, onSearch }) {
  const { user, profile, role, roleName, organization } = useAuthStore()
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [notificationOpen, setNotificationOpen] = useState(false)
  const signOut = useSignOut()

  const notices = useNotifications()
  // The bell only counts. When the notices could not be fetched it shows no
  // badge rather than a stale or made-up number; the panel says what went wrong.
  const unreadCount = notices.isError ? 0 : notices.unreadCount

  const displayName = profile?.full_name || user?.email?.split('@')[0] || 'User'
  const displayEmail = user?.email ?? ''
  const displayRole = roleLabel(role, roleName) || 'User'

  return (
    <header className="h-14 md:h-14.5 bg-white border-b border-gray-200 flex items-center gap-1.5 md:gap-4 pl-1 pr-2 md:pl-0 md:pr-5 shrink-0 relative z-30">

      {/* Phone: the whole menu. */}
      <button type="button" onClick={onMenuClick} aria-label="Open menu" className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100">
        <Menu className="w-5 h-5" />
      </button>

      <Link to="/dashboard" className="shrink-0 md:pl-4.5" aria-label="Home">
        <img src="/logo-wide.png" alt="CareerMap Solutions" className="h-8 md:h-10 w-auto" />
      </Link>

      <span aria-hidden="true" className="hidden lg:block w-px h-7 bg-gray-200" />
      <div className="hidden lg:block leading-tight min-w-0">
        <p className="text-sm font-bold text-gray-900 truncate max-w-56">{organization?.name ?? 'CareerMap Solutions'}</p>
        <p className="text-[11.5px] text-gray-500">HR &amp; Payroll</p>
      </div>

      {/* Search: people, pages and things to do. Ctrl K opens it from anywhere. */}
      <button type="button" onClick={onSearch} aria-label="Search people or pages (Ctrl K)"
        className="hidden md:flex flex-1 max-w-115 ml-2 h-9.5 items-center gap-2 rounded-[10px] border border-gray-200 bg-canvas px-3 text-[13px] text-gray-400 hover:border-gray-300 transition-colors">
        <Search className="w-4 h-4" aria-hidden="true" />
        Search people or pages
        <kbd className="ml-auto rounded-md border border-gray-200 bg-white px-1.5 py-0.5 font-sans text-[11px] font-semibold text-gray-500">Ctrl K</kbd>
      </button>

      <span className="flex-1" />

      <button type="button" onClick={onSearch} aria-label="Search" className="md:hidden p-2 rounded-lg text-gray-600 hover:bg-gray-100">
        <Search className="w-5 h-5" />
      </button>

      {/* The bell. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setNotificationOpen(!notificationOpen)}
          data-notification-toggle
          aria-expanded={notificationOpen}
          className="relative w-9.5 h-9.5 grid place-items-center rounded-[10px] text-gray-600 hover:text-gray-900 hover:bg-gray-100 transition-colors"
          title="Notifications"
          aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        >
          <Bell className="w-5 h-5" />
          {unreadCount > 0 && (
            <span className="absolute top-0.5 right-0 min-w-4.25 h-4.25 px-1 flex items-center justify-center bg-pink-500 text-white text-[10px] font-bold rounded-full border-2 border-white">
              {unreadCount > 9 ? '9+' : unreadCount}
            </span>
          )}
        </button>

        <NotificationPanel isOpen={notificationOpen} onClose={() => setNotificationOpen(false)} />
      </div>

      {/* Who is signed in. */}
      <div className="relative">
        <button
          type="button"
          onClick={() => setDropdownOpen(!dropdownOpen)}
          aria-expanded={dropdownOpen}
          aria-haspopup="menu"
          className="flex items-center gap-2.5 p-1 md:pr-2 rounded-xl hover:bg-gray-100 transition-colors"
        >
          <Avatar name={displayName} size="sm" />
          {/* On a phone, the role alone: somebody with two logins sees which one is open (Day 23). */}
          <span className="sm:hidden max-w-20 truncate text-[11px] font-semibold text-gray-600" title={`Signed in as ${displayRole}`}>{displayRole}</span>
          <span className="hidden sm:block text-left">
            <span className="block text-[13px] font-semibold text-gray-900 leading-tight max-w-40 truncate">{displayName}</span>
            <span className="block text-[11.5px] text-gray-500" data-signed-in-as>Signed in as {displayRole}</span>
          </span>
          <ChevronDown className="w-4 h-4 text-gray-400 hidden sm:block" aria-hidden="true" />
        </button>

        {dropdownOpen && (
          <>
            {/* Escape closes it, as every other menu and dialog. */}
            <EscapeCloses onClose={() => setDropdownOpen(false)} />
            <div className="fixed inset-0 z-10" onClick={() => setDropdownOpen(false)} />
            <div role="menu" className="absolute right-0 top-full mt-1.5 w-64 bg-white rounded-xl border border-gray-200 shadow-md z-20 overflow-hidden">
              <div className="px-4 py-3 border-b border-gray-100">
                <p className="text-sm font-semibold text-gray-900 truncate">{displayEmail}</p>
                {/* Shown here too: on a phone the bar has room for the avatar and the role only. */}
                <p className="text-xs text-gray-500 mt-0.5">Signed in as {displayRole}</p>
              </div>
              <div className="p-1">
                <Link to="/profile" role="menuitem" onClick={() => setDropdownOpen(false)}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-gray-50 rounded-lg transition-colors">
                  <User className="w-4 h-4 text-gray-400" aria-hidden="true" />
                  My Profile
                </Link>
                <button type="button" role="menuitem" onClick={signOut}
                  className="flex items-center gap-2 w-full px-3 py-2 text-sm text-gray-700 hover:bg-red-50 hover:text-red-600 rounded-lg transition-colors">
                  <LogOut className="w-4 h-4 text-gray-400" aria-hidden="true" />
                  Sign Out
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </header>
  )
}
