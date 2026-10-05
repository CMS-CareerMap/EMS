import { createElement, useId } from 'react'
import { ChevronRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { TONES, initialsOf } from './tones'

/**
 * The small pieces every page is built from: a card, a figure, a status chip,
 * an avatar, a ring, and what an empty list says.
 */

/**
 * A white card, with an optional head: a title, a line under it, and a link on
 * the right. A titled card is named by its title, so a screen reader can jump
 * to "Waiting for you" as a region of the page.
 */
export function Card({ title, subtitle, action, children, className = '', bodyClassName = 'p-4', as = 'section' }) {
  const titleId = useId()
  return createElement(
    as,
    { className: `bg-white rounded-xl border border-gray-200 shadow-sm min-w-0 ${className}`, 'aria-labelledby': title ? titleId : undefined },
    title && (
      <div className="flex items-start gap-2 px-4 pt-4">
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="text-sm font-bold text-gray-900">{title}</h3>
          {subtitle && <p className="text-xs text-gray-500 mt-0.5">{subtitle}</p>}
        </div>
        {action}
      </div>
    ),
    <div className={bodyClassName}>{children}</div>,
  )
}

/** "Open all ›" in a card's head. */
export function CardLink({ to, children }) {
  return (
    <Link to={to} className="shrink-0 inline-flex items-center gap-0.5 text-[12.5px] font-semibold text-brand-600 hover:text-brand-800">
      {children}<ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
    </Link>
  )
}

/** A figure with its label and an icon in a soft square. */
export function StatTile({ label, value, icon, tone = 'brand', hint, onClick, active = false }) {
  const Tag = onClick ? 'button' : 'div'
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      aria-pressed={onClick ? active : undefined}
      className={`bg-white rounded-xl border shadow-sm p-3 sm:p-3.5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 min-w-0 text-left
        ${active ? 'border-brand-400 ring-2 ring-brand-100' : 'border-gray-200'} ${onClick ? 'hover:border-brand-300 transition-colors' : ''}`}
    >
      {icon && (
        <span className={`w-8 h-8 sm:w-10 sm:h-10 rounded-[10px] grid place-items-center shrink-0 ${TONES[tone].icon}`}>
          {createElement(icon, { className: 'w-4 h-4 sm:w-4.75 sm:h-4.75', 'aria-hidden': true })}
        </span>
      )}
      <span className="min-w-0">
        <span className="block text-lg sm:text-[21px] font-extrabold tracking-tight leading-tight text-gray-900 tabular-nums">{value}</span>
        <span className="block text-[11px] sm:text-xs font-medium text-gray-500 leading-snug">{label}</span>
        {hint && <span className="block text-[11px] text-gray-400 truncate">{hint}</span>}
      </span>
    </Tag>
  )
}

/** A status in a pill. `dot` draws the small coloured point before the words. */
export function Chip({ tone = 'gray', dot = true, children, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1.5 h-5.5 px-2.5 rounded-full text-[11.5px] font-semibold whitespace-nowrap ${TONES[tone].soft} ${className}`}>
      {dot && <span aria-hidden="true" className="w-1.5 h-1.5 rounded-full bg-current opacity-80" />}
      {children}
    </span>
  )
}

const AVATAR_COLOURS = [
  ['#FFA04A', '#FF5C8A'], ['#FF5C8A', '#D04FE6'], ['#C54BE8', '#8B2FE6'], ['#8B2FE6', '#3EC3FA'],
  ['#3EC3FA', '#5B7CF0'], ['#F59E0B', '#F2479A'], ['#14B8A6', '#3BB8F5'],
]
const hash = (s) => [...String(s)].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7)

/** Initials on a colour from the logo — the same colour for the same name on every screen. */
export function Avatar({ name, size = 'md', className = '' }) {
  const [a, b] = AVATAR_COLOURS[hash(name) % AVATAR_COLOURS.length]
  const sizes = { xs: 'w-6 h-6 text-[9px]', sm: 'w-7 h-7 text-[10.5px]', md: 'w-9 h-9 text-xs', lg: 'w-12 h-12 text-[15px]', xl: 'w-20 h-20 sm:w-21 sm:h-21 text-2xl border-4 border-white shadow-md' }
  return (
    <span aria-hidden="true" className={`rounded-full grid place-items-center font-bold text-white shrink-0 ${sizes[size]} ${className}`}
      style={{ background: `linear-gradient(135deg, ${a}, ${b})` }}>
      {initialsOf(name)}
    </span>
  )
}

/** A ring that fills to value/total — leave left, documents verified. */
export function Ring({ value, total, size = 72, stroke = 8, color = '#8B2FE6', children, label }) {
  const r = (size - stroke) / 2
  const length = 2 * Math.PI * r
  const share = total > 0 ? Math.max(0, Math.min(1, value / total)) : 0
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} role={label ? 'img' : undefined} aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#F1EDF7" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={`${(length * share).toFixed(1)} ${length.toFixed(1)}`} />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center leading-tight">{children}</div>
    </div>
  )
}

/** What a list says when it has nothing in it. */
export function EmptyState({ icon, title, children, className = '' }) {
  return (
    <div className={`text-center px-4 py-10 ${className}`}>
      {icon && (
        <span className="w-12 h-12 rounded-full bg-brand-50 text-brand-600 grid place-items-center mx-auto mb-3">
          {createElement(icon, { className: 'w-5 h-5', 'aria-hidden': true })}
        </span>
      )}
      <p className="text-sm font-semibold text-gray-900">{title}</p>
      {children && <div className="text-xs text-gray-500 mt-1 max-w-sm mx-auto">{children}</div>}
    </div>
  )
}

/** An icon in a soft square, before a line of a list. */
export function IconBox({ icon, tone = 'brand', size = 'md' }) {
  const sizes = { sm: 'w-7 h-7 rounded-lg', md: 'w-8 h-8 rounded-[9px]', lg: 'w-10 h-10 rounded-[11px]' }
  return (
    <span className={`grid place-items-center shrink-0 ${sizes[size]} ${TONES[tone].icon}`}>
      {createElement(icon, { className: size === 'lg' ? 'w-5 h-5' : 'w-4 h-4', 'aria-hidden': true })}
    </span>
  )
}
