/**
 * The look of the everyday pieces, named once.
 *
 * A page that wants a primary button writes `btn.primary`, not twelve classes
 * it copied from another page. When the look changes, it changes here.
 */

const base = 'inline-flex items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:opacity-60 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-1 whitespace-nowrap'
const md = 'h-9 px-3.5 text-[13px]'
const sm = 'h-8 px-2.5 text-xs'

export const btn = {
  primary: `${base} ${md} bg-brand-600 text-white hover:bg-brand-700 shadow-[0_6px_14px_-8px_rgba(139,47,230,0.8)]`,
  secondary: `${base} ${md} border border-gray-200 bg-white text-gray-700 hover:bg-gray-50`,
  soft: `${base} ${md} bg-brand-50 text-brand-700 hover:bg-brand-100`,
  danger: `${base} ${md} bg-red-600 text-white hover:bg-red-700`,
  dangerOutline: `${base} ${md} border border-red-200 bg-white text-red-600 hover:bg-red-50`,
  ok: `${base} ${md} bg-emerald-50 text-emerald-700 hover:bg-emerald-100`,
  gradient: `${base} ${md} bg-logo text-white shadow-[0_8px_18px_-10px_rgba(210,70,160,0.9)] hover:brightness-105`,
  // The same, small — for row actions.
  primarySm: `${base} ${sm} bg-brand-600 text-white hover:bg-brand-700`,
  secondarySm: `${base} ${sm} border border-gray-200 bg-white text-gray-700 hover:bg-gray-50`,
  softSm: `${base} ${sm} bg-brand-50 text-brand-700 hover:bg-brand-100`,
  okSm: `${base} ${sm} bg-emerald-50 text-emerald-700 hover:bg-emerald-100`,
  dangerSm: `${base} ${sm} border border-red-200 bg-white text-red-600 hover:bg-red-50`,
  icon: 'inline-flex items-center justify-center w-9 h-9 rounded-lg text-gray-500 hover:text-gray-800 hover:bg-gray-100 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
}

/** A white card on the page. */
export const card = 'bg-white rounded-xl border border-gray-200 shadow-sm'

/** Form fields. */
export const field = 'border border-gray-200 bg-white rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:bg-gray-50 disabled:text-gray-500'

/** The same, small — for a filter in a row of them. */
export const fieldSm = 'border border-gray-200 bg-white rounded-lg px-2.5 py-1.5 text-xs text-gray-700 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:bg-gray-50 disabled:text-gray-500'

/** A file picker: its button in the soft brand look, the chosen name beside it. */
export const fileInput = 'block w-full text-sm text-gray-600 file:mr-3 file:h-8 file:px-3 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:text-xs file:font-semibold hover:file:bg-brand-100 file:cursor-pointer cursor-pointer'

/** Table head and cells. */
export const th = 'px-4 py-2.5 text-left text-[11px] font-bold text-gray-500 uppercase tracking-wider bg-gray-50 border-b border-gray-200 whitespace-nowrap'
export const td = 'px-4 py-3 text-sm text-gray-700 border-b border-gray-100'
