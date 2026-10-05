import { NavLink } from 'react-router-dom'
import { visibleNavItems } from '../config/navigation'
import { useAuthStore } from '../stores/authStore'
import { useNavCounts } from '../hooks/useNavCounts'

/**
 * The menu on a computer: a narrow dark strip, each page an icon with its name
 * under it, the open page marked in the logo's colours.
 *
 * Which pages appear is the permissions' business (config/navigation.js), the
 * same list the router guards, so a link is never shown that would bounce.
 * Leave and Requests carry how many wait for this login.
 */
export default function Sidebar() {
  const canAny = useAuthStore((state) => state.canAny)
  const counts = useNavCounts()
  const items = visibleNavItems(canAny)

  return (
    <nav aria-label="Main" className="w-23 h-full bg-side flex flex-col gap-0.5 px-2 py-2.5 overflow-y-auto select-none">
      {items.map((item) => {
        const count = counts[item.to] ?? 0
        return (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              `relative flex flex-col items-center gap-1.5 px-1 pt-2.5 pb-2 rounded-xl text-[11px] font-semibold leading-tight text-center transition-colors
              focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-300
              ${isActive
                ? 'text-white bg-[linear-gradient(140deg,rgba(255,138,61,0.24),rgba(242,71,154,0.22)_45%,rgba(139,47,230,0.34))]'
                : 'text-side-ink hover:text-white hover:bg-white/5'}`
            }
          >
            {({ isActive }) => (
              <>
                {isActive && <span aria-hidden="true" className="absolute -left-2 top-3 bottom-3 w-0.75 rounded-r bg-logo" />}
                <item.icon className="w-5.25 h-5.25" aria-hidden="true" />
                <span>{item.label}</span>
                {count > 0 && (
                  <span className="absolute top-1.5 right-3.5 min-w-4.25 h-4.25 px-1 rounded-full bg-pink-500 text-white text-[10px] font-bold leading-4.25"
                    aria-label={`${count} waiting`}>
                    {count > 9 ? '9+' : count}
                  </span>
                )}
              </>
            )}
          </NavLink>
        )
      })}
    </nav>
  )
}
