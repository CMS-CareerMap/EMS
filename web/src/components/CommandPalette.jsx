import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, CornerDownLeft, User, CalendarPlus, FilePlus2, UserPlus, LogIn } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { visibleNavItems } from '../config/navigation'
import { useEmployees } from '../hooks/useEmployees'
import { useEscape } from '../hooks/useEscape'
import { Avatar } from './ui/bits'

/**
 * Search, opened by the bar in the header or Ctrl K: a page, a thing to do, or
 * a person.
 *
 * It offers only what this login may open — the menu's own list, the actions
 * its permissions allow, and the people its directory shows (the same list the
 * Employees page reads, already in the cache). Nothing here grants anything;
 * every page and every action is checked again where it lands.
 */
export default function CommandPalette({ onClose }) {
  const navigate = useNavigate()
  const { canAny, can, profile } = useAuthStore()
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  useEscape(onClose)

  const seesPeople = can('employee:read')
  const people = useEmployees({ enabled: seesPeople })

  const entries = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matches = (...texts) => !q || texts.some((t) => String(t ?? '').toLowerCase().includes(q))

    const pages = [
      ...visibleNavItems(canAny).map((item) => ({ key: `page:${item.to}`, group: 'Pages', label: item.title ?? item.label, icon: item.icon, to: item.to })),
      { key: 'page:/profile', group: 'Pages', label: 'My Profile', icon: User, to: '/profile' },
    ].filter((e) => matches(e.label))

    const actions = [
      // Only where Home has the Check In card: the machine's people and HR's are recorded there instead.
      profile && can('attendance:punch') && profile.attendance_mode === 'app' && { key: 'act:in', label: 'Check in or out', icon: LogIn, to: '/dashboard' },
      profile && can('leave:apply') && { key: 'act:leave', label: 'Apply for leave', icon: CalendarPlus, to: '/leave?apply=1' },
      profile && can('leave:apply') && { key: 'act:request', label: 'New request', icon: FilePlus2, to: '/requests?new=choose' },
      can('employee:create') && { key: 'act:employee', label: 'Add employee', icon: UserPlus, to: '/employees?add=1' },
    ].filter(Boolean).map((e) => ({ ...e, group: 'Actions' })).filter((e) => matches(e.label))

    const found = seesPeople && q
      ? (people.data ?? []).filter((e) => matches(e.full_name, e.employee_id, e.department, e.designation)).slice(0, 6)
        .map((e) => ({ key: `person:${e.id}`, group: 'People', label: e.full_name, sub: [e.employee_id, e.designation, e.department].filter(Boolean).join(' · '), person: e.full_name, to: `/employees/${e.id}` }))
      : []

    return [...actions, ...pages, ...found]
  }, [query, canAny, can, profile, seesPeople, people.data])

  const go = (entry) => {
    if (!entry) return
    onClose()
    navigate(entry.to)
  }

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(i + 1, entries.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); go(entries[index]) }
  }

  let lastGroup = null
  return (
    <div className="fixed inset-0 z-60 flex items-start justify-center bg-gray-950/40 backdrop-blur-[2px] p-3 sm:pt-[12vh]" onMouseDown={onClose}
      role="dialog" aria-modal="true" aria-label="Search">
      <div className="w-full max-w-xl bg-white rounded-2xl shadow-2xl border border-gray-200 overflow-hidden" onMouseDown={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 border-b border-gray-100">
          <Search className="w-5 h-5 text-gray-400 shrink-0" aria-hidden="true" />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0) }}
            onKeyDown={onKeyDown}
            placeholder={seesPeople ? 'Search people, pages or things to do…' : 'Search pages or things to do…'}
            aria-label="Search"
            className="flex-1 h-13 text-[15px] text-gray-900 placeholder:text-gray-400 focus:outline-none bg-transparent"
          />
          <kbd className="hidden sm:inline rounded-md border border-gray-200 px-1.5 py-0.5 text-[11px] font-semibold text-gray-500">Esc</kbd>
        </div>

        <div className="max-h-[60vh] overflow-y-auto p-2" role="listbox" aria-label="Results">
          {entries.length === 0 && (
            <p className="px-3 py-8 text-center text-sm text-gray-500">
              {seesPeople && people.isLoading ? 'Looking…' : `Nothing matches “${query.trim()}”.`}
            </p>
          )}
          {entries.map((entry, i) => {
            const head = entry.group !== lastGroup ? entry.group : null
            lastGroup = entry.group
            const active = i === index
            return (
              <div key={entry.key}>
                {head && <p className="px-3 pt-2.5 pb-1 text-[10.5px] font-bold uppercase tracking-wider text-gray-400">{head}</p>}
                <button
                  type="button"
                  role="option"
                  aria-selected={active}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => go(entry)}
                  className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left ${active ? 'bg-brand-50' : ''}`}
                >
                  {entry.person
                    ? <Avatar name={entry.person} size="sm" />
                    : <span className={`w-7 h-7 rounded-lg grid place-items-center ${active ? 'bg-white text-brand-600' : 'bg-gray-100 text-gray-500'}`}><entry.icon className="w-4 h-4" aria-hidden="true" /></span>}
                  <span className="min-w-0 flex-1">
                    <span className={`block text-sm font-semibold truncate ${active ? 'text-brand-800' : 'text-gray-800'}`}>{entry.label}</span>
                    {entry.sub && <span className="block text-xs text-gray-500 truncate">{entry.sub}</span>}
                  </span>
                  {active && <CornerDownLeft className="w-4 h-4 text-brand-400 shrink-0" aria-hidden="true" />}
                </button>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
