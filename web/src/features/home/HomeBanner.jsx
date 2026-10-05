import { Link } from 'react-router-dom'
import { formatCalendarDay, calendarDayIn, isoInstant, wallClockIn } from '../../lib/dates'
import { useAuthStore } from '../../stores/authStore'

/**
 * The top of the home page, in the logo's colours: good morning, today's date,
 * a line about the day, and the two or three things this login does most —
 * only those its permissions allow.
 */
export default function HomeBanner({ name, line, actions }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const hour = Number(wallClockIn(timezone, isoInstant()).slice(0, 2))
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening'

  return (
    <section className="relative overflow-hidden rounded-2xl bg-logo text-white px-5 py-5 sm:px-6 sm:py-6 flex flex-wrap items-end gap-4" aria-label="Today">
      <span aria-hidden="true" className="absolute right-[12%] -top-10 w-40 h-40 rounded-full bg-white/25" />
      <span aria-hidden="true" className="absolute -right-10 -bottom-20 w-56 h-56 rounded-full bg-white/15" />
      <span aria-hidden="true" className="absolute inset-0 bg-[linear-gradient(90deg,rgba(26,16,41,0.28),rgba(26,16,41,0)_60%)]" />
      <div className="relative min-w-0">
        <p className="text-[12.5px] font-semibold text-white/90">{formatCalendarDay(calendarDayIn(timezone))}</p>
        <h1 className="text-2xl sm:text-[26px] font-extrabold tracking-tight leading-tight mt-1">{greeting}, {name}</h1>
        {line && <p className="text-[13px] text-white/95 mt-1">{line}</p>}
      </div>
      {actions.length > 0 && (
        <div className="relative flex flex-wrap gap-2 w-full sm:w-auto sm:ml-auto">
          {actions.map((action) => (
            <Link key={action.label} to={action.to}
              className="flex-1 sm:flex-none inline-flex items-center justify-center gap-2 h-9 px-3.5 rounded-lg text-[13px] font-semibold bg-white/20 border border-white/35 backdrop-blur-sm hover:bg-white/30 transition-colors whitespace-nowrap">
              <action.icon className="w-4 h-4" aria-hidden="true" />{action.label}
            </Link>
          ))}
        </div>
      )}
    </section>
  )
}
