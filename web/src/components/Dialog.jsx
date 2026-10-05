import { X } from 'lucide-react'
import { useEscape } from '../hooks/useEscape'

/**
 * Every dialog in the app: a title, a close button, and whatever it asks.
 *
 * It opens near the top of the screen and scrolls with its content, so a long
 * form (an employee's record, a payroll approval) is never cut off on a phone.
 */
export default function Dialog({ title, children, onClose, wide = false }) {
  useEscape(onClose)
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-gray-950/45 backdrop-blur-[2px] p-3 sm:p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`bg-white rounded-2xl shadow-[0_30px_70px_-20px_rgba(26,16,41,0.5)] w-full ${wide ? 'max-w-3xl' : 'max-w-xl'} my-6 sm:my-10 overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 px-5 sm:px-6 py-4 border-b border-gray-100">
          <p className="text-[15.5px] font-bold text-gray-900">{title}</p>
          <button onClick={onClose} aria-label="Close" className="p-2 -mr-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 sm:p-6 space-y-4">{children}</div>
      </div>
    </div>
  )
}

/** A field's look without its width, for rows that size their own fields. */
export const fieldCls = 'border border-gray-200 bg-white rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-brand-500 disabled:bg-gray-50 disabled:text-gray-500'
export const inputCls = `w-full ${fieldCls}`
