/**
 * Plain values the Settings tabs share. Kept apart from ui.jsx, which exports
 * only components, so Vite's fast refresh can reload those in place.
 */

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** A calendar day, whatever zone the browser is in. */
export function formatDay(day) {
  if (!day) return '—'
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}
