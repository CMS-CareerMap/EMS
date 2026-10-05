import { NavLink, useLocation } from 'react-router-dom'
import { MoreHorizontal } from 'lucide-react'
import { visibleNavItems } from '../config/navigation'
import { useAuthStore } from '../stores/authStore'
import { useNavCounts } from '../hooks/useNavCounts'

/**
 * The phone's tab bar: the first four pages this login may open, and More for
 * everything else. A thumb reaches it; a menu behind a button it does not.
 */
export default function BottomNav({ onMore }) {
  const canAny = useAuthStore((state) => state.canAny)
  const counts = useNavCounts()
  const { pathname } = useLocation()
  const items = visibleNavItems(canAny)
  const shown = items.slice(0, 4)
  const rest = items.length > 4
  const onRest = rest && !shown.some((item) => pathname.startsWith(item.to))

  const cell = (active) => `relative flex-1 flex flex-col items-center gap-0.5 pt-1.5 pb-1 text-[10.5px] font-semibold transition-colors ${active ? 'text-brand-600' : 'text-gray-400'}`
  const icon = (active) => `w-10 h-6.5 px-2.5 py-1 rounded-full ${active ? 'bg-brand-50' : ''}`

  return (
    <nav aria-label="Pages" className="md:hidden fixed bottom-0 inset-x-0 z-30 bg-white border-t border-gray-200 flex px-1 pb-[max(env(safe-area-inset-bottom),6px)]">
      {shown.map((item) => {
        const count = counts[item.to] ?? 0
        return (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => cell(isActive)}>
            {({ isActive }) => (
              <>
                <item.icon className={icon(isActive)} aria-hidden="true" />
                {item.label}
                {count > 0 && <span className="absolute top-0.5 right-[calc(50%-22px)] min-w-4 h-4 px-1 rounded-full bg-pink-500 text-white text-[9.5px] font-bold leading-4 text-center">{count > 9 ? '9+' : count}</span>}
              </>
            )}
          </NavLink>
        )
      })}
      {rest && (
        <button type="button" onClick={onMore} className={cell(onRest)} aria-label="More pages">
          <MoreHorizontal className={icon(onRest)} aria-hidden="true" />
          More
        </button>
      )}
    </nav>
  )
}
