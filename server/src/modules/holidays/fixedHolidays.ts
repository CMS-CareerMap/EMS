/**
 * Only the three fixed-date national holidays. Diwali, Holi and Eid move with
 * the lunar calendar and states add their own; a guessed date would sit in the
 * leave calendar looking authoritative. The company enters those.
 *
 * One list for the seed a new company starts with and the nightly job that
 * adds the next year's (client, 25 Oct 2026), so the two cannot drift.
 */
export const FIXED_HOLIDAYS = [
  { name: 'Republic Day', month: 1, day: 26 },
  { name: 'Independence Day', month: 8, day: 15 },
  { name: 'Gandhi Jayanti', month: 10, day: 2 },
] as const
