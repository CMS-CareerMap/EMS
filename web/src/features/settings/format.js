/**
 * Plain values the Settings tabs share. Kept apart from ui.jsx, which exports
 * only components, so Vite's fast refresh can reload those in place.
 */

export const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

/** A calendar day, whatever zone the browser is in. */
export { formatDay } from '../../lib/dates'
