/**
 * Recognising database errors that mean something to a person.
 *
 * P2002 is Prisma's "a unique constraint was violated". Most of the time it is
 * an ordinary thing somebody did — a duplicate code, a double tap — and deserves
 * a 409 with a sentence, not a 500.
 */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'P2002'
}
