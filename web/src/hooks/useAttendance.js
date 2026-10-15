import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { api, fetchBlob } from '../api/http'

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

/**
 * `live` (today's or yesterday's roster, watched by somebody who sees others):
 * asked again every minute and on coming back to the tab, so a check-in or
 * check-out made meanwhile shows without a reload, and the time at work it runs
 * stops for somebody who has left (client, 9 Oct 2026). A failed refresh keeps
 * the last answer on the page (DataState keepOnRefetchError), without a toast.
 */
export function useDayRoster(date, { live = false } = {}) {
  return useQuery({
    queryKey: keys.roster(date),
    queryFn: async () => (await api.get(`/attendance/day?date=${date}`)).data,
    enabled: !!date,
    placeholderData: keepPrevious,
    refetchInterval: live ? 60_000 : false,
    refetchOnWindowFocus: live,
    meta: { quietRefetch: true },
  })
}

/**
 * Punches worth a second look between two days (client, 11 Oct 2026): refused,
 * flagged, or not borne out by the fingerprint machine. Under ['attendance'],
 * so an import or a correction refreshes it.
 */
export function useSuspiciousPunches(from, to) {
  return useQuery({
    queryKey: ['attendance', 'suspicious', from, to],
    queryFn: async () => (await api.get(`/attendance/suspicious?from=${from}&to=${to}`)).data,
    enabled: Boolean(from && to),
    placeholderData: keepPrevious,
  })
}

/** One person's punches on a day, with their evidence (client, 11 Oct 2026) — for the roster's "Evidence". */
export function useDayEvidence(employeeId, date) {
  return useQuery({
    queryKey: ['attendance', 'evidence', employeeId, date],
    queryFn: async () => (await api.get(`/attendance/evidence?employeeId=${employeeId}&date=${date}`)).data,
    enabled: Boolean(employeeId && date),
  })
}

/**
 * A punch's selfie, as a data address the page can show at once — a small
 * photo (~50 KB), so nothing to make and let go of, and shown again from the
 * cache whenever the dialog opens. Said on the photo if it fails, not twice.
 */
export function usePunchPhoto(id) {
  return useQuery({
    queryKey: ['attendance', 'evidence', 'photo', id],
    queryFn: async () => asDataUrl(await fetchBlob(`/attendance/evidence/${id}/photo`)),
    enabled: Boolean(id),
    staleTime: Infinity,
    meta: { quietCodes: ['NOT_FOUND', 'FILE_UNAVAILABLE'] },
  })
}

function asDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error ?? new Error('The photo could not be read.'))
    reader.readAsDataURL(blob)
  })
}

/**
 * One person's month (client, 15 Oct 2026): who they are, their days, the
 * company's days off, the month in pay terms and the month so far — the page
 * a name on Attendance opens, and one's own figures. With the server's clock
 * (`server_now`, `received_at`), so today's time at work runs by it.
 */
export function usePersonMonth(employeeId, year, month, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['attendance', 'person', employeeId, year, month],
    queryFn: async () => {
      const res = await api.get(`/attendance/people/${employeeId}/month?year=${year}&month=${month}`)
      return { ...res.data, server_now: res.meta?.server_now ?? null, received_at: Date.now() }
    },
    enabled: enabled && Boolean(employeeId && year && month),
    // Somebody outside the caller's reach is said on the page itself, not as a toast too.
    meta: { quietCodes: ['NOT_FOUND'] },
  })
}

/**
 * Phones of the people in reach — those waiting, or all (one phone per
 * employee); `employeeId` asks for one person's, on their page. For whoever
 * holds "replace or reset a punch phone".
 */
export function useDevices(status = 'waiting', { enabled = true, employeeId = null } = {}) {
  return useQuery({
    queryKey: ['attendance', 'devices', status, employeeId ?? 'all'],
    queryFn: async () => (await api.get(`/attendance/devices?status=${status}${employeeId ? `&employee=${employeeId}` : ''}`)).data,
    enabled,
  })
}

/** Replace (`approve`: this phone is theirs, the old one off) — or take a phone off: their phone reset, or a waiting one refused. */
export function useDecideDevice() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, approve }) => (await api.post(`/attendance/devices/${id}/${approve ? 'approve' : 'retire'}`, {})).data,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['attendance', 'devices'] }),
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

/**
 * One's own month in pay terms (client, 10 Oct 2026): days paid and days of
 * loss of pay so far — as payroll will count them — each day of approved
 * leave by its type, and each absent day with whether leave can still be
 * asked for it. Read again whenever leave or attendance changes (both
 * invalidate ['attendance']).
 */
export function useMyPayDays(year, month, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['attendance', 'me', 'pay-days', year, month],
    queryFn: async () => (await api.get(`/attendance/me/pay-days?year=${year}&month=${month}`)).data,
    enabled: enabled && Boolean(year && month),
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
