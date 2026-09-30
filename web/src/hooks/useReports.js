import { useQuery } from '@tanstack/react-query'
import { api, saveFromApi } from '../api/http'

/**
 * Reports, from the server.
 *
 * Each report is worked out there from the records — counted in Postgres —
 * and comes back as columns, rows and totals. The version this replaces
 * downloaded whole tables into the browser and added them up there, showed
 * 12 / 12 / 18 / 24 / 5 days of leave for anybody without a balance row, and
 * could only ever show six months ending March 2026.
 */

function query({ year, month, departmentId, employeeId }) {
  const params = new URLSearchParams({ year: String(year), month: String(month) })
  if (departmentId) params.set('departmentId', departmentId)
  if (employeeId) params.set('employeeId', employeeId)
  return params.toString()
}

export function useReport(id, filters, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['reports', id, filters],
    queryFn: async () => (await api.get(`/reports/${id}?${query(filters)}`)).data,
    enabled: Boolean(id) && enabled,
  })
}

/** The same report as a CSV — made on the server from the same rows. */
export function downloadReport(id, filters) {
  return saveFromApi(`/reports/${id}?${query(filters)}&format=csv`)
}
