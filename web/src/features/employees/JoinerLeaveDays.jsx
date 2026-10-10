import { useState } from 'react'
import { ChevronDown } from 'lucide-react'
import DataState from '../../components/DataState'
import { useLeaveTypes } from '../../hooks/useSettings'

/**
 * Add Employee → Leave (client, 9 Oct 2026): a new joiner's own days a year
 * of the paid leave types, where they differ from the company's — fifteen days
 * of casual leave agreed in the offer letter. Optional, and folded away: an
 * empty box is the company's days. Their share of this leave year is given the
 * moment they are added, by each type's rule for joiners. Changed later on the
 * profile's Leave tab.
 *
 * `value` maps a leave type's id to what was typed.
 */
export default function JoinerLeaveDays({ value, onChange, error }) {
  const types = useLeaveTypes()
  const [open, setOpen] = useState(Object.values(value).some((v) => v !== ''))
  const paid = (types.data ?? []).filter((t) => t.paid)

  return (
    <div>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open || Boolean(error)}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-800">
        <ChevronDown className={`w-4 h-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        Their own leave days a year (optional)
      </button>
      {/* Kept open while something in it is wrong: a folded section cannot hide why Add Employee was refused. */}
      {(open || error) && (
        <div className="mt-3 space-y-3">
          <p className="text-xs text-gray-500">
            Leave a box empty for the company’s days. Their share of this leave year is given the moment they are added — by each type’s rule for a new joiner.
          </p>
          <DataState query={types} compact isEmpty={() => paid.length === 0} empty="No paid leave types are set up.">
            {() => (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {paid.map((t) => (
                  <label key={t.id} className="block space-y-1">
                    <span className="text-xs font-medium text-gray-600">{t.name}</span>
                    <input type="number" min="0" max="365" step="0.5" inputMode="decimal" value={value[t.id] ?? ''}
                      placeholder={t.days > 0 ? `${t.days} (company)` : 'None (company)'}
                      onChange={(e) => onChange({ ...value, [t.id]: e.target.value })}
                      aria-label={`${t.name} days a year`}
                      className={`w-full border ${error ? 'border-red-400 bg-red-50' : 'border-gray-300'} rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent placeholder:text-gray-400 text-gray-900 bg-white`} />
                  </label>
                ))}
              </div>
            )}
          </DataState>
          {error && <p className="text-xs text-red-500">{error}</p>}
        </div>
      )}
    </div>
  )
}
