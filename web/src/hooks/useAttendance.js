import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api } from '../api/http'

/**
 * Attendance, served by our own API.
 *
 * THE BUG THIS REPLACES. The month query used to build its range end as
 * `${year}-${month}-31`. In February, April, June, September and November that
 * string is not a date, so the query returned nothing and the monthly view was
 * BLANK FIVE MONTHS A YEAR.
 *
 * Nobody reported it as a bug. They reported that attendance "sometimes does
 * not load", which is a much harder thing to act on — and it is why the range
 * is now built on the server, half-open, from a year and a month.
 *
 * Hook names and argument shapes are unchanged, so the Attendance page did not
 * have to be rewritten in the same commit that moved the data.
 */

const keys = {
  day: (date) => ['attendance', 'day', date],
  roster: (date) => ['attendance', 'roster', date],
  month: (year, month) => ['attendance', 'month', year, month],
  summary: (date) => ['attendance', 'summary', date ?? 'today'],
  monthly: (year, month) => ['attendance', 'monthly-summary', year, month],
}

function invalidateAll(queryClient) {
  queryClient.invalidateQueries({ queryKey: ['attendance'] })
  queryClient.invalidateQueries({ queryKey: ['dashboard'] })
}

export function useAttendance(date) {
  return useQuery({
    queryKey: keys.day(date),
    queryFn: async () => (await api.get(`/attendance?date=${date}`)).data,
    enabled: !!date,
  })
}

/**
 * A whole month.
 *
 * `year` and `month` go to the server as numbers and the range is built there,
 * so there is no date string for anyone to get wrong.
 */
/**
 * One day's roster: everybody the caller may see who was employed that day,
 * each with `attendance` — or `attendance: null`, which means NOT MARKED.
 *
 * Built by the server under one scope. The page used to build it itself, from
 * a separate employee list whose ids came from a different system, and the
 * two never matched: people who had punched in showed as unmarked.
 */
/*
 * Stepping to the next day or month keeps the last answer on screen until the
 * new one arrives (the page marks it as loading), rather than swapping the
 * whole page — its date controls included — for "Loading…" on every click.
 */
const keepPrevious = (previous) => previous

export function useDayRoster(date) {
  return useQuery({
    queryKey: keys.roster(date),
    queryFn: async () => (await api.get(`/attendance/day?date=${date}`)).data,
    enabled: !!date,
    placeholderData: keepPrevious,
  })
}

/** `employeeId` asks for one person's days only — one's own calendar, not the whole company's month. */
export function useMonthAttendance(year, month, { enabled = true, employeeId = null } = {}) {
  return useQuery({
    queryKey: [...keys.month(year, month), employeeId ?? 'all'],
    queryFn: async () => (await api.get(`/attendance?year=${year}&month=${month}${employeeId ? `&employeeId=${employeeId}` : ''}`)).data,
    enabled: enabled && Boolean(year && month),
    placeholderData: keepPrevious,
  })
}

/**
 * Monthly hours per employee — the figure the client asked for by name.
 *
 * Aggregated in Postgres. Summing the rows this page happened to load would
 * give a smaller number as soon as the list is paginated, and it would be
 * wrong in a way nobody would notice.
 */
/**
 * The company's days off in a month — holidays by name, and weekly offs — for
 * the calendar, which has no attendance rows on those days to draw from.
 */
export function useMonthCalendar(year, month, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['attendance', 'calendar', year, month],
    queryFn: async () => (await api.get(`/attendance/calendar?year=${year}&month=${month}`)).data,
    enabled: enabled && Boolean(year && month),
    staleTime: 5 * 60_000,
  })
}

export function useMonthlyHours(year, month, employeeId) {
  const query = employeeId ? `&employeeId=${employeeId}` : ''
  return useQuery({
    queryKey: [...keys.monthly(year, month), employeeId ?? 'all'],
    queryFn: async () =>
      (await api.get(`/attendance/monthly-summary?year=${year}&month=${month}${query}`)).data,
    enabled: Boolean(year && month),
  })
}

/** One day's company figures, for the dashboard. */
export function useAttendanceSummary(date) {
  return useQuery({
    queryKey: keys.summary(date),
    queryFn: async () =>
      (await api.get(date ? `/attendance/summary?date=${date}` : '/attendance/summary')).data,
  })
}

/**
 * HR recording somebody's day.
 *
 * Times go as wall clock — "09:30" — which is what HR types and what the shift
 * is written in. The server turns them into instants using the company's
 * timezone, so an overnight correction becomes two timestamps on different days
 * rather than a negative duration.
 */
export function useMarkAttendance() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ employee_uuid, date, status, check_in, check_out, note }) =>
      (
        await api.post('/attendance/mark', {
          employeeId: employee_uuid,
          date,
          status,
          checkIn: check_in || null,
          checkOut: check_out || null,
          note: note || null,
        })
      ).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/** Correcting an existing row. The employee and date come from the row. */
export function useAmendAttendance() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ id, status, check_in, check_out, note }) =>
      (
        await api.patch(`/attendance/${id}`, {
          status,
          checkIn: check_in || null,
          checkOut: check_out || null,
          note: note || null,
        })
      ).data,
    onSuccess: () => invalidateAll(queryClient),
  })
}

/**
 * Biometric CSV import.
 *
 * Preview unless `dryRun` is explicitly false, like the employee importer. The
 * preview reports `would_overwrite`, because replacing a day HR already fixed
 * by hand is worth knowing before rather than after.
 */
export function useImportAttendance() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({ csv, dryRun = true }) =>
      (await api.post('/attendance/import', { csv, dryRun })).data,
    onSuccess: (_result, variables) => {
      if (variables.dryRun === false) invalidateAll(queryClient)
    },
  })
}
