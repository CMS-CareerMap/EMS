import { createElement, useEffect, useRef } from 'react'
import { onTabKeyDown, tabIdOf } from './tabKeys'

/**
 * A row of tabs with the logo's line under the chosen one.
 *
 * `items` is [{ key, label, count?, icon? }]. A count draws as a small pill —
 * how many are waiting there — and nothing when it is zero.
 *
 * Buttons with role="tab", so a screen reader announces the set and which one
 * is open; ← → Home End move between them, and only the chosen one is in the
 * Tab order (WAI-ARIA tabs). With `panelId`, each tab names the panel it
 * shows — drawn by the page as <TabPanel id={panelId} tab={value}>.
 *
 * On a phone the strip scrolls sideways, and it is scrolled — the strip only,
 * never the page — so the chosen tab is in view: before this, the open
 * Settings tab could sit off the right edge with nothing to say it was there.
 */
export default function Tabs({ items, value, onChange, className = '', label = 'Sections', panelId = null }) {
  const listRef = useRef(null)

  useEffect(() => {
    const list = listRef.current
    const chosen = list?.querySelector('[aria-selected="true"]')
    if (!list || !chosen) return
    const left = chosen.offsetLeft - list.offsetLeft
    const right = left + chosen.offsetWidth
    if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - 16)
    else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 16
  }, [value])

  const keys = items.map((item) => item.key)
  // Nothing chosen yet (still loading): the first tab is the way in.
  const focusable = keys.includes(value) ? value : keys[0]

  return (
    <div ref={listRef} role="tablist" aria-label={label} onKeyDown={(e) => onTabKeyDown(e, keys, value, onChange)}
      className={`flex gap-6 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden ${className}`}>
      {items.map((item) => {
        const active = item.key === value
        return (
          <button
            key={item.key}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={item.key === focusable ? 0 : -1}
            data-tab-key={item.key}
            id={panelId ? tabIdOf(panelId, item.key) : undefined}
            aria-controls={panelId ?? undefined}
            onClick={() => onChange(item.key)}
            className={`relative shrink-0 flex items-center gap-1.5 pt-2 pb-3 text-[13px] font-semibold whitespace-nowrap transition-colors focus-visible:outline-none focus-visible:text-brand-700 focus-visible:underline underline-offset-4
              ${active ? 'text-gray-900' : 'text-gray-500 hover:text-gray-800'}`}
          >
            {item.icon && createElement(item.icon, { className: 'w-4 h-4', 'aria-hidden': true })}
            {item.label}
            {item.count > 0 && (
              <span className="min-w-5 h-4.5 px-1.5 rounded-full bg-brand-50 text-brand-700 text-[11px] font-bold leading-4.5 text-center">{item.count}</span>
            )}
            {active && <span aria-hidden="true" className="absolute left-0 right-0 -bottom-px h-0.75 rounded-t bg-logo" />}
          </button>
        )
      })}
    </div>
  )
}

/**
 * What the chosen tab shows: role="tabpanel", named by its tab, with the id
 * the tabs point at. `tab` is the chosen tab's key; with none (one section, so
 * no tabs drawn), a plain block.
 */
export function TabPanel({ id, tab, className = '', children }) {
  if (!tab) return <div className={className}>{children}</div>
  return (
    <div role="tabpanel" id={id} aria-labelledby={tabIdOf(id, tab)} className={className}>
      {children}
    </div>
  )
}
