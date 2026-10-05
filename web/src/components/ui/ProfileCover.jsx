import Tabs from './Tabs'
import { Avatar } from './bits'

/**
 * The top of a person's page — My Profile, and an employee's profile: the
 * logo's colours as a cover, the avatar over its edge, the name and a line
 * under it below the cover (never on it), the chips, one action, and the tabs.
 */
export default function ProfileCover({ name, line, chips, action, tabs, tab, onTab, label = 'Profile sections', panelId = null }) {
  return (
    <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="h-24 sm:h-28 bg-logo relative overflow-hidden" aria-hidden="true">
        <span className="absolute right-[12%] -top-6 w-28 h-28 rounded-full bg-white/25" />
        <span className="absolute -right-8 -bottom-16 w-44 h-44 rounded-full bg-white/15" />
      </div>
      <div className="px-4 sm:px-6 pb-4 flex flex-wrap items-start gap-x-4 gap-y-3">
        <Avatar name={name} size="xl" className="-mt-10 relative" />
        <div className="min-w-0 flex-1 pt-3">
          <h1 className="text-xl font-bold text-gray-900 wrap-break-word">{name}</h1>
          {line && <p className="text-xs text-gray-500 mt-0.5">{line}</p>}
          {chips && <div className="flex flex-wrap gap-1.5 mt-2">{chips}</div>}
        </div>
        {action && <div className="w-full sm:w-auto sm:pt-4 *:w-full sm:*:w-auto">{action}</div>}
      </div>
      {tabs && tabs.length > 1 && (
        <div className="px-4 sm:px-6 border-t border-gray-100">
          <Tabs items={tabs} value={tab} onChange={onTab} label={label} panelId={panelId} />
        </div>
      )}
    </section>
  )
}
