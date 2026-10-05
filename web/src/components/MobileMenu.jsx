import { NavLink } from 'react-router-dom'
import { LogOut, X, User } from 'lucide-react'
import { NAV_GROUPS } from '../config/navigation'
import { useAuthStore } from '../stores/authStore'
import { useNavCounts } from '../hooks/useNavCounts'
import { useSignOut } from '../hooks/useSignOut'
import { useEscape } from '../hooks/useEscape'
import { roleLabel } from '../lib/roles'
import { Avatar } from './ui/bits'

/**
 * Every page, on a phone — opened from the menu button or the tab bar's
 * "More". The tab bar holds only four; this is where the rest, My Profile and
 * signing out live.
 */
export default function MobileMenu({ onClose }) {
  const { user, profile, role, roleName, canAny } = useAuthStore()
  const counts = useNavCounts()
  const signOut = useSignOut()
  useEscape(onClose)

  const groups = NAV_GROUPS.map((group) => ({ ...group, items: group.items.filter((item) => canAny(item.permission)) }))
    .filter((group) => group.items.length > 0)
  const name = profile?.full_name || user?.email?.split('@')[0] || 'User'

  return (
    <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Menu">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <aside className="absolute inset-y-0 left-0 w-72 max-w-[85vw] bg-side flex flex-col shadow-2xl">
        <div className="flex items-center gap-3 px-4 py-4 border-b border-white/10">
          <Avatar name={name} size="md" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-white truncate">{name}</p>
            <p className="text-xs text-side-ink truncate">{roleLabel(role, roleName)}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close menu" className="p-2 rounded-lg text-side-ink hover:text-white hover:bg-white/5">
            <X className="w-5 h-5" />
          </button>
        </div>

        <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 py-3 space-y-4">
          {groups.map((group) => (
            <div key={group.label}>
              <p className="text-[10px] font-bold text-side-ink/70 uppercase tracking-[0.12em] px-3 mb-1.5">{group.label}</p>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const count = counts[item.to] ?? 0
                  return (
                    <li key={item.to}>
                      <NavLink to={item.to} onClick={onClose}
                        className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold transition-colors
                          ${isActive ? 'text-white bg-white/10' : 'text-side-ink hover:text-white hover:bg-white/5'}`}>
                        <item.icon className="w-4.5 h-4.5 shrink-0" aria-hidden="true" />
                        <span className="flex-1">{item.title ?? item.label}</span>
                        {count > 0 && <span className="min-w-5 h-5 px-1.5 rounded-full bg-pink-500 text-white text-[11px] font-bold leading-5 text-center">{count}</span>}
                      </NavLink>
                    </li>
                  )
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="p-3 border-t border-white/10 space-y-0.5">
          <NavLink to="/profile" onClick={onClose}
            className={({ isActive }) => `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-semibold ${isActive ? 'text-white bg-white/10' : 'text-side-ink hover:text-white hover:bg-white/5'}`}>
            <User className="w-4.5 h-4.5" aria-hidden="true" />My Profile
          </NavLink>
          <button type="button" onClick={signOut}
            className="flex items-center gap-3 w-full px-3 py-2.5 rounded-xl text-sm font-semibold text-side-ink hover:text-red-300 hover:bg-red-500/10">
            <LogOut className="w-4.5 h-4.5" aria-hidden="true" />Sign Out
          </button>
        </div>
      </aside>
    </div>
  )
}
