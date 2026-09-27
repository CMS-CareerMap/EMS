import { Check, Save, Loader2 } from 'lucide-react'

/**
 * The pieces every Settings tab is built from.
 *
 * Moved out of Settings.jsx when its tabs moved into their own files, so each
 * tab can be read — and fixed — on its own.
 */

export const inp = 'w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 placeholder:text-gray-400 bg-white'
export const inpSm = 'border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-gray-900 bg-white'

export function Section({ title, desc, children }) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="px-6 py-4 border-b border-gray-100">
        <p className="text-base font-semibold text-gray-900">{title}</p>
        {desc && <p className="text-sm text-gray-400 mt-0.5">{desc}</p>}
      </div>
      <div className="px-6 py-2">{children}</div>
    </div>
  )
}

export function Field({ label, hint, children }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 py-4 border-b border-gray-100 last:border-0">
      <div>
        <p className="text-sm font-medium text-gray-700">{label}</p>
        {hint && <p className="text-xs text-gray-400 mt-0.5">{hint}</p>}
      </div>
      <div className="sm:col-span-2">{children}</div>
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
      <button type="button" onClick={onSave} disabled={saving || disabled}
        className="flex items-center gap-2 px-5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 text-white text-sm font-medium transition-colors">
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
      className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0 disabled:opacity-50
        ${checked ? 'bg-blue-600' : 'bg-gray-200'}`}>
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform
        ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  )
}
