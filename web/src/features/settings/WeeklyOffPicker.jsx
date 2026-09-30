import { CalendarOff } from 'lucide-react'
import { usePayrollSettings, useSavePayroll } from '../../hooks/useSettings'
import DataState from '../../components/DataState'

/**
 * Which days the company is closed.
 *
 * It lives on the Leave tab rather than the Payroll one, even though the value
 * is stored with the payroll policy, because this is where somebody looks for
 * it: "which days are we off" is a question about leave, not about PF rates.
 * The endpoint it happens to use is an implementation detail.
 *
 * Each day saves on click, like the other toggles here. A Save button that has
 * to be found afterwards is how a half-finished change ends up looking exactly
 * like a saved one.
 */

/** Sunday first, matching the numbers the server stores. */
const DAYS = [
  { value: 0, label: 'Sun', full: 'Sunday' },
  { value: 1, label: 'Mon', full: 'Monday' },
  { value: 2, label: 'Tue', full: 'Tuesday' },
  { value: 3, label: 'Wed', full: 'Wednesday' },
  { value: 4, label: 'Thu', full: 'Thursday' },
  { value: 5, label: 'Fri', full: 'Friday' },
  { value: 6, label: 'Sat', full: 'Saturday' },
]

export default function WeeklyOffPicker() {
  const settings = usePayrollSettings()

  // Only the real days: a failed load drawn as "no weekly offs" would save
  // one clicked day over the whole stored week.
  return (
    <DataState query={settings} loading="Loading working days…" compact>
      {(policy) => <Days selected={policy.weekly_off_days ?? []} />}
    </DataState>
  )
}

function Days({ selected }) {
  const savePayroll = useSavePayroll()

  function toggle(value) {
    const next = selected.includes(value)
      ? selected.filter((d) => d !== value)
      : [...selected, value].sort((a, b) => a - b)

    // The server refuses all seven, and so does this — but refusing here means
    // the person gets a disabled button rather than an error after the click.
    if (next.length >= 7) return

    savePayroll.mutate({ weeklyOffDays: next })
  }

  const workingDays = 7 - selected.length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {DAYS.map((day) => {
          const isOff = selected.includes(day.value)
          // Turning on the seventh would close the company entirely.
          const wouldCloseEverything = !isOff && selected.length === 6

          return (
            <button
              key={day.value}
              type="button"
              onClick={() => toggle(day.value)}
              disabled={savePayroll.isPending || wouldCloseEverything}
              title={
                wouldCloseEverything
                  ? 'The company cannot be closed every day'
                  : isOff
                    ? `${day.full} is a weekly off`
                    : `${day.full} is a working day`
              }
              className={`px-3.5 py-2 rounded-lg text-sm font-medium border transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                isOff
                  ? 'bg-amber-50 border-amber-300 text-amber-900'
                  : 'bg-white border-gray-300 text-gray-700 hover:bg-gray-50'
              }`}
            >
              {day.label}
            </button>
          )
        })}
      </div>

      <p className="text-xs text-gray-500 flex items-start gap-1.5">
        <CalendarOff className="w-3.5 h-3.5 shrink-0 mt-0.5" />
        <span>
          {selected.length === 0 ? (
            'No weekly offs — every day counts as a working day, so leave is charged for weekends too.'
          ) : (
            <>
              Closed on{' '}
              <strong className="text-gray-700">
                {DAYS.filter((d) => selected.includes(d.value))
                  .map((d) => d.full)
                  .join(' and ')}
              </strong>
              . A {workingDays}-day week — leave applications skip these days and
              are not charged for them.
            </>
          )}
        </span>
      </p>
    </div>
  )
}
