import { useId } from 'react'
import { btn } from '../../components/ui/styles'
import { Check, Save, Loader2 } from 'lucide-react'

/**
 * The pieces every Settings tab is built from.
 *
 * Moved out of Settings.jsx when its tabs moved into their own files, so each
 * tab can be read — and fixed — on its own.
 */

// The shared field look (components/ui/styles `field`), written out: a file of
// components may export plain strings, not values worked out from others.
export const inp = 'w-full border border-gray-200 bg-white rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:bg-gray-50 disabled:text-gray-500'
export const inpSm = 'border border-gray-200 bg-white rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:bg-gray-50 disabled:text-gray-500'

/** A titled card of settings — named by its title, so it is a region a screen reader can jump to. */
export function Section({ title, desc, children }) {
  const titleId = useId()
  return (
    <section aria-labelledby={titleId} className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-gray-100">
        <h3 id={titleId} className="text-sm font-bold text-gray-900">{title}</h3>
        {desc && <p className="text-xs text-gray-500 mt-0.5">{desc}</p>}
      </div>
      <div className="px-4 sm:px-6 py-2">{children}</div>
    </section>
  )
}

export function Field({ label, hint, children }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 sm:gap-3 py-4 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm font-semibold text-gray-800">{label}</p>
        {hint && <p className="text-xs text-gray-500 mt-0.5">{hint}</p>}
      </div>
      <div className="sm:col-span-2 min-w-0">{children}</div>
    </div>
  )
}

/**
 * A save button that only says "Saved" once the server has said so.
 *
 * The one it replaces flipped to "Saved!" on click whether or not anything was
 * sent — on two tabs nothing ever was. `saving` comes from the mutation; `saved`
 * is set by the tab after the request succeeds.
 */
export function SaveBar({ onSave, saving, saved, disabled }) {
  return (
    <div className="flex justify-end pt-4">
      <button type="button" onClick={onSave} disabled={saving || disabled} className={`${btn.primary} w-full sm:w-auto`}>
        {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : saved ? <Check className="w-4 h-4" /> : <Save className="w-4 h-4" />}
        {saving ? 'Saving…' : saved ? 'Saved' : 'Save Changes'}
      </button>
    </div>
  )
}

/** type="button", so a toggle inside a form never submits it. */
export function Toggle({ checked, onChange, disabled, label }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1
        ${checked ? 'bg-brand-600' : 'bg-gray-200'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
        ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}
