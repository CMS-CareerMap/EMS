import { Link } from 'react-router-dom'
import { ChevronLeft } from 'lucide-react'
import Tabs from './Tabs'

/**
 * The white band at the top of every page: its title, a line under it, the
 * page's own buttons, and its tabs.
 *
 * It reaches the edges of the page area (the negative margins undo the page
 * padding), so the tabs sit on the band's bottom line as one strip.
 *
 * `back` is { to, label } for a page opened from another — a profile from the
 * Employees list.
 */
export default function PageHeader({ title, subtitle, actions, tabs, tab, onTab, back, panelId = null, children }) {
  // One tab is no choice: none is drawn, and the band keeps its bottom padding.
  const showTabs = Boolean(tabs && tabs.length > 1)
  return (
    <div className={`-mx-4 -mt-4 sm:-mx-6 sm:-mt-6 mb-5 sm:mb-6 bg-white border-b border-gray-200 px-4 sm:px-6 pt-4 sm:pt-5 ${showTabs ? '' : 'pb-4 sm:pb-5'}`}>
      {back && (
        <Link to={back.to} className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-brand-700 mb-2">
          <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />{back.label}
        </Link>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-[19px] leading-tight font-bold tracking-[-0.01em] text-gray-900">{title}</h1>
          {subtitle && <div className="text-[12.5px] text-gray-500 mt-1">{subtitle}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto [&>*]:flex-1 sm:[&>*]:flex-none">{actions}</div>}
      </div>
      {children}
      {showTabs && <Tabs items={tabs} value={tab} onChange={onTab} className="mt-3" label={`${title} sections`} panelId={panelId} />}
    </div>
  )
}
