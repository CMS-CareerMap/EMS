/**
 * For a <select> whose options come from a query: the first option says what
 * is happening, so a failed list reads "Could not load — …" instead of an
 * empty dropdown that looks like there is nothing to choose.
 */
export function optionsNote(query, ready) {
  if (query?.isError) return `Could not load the list — ${query.error?.message ?? 'try again'}`
  if (query?.isLoading) return 'Loading…'
  return ready
}
