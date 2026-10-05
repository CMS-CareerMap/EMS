import { useState } from 'react'
import { Download, Loader2, RotateCw, X } from 'lucide-react'
import { Section, inpSm } from './ui'
import DataState, { QueryError } from '../../components/DataState'
import { useAuditLog, useAuditPeople, downloadAuditLog } from '../../hooks/useAuditLog'
import { useDownload } from '../../hooks/useDownload'
import { useAuthStore } from '../../stores/authStore'
import { optionsNote } from '../../lib/optionsNote'
import { formatInstant } from '../../lib/dates'

/**
 * Settings → Audit log: who did what, and when.
 *
 * Every sign-in and refused sign-in, every request the system turned down,
 * role and salary changes, each step of a payroll, every document anybody
 * opened, and every file that left the system. Newest first; nothing on this
 * screen — or anywhere — can change or remove a row.
 *
 * The server turns each row into a sentence with names in it. The filters are
 * the questions an audit is asked: what happened between these days, in this
 * area, by this person, or to this person.
 */

const NO_FILTERS = { from: '', to: '', category: '', actor: '', employee: '' }

export default function AuditLog() {
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const [filters, setFilters] = useState(NO_FILTERS)
  const set = (key) => (e) => setFilters((f) => ({ ...f, [key]: e.target.value }))
  const backwards = Boolean(filters.from && filters.to && filters.from > filters.to)
  // A date box hands over every keystroke of the year — 0002, 0020, 0202 —
  // and each would be a refused request. Asked for only once it is a real year.
  const typing = [filters.from, filters.to].some((d) => d && d < '2000-01-01')
  const ready = !backwards && !typing

  const log = useAuditLog(filters, { enabled: ready })
  // Everybody who has ever been here: the log is asked about people who left too.
  const people = useAuditPeople()
  const { busy, start } = useDownload()

  const filtered = Object.values(filters).some(Boolean)
  // The areas arrive with every page. Kept once known, so a request that
  // fails does not empty the list while a chosen area stays applied unseen.
  const [categories, setCategories] = useState([])
  const arrived = log.data?.pages[0]?.categories
  if (arrived?.length && categories.length === 0) setCategories(arrived)
  // A failed "Load older" is said beside the button; the rows already loaded stay.
  const olderFailed = log.isFetchNextPageError
  const listQuery = olderFailed ? { ...log, isError: false } : log
  const actors = people.data?.actors ?? []
  const staff = people.data?.employees ?? []

  return (
    <Section title="Audit log" desc="Every sign-in, refusal, change, download and export, newest first. Nothing here can be changed or deleted.">
      <div className="py-4 space-y-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-3">
          <label className="text-xs font-medium text-gray-600 space-y-1">
            <span>From</span>
            <input type="date" value={filters.from} max={filters.to || undefined} onChange={set('from')} className={`${inpSm} w-full`} />
          </label>
          <label className="text-xs font-medium text-gray-600 space-y-1">
            <span>To</span>
            <input type="date" value={filters.to} min={filters.from || undefined} onChange={set('to')} className={`${inpSm} w-full`} />
          </label>
          <label className="text-xs font-medium text-gray-600 space-y-1">
            <span>Area</span>
            <select value={filters.category} onChange={set('category')} className={`${inpSm} w-full`}>
              <option value="">All areas</option>
              {categories.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600 space-y-1">
            <span>Done by</span>
            <select value={filters.actor} onChange={set('actor')} className={`${inpSm} w-full`}>
              <option value="">{optionsNote(people, 'Anybody')}</option>
              {actors.map((u) => <option key={u.user_id} value={u.user_id}>{u.name}</option>)}
            </select>
          </label>
          <label className="text-xs font-medium text-gray-600 space-y-1">
            <span>About</span>
            <select value={filters.employee} onChange={set('employee')} className={`${inpSm} w-full`}>
              <option value="">{optionsNote(people, 'Anyone')}</option>
              {staff.map((e) => <option key={e.id} value={e.id}>{e.name}{e.code ? ` (${e.code})` : ''}</option>)}
            </select>
          </label>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {filtered && (
            <button type="button" onClick={() => setFilters(NO_FILTERS)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50">
              <X className="w-3.5 h-3.5" aria-hidden="true" /> Clear filters
            </button>
          )}
          <button type="button" onClick={() => log.refetch()} disabled={log.isFetching || !ready}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm text-gray-700 border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-60">
            <RotateCw className={`w-3.5 h-3.5 ${log.isFetching && !log.isFetchingNextPage ? 'animate-spin' : ''}`} aria-hidden="true" /> Refresh
          </button>
          <button type="button" onClick={() => start('export', () => downloadAuditLog(filters))} disabled={busy === 'export' || !ready}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-60 sm:ml-auto">
            {busy === 'export' ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Download className="w-3.5 h-3.5" aria-hidden="true" />}
            Export CSV
          </button>
        </div>

        {backwards ? (
          <p role="alert" className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3">
            The start date is after the end date. Choose a start on or before the end.
          </p>
        ) : typing ? (
          <p className="text-sm text-gray-400 text-center py-10">Finish typing the date.</p>
        ) : log.isPlaceholderData ? (
          <p className="text-sm text-gray-400 text-center py-10">Loading…</p>
        ) : (
          <DataState
            query={listQuery}
            isEmpty={(data) => data.pages[0].rows.length === 0}
            empty={filtered ? 'Nothing recorded matches these filters.' : 'Nothing has been recorded yet.'}>
            {(data) => {
              const rows = data.pages.flatMap((p) => p.rows)
              return (
                <>
                  <Rows rows={rows} timezone={timezone} />
                  <div className="flex flex-col sm:flex-row items-center justify-between gap-2 pt-2">
                    <p className="text-xs text-gray-500">
                      Showing {rows.length} {rows.length === 1 ? 'entry' : 'entries'}{log.hasNextPage ? ' — there are older ones' : ''}
                    </p>
                    {log.hasNextPage && (
                      <button type="button" onClick={() => log.fetchNextPage()} disabled={log.isFetchingNextPage}
                        className="px-3 py-1.5 text-sm font-medium text-brand-700 border border-brand-200 rounded-lg hover:bg-brand-50 disabled:opacity-60">
                        {log.isFetchingNextPage ? 'Loading…' : olderFailed ? 'Try loading older entries again' : 'Load older entries'}
                      </button>
                    )}
                  </div>
                  {olderFailed && <QueryError error={log.error} compact />}
                </>
              )
            }}
          </DataState>
        )}
      </div>
    </Section>
  )
}

function Who({ actor }) {
  if (!actor) return <span className="text-gray-500 italic">Nobody signed in</span>
  return (
    <>
      <span className="font-medium text-gray-900">{actor.name}</span>
      {actor.role && <span className="block text-xs text-gray-500">{actor.role}</span>}
    </>
  )
}

function Where({ row }) {
  if (!row.ip && !row.device && !row.request_id) return <span className="text-gray-300">—</span>
  return (
    <span className="text-xs text-gray-500 space-y-0.5 block">
      {row.device && <span className="block">{row.device}</span>}
      {row.ip && <span className="block">{row.ip}</span>}
      {/* The whole reference is in the tooltip and the CSV; the start is enough to find it in the server log. */}
      {row.request_id && <span className="block text-gray-400" title={row.request_id}>Ref {row.request_id.slice(0, 8)}</span>}
    </span>
  )
}

function Rows({ rows, timezone }) {
  return (
    <>
      {/* On a phone, one card an entry: when, then what, then who. */}
      <ul className="md:hidden divide-y divide-gray-100 border border-gray-100 rounded-lg">
        {rows.map((row) => (
          <li key={row.id} className="p-3 space-y-1">
            <p className="text-xs text-gray-500">{formatInstant(row.at, timezone)}</p>
            <p className="text-sm font-semibold text-gray-900">{row.action_label}</p>
            <p className="text-sm text-gray-700 break-words">{row.summary}</p>
            <p className="text-xs text-gray-500">
              {row.actor ? `${row.actor.name}${row.actor.role ? ` · ${row.actor.role}` : ''}` : 'Nobody signed in'}
              {row.device ? ` · ${row.device}` : ''}{row.ip ? ` · ${row.ip}` : ''}
            </p>
          </li>
        ))}
      </ul>

      <div className="hidden md:block overflow-x-auto border border-gray-100 rounded-lg">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
              <th className="px-4 py-3 text-left whitespace-nowrap">When</th>
              <th className="px-4 py-3 text-left">Who</th>
              <th className="px-4 py-3 text-left">What happened</th>
              <th className="px-4 py-3 text-left">Device</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b border-gray-100 last:border-0 align-top">
                <td className="px-4 py-3 text-gray-600 whitespace-nowrap">{formatInstant(row.at, timezone)}</td>
                <td className="px-4 py-3 min-w-36"><Who actor={row.actor} /></td>
                <td className="px-4 py-3">
                  <span className="font-medium text-gray-900">{row.action_label}</span>
                  {row.category_label && <span className="ml-2 text-xs text-gray-400">{row.category_label}</span>}
                  <span className="block text-gray-700 break-words">{row.summary}</span>
                </td>
                <td className="px-4 py-3 min-w-32"><Where row={row} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
