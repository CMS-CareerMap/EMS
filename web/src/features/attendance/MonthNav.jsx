import { ChevronLeft, ChevronRight } from 'lucide-react'
import { monthLabel, shiftMonth } from '../../lib/attendance'

/** The month shown, with a step back and a step on. `value` is "YYYY-MM". */
export default function MonthNav({ value, onChange, className = '' }) {
  const [year, month] = value.split('-').map(Number)
  const step = 'grid place-items-center w-8 h-8 rounded-md text-gray-500 hover:text-gray-900 hover:bg-gray-100 transition-colors'
  return (
    <div className={`inline-flex items-center gap-1 rounded-lg border border-gray-200 bg-white p-0.5 ${className}`}>
      <button type="button" onClick={() => onChange(shiftMonth(value, -1))} aria-label="Previous month" className={step}>
        <ChevronLeft className="w-4 h-4" />
      </button>
      <span className="min-w-30 text-center text-[13px] font-bold text-gray-900 tabular-nums" aria-live="polite">{monthLabel(year, month)}</span>
      <button type="button" onClick={() => onChange(shiftMonth(value, 1))} aria-label="Next month" className={step}>
        <ChevronRight className="w-4 h-4" />
      </button>
    </div>
  )
}
