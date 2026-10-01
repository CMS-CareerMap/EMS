import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { api, saveFromApi } from '../api/http'

/**
 * The audit log, read back. The server writes every row and turns each into
 * words; this only asks for pages of them — 50 at a time, each continuing from
 * the last row seen (its time and its id, so rows written in the same
 * millisecond are neither skipped nor repeated).
 *
 * Nothing here writes. There is no endpoint that could.
 */

/** The filters as the API spells them, leaving out the empty ones. */
function paramsOf(filters) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value)
  return params
}

export function useAuditLog(filters, { enabled = true } = {}) {
  const query = useInfiniteQuery({
    queryKey: ['audit-log', filters],
    queryFn: async ({ pageParam }) => {
      const params = paramsOf(filters)
      if (pageParam) {
        params.set('before', pageParam.before)
        params.set('beforeId', pageParam.beforeId)
      }
      const payload = await api.get(`/audit-log?${params}`)
      return { rows: payload.data, more: payload.meta.more, categories: payload.meta.categories }
    },
    initialPageParam: null,
    getNextPageParam: (last) => {
      const end = last.rows[last.rows.length - 1]
      return last.more && end ? { before: end.at, beforeId: end.id } : undefined
    },
    enabled,
    // A log is read to answer "what just happened?" — never an old copy.
    staleTime: 0,
    // While a new filter loads, the last answer stays in hand so the Area list
    // (which arrives with every page) does not blink away. The screen shows
    // "Loading…" rather than those old rows.
    placeholderData: (previous) => previous,
  })

  return query
}

/**
 * Who the log can be filtered by — `actors` (logins) and `employees`, archived
 * ones included — from the log's own permission. Not the Users and Employees
 * lists: whoever reads the log may hold neither, or reach only some of them.
 */
export function useAuditPeople() {
  return useQuery({
    queryKey: ['audit-log', 'people'],
    queryFn: async () => (await api.get('/audit-log/people')).data,
  })
}

/** The same filters, as a CSV. Taking it is itself recorded in the log. */
export function downloadAuditLog(filters) {
  return saveFromApi(`/audit-log/export?${paramsOf(filters)}`)
}
