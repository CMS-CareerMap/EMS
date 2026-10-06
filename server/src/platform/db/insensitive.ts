/**
 * A value equal to another whatever the letters' case — and nothing else.
 *
 * Prisma asks Postgres for `mode: 'insensitive'` equality with ILIKE, and
 * passes the value through as a pattern: an Employee ID "CMS0_1" matched
 * "CMS001", and "%" matched everybody (found 6 Oct 2026). ILIKE's escape
 * character is the backslash, so `\`, `%` and `_` are escaped here to stand
 * for themselves.
 *
 * Callers still compare the rows they get back (`sameInsensitive`): if a later
 * Prisma ever escaped the value itself, this would match nothing rather than
 * the wrong person.
 */
export function equalsInsensitive(value: string): { equals: string; mode: 'insensitive' } {
  return { equals: value.replace(/[\\%_]/g, (c) => `\\${c}`), mode: 'insensitive' }
}

/** The same text, whatever the letters' case. */
export function sameInsensitive(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
