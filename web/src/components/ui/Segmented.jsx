import { createElement } from 'react'

/**
 * Two or three ways of looking at the same thing — List or Cards, Daily or
 * Monthly — as one control. `items` is [{ key, label, icon? }].
 */
export default function Segmented({ items, value, onChange, label, className = '' }) {
  return (
    <div className={`inline-flex rounded-lg border border-gray-200 p-0.5 bg-gray-50 ${className}`} role="group" aria-label={label}>
      {items.map((item) => (
        <button key={item.key} type="button" onClick={() => onChange(item.key)} aria-pressed={value === item.key}
          className={`inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-md text-[13px] font-semibold whitespace-nowrap transition-colors flex-1
            ${value === item.key ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'}`}>
          {item.icon && createElement(item.icon, { className: 'w-3.5 h-3.5', 'aria-hidden': true })}
          {item.label}
        </button>
      ))}
    </div>
  )
}
