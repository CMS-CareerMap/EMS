import { NavLink, useNavigate } from 'react-router-dom'
import { LogOut, ChevronRight } from 'lucide-react'
import { logout } from '../api/auth'
import { NAV_GROUPS } from '../config/navigation'
import { useAuthStore } from '../stores/authStore'
import { ROLE_LABELS } from '../lib/roles'


export default function Sidebar({ mobile = false, onClose }) {
  const navigate = useNavigate()
  const { user, profile, role, clearAuth, canAny } = useAuthStore()

  async function handleLogout() {
    // Clear locally whichever way the request goes. A network error is not a
    // reason to leave someone staring at a signed-in screen — and the server
    // call is what revokes the refresh token, so it is attempted first.
    try {
      await logout()
    } finally {
      clearAuth()
      navigate('/signin')
    }
  }

  const visibleGroups = NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAny(item.permission)),
  })).filter((group) => group.items.length > 0)

  const displayName = profile?.full_name || user?.email?.split('@')[0] || 'User'
  const displayRole = ROLE_LABELS[role] ?? role ?? 'User'
  const avatarText = (displayName || '')
    .split(' ')
    .slice(0, 2)
    .map(w => w[0])
    .join('')
    .toUpperCase()

  return (
    <aside className="flex flex-col h-full w-64 select-none" style={{ background: '#0F172A' }}>

      {/* Logo */}
      <div className="flex items-center justify-center relative px-4 py-2 border-b border-white/10">
        <img src="/logo.png" alt="CareerMap Solutions" className="w-[85%] max-w-[240px] object-contain" />
        {mobile && (
          <button onClick={onClose} className="text-slate-400 hover:text-white transition-colors p-1 absolute right-4">
            <ChevronRight className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-5">
        {visibleGroups.map((group) => (
          <div key={group.label}>
            <p className="text-[10px] font-bold text-slate-500 uppercase tracking-[0.12em] px-3 mb-1.5">
              {group.label}
            </p>
            <ul className="space-y-0.5">
              {group.items.map((item) => (
                <li key={item.to}>
                  <NavLink
                    to={item.to}
                    onClick={mobile ? onClose : undefined}
                    className={({ isActive }) =>
                      `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150
                      ${isActive
                        ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30'
                        : 'text-slate-400 hover:text-slate-100 hover:bg-white/6'
                      }`
                    }
                  >
                    {({ isActive }) => (
                      <>
                        <span className={`flex items-center justify-center w-7 h-7 rounded-lg transition-all
                          ${isActive ? 'bg-white/20' : 'group-hover:bg-white/5'}`}>
                          <item.icon className="w-4 h-4 shrink-0" />
                        </span>
                        {item.label}
                      </>
                    )}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      {/* User info + logout */}
      <div className="p-3 border-t border-white/8 space-y-1">
        {/* User card */}
        <div className="flex items-center gap-3 px-3 py-2.5 rounded-xl bg-white/5">
          <div className="w-8 h-8 rounded-full bg-blue-600 flex items-center justify-center shrink-0">
            <span className="text-white text-xs font-bold">{avatarText}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-white truncate leading-none">{displayName}</p>
            <p className="text-xs text-slate-400 mt-0.5 truncate">{displayRole}</p>
          </div>
        </div>

        {/* Sign out */}
        <button
          onClick={handleLogout}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-slate-400
            hover:text-red-400 hover:bg-red-500/10 transition-all w-full"
        >
          <span className="flex items-center justify-center w-7 h-7 rounded-lg">
            <LogOut className="w-4 h-4 shrink-0" />
          </span>
          Sign Out
        </button>
      </div>
    </aside>
  )
}
