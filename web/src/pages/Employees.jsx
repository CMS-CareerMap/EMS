import { useState, useMemo } from 'react'
import { Link, Navigate, useLocation, useNavigate, useNavigationType, useSearchParams } from 'react-router-dom'
import {
  Search, Plus, Download, Upload, MoreVertical, ChevronUp, ChevronDown, ChevronRight, Loader2,
  Users, Sparkles, Hourglass, LogOut, List, LayoutGrid, Edit2, Info, X,
} from 'lucide-react'
import AddEmployeeModal from '../features/employees/AddEmployeeModal'
import ImportEmployeesModal from '../features/employees/ImportEmployeesModal'
import { EscapeCloses } from '../hooks/useEscape'
import { useEmployees } from '../hooks/useEmployees'
import { useAuthStore } from '../stores/authStore'
import { saveFromApi } from '../api/http'
import { useDownload } from '../hooks/useDownload'
import DataState, { DataRows } from '../components/DataState'
import PageHeader from '../components/ui/PageHeader'
import Segmented from '../components/ui/Segmented'
import { Avatar, Chip, StatTile } from '../components/ui/bits'
import { btn, card, field, th, td } from '../components/ui/styles'
import { optionsNote } from '../lib/optionsNote'
import { formatDay } from '../lib/dates'
import { STAGE_ORDER, stageOf } from '../lib/lifecycle'

const STATUS_OPTIONS = ['All', 'active', 'inactive']

/** The server's values, with the labels people read. */
const EMP_TYPE = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', intern: 'Intern' }

/** The stage's colour, in the chip tones. */
const STAGE_TONE = {
  joining_soon: 'info', onboarding: 'brand', probation: 'warn', confirmed: 'ok',
  resigned: 'warn', notice_period: 'leave', exit_due: 'bad', left: 'gray',
}

/** The figures over the list; each one, clicked, filters the list to it. */
const TILES = [
  { key: 'active', label: 'Active', icon: Users, tone: 'brand', status: 'active' },
  { key: 'onboarding', label: 'Onboarding', icon: Sparkles, tone: 'info', stage: 'onboarding' },
  { key: 'probation', label: 'On probation', icon: Hourglass, tone: 'warn', stage: 'probation' },
  { key: 'notice', label: 'Serving notice', icon: LogOut, tone: 'leave', stage: 'notice_period' },
]

const VIEWS = [
  { key: 'list', label: 'List', icon: List },
  { key: 'cards', label: 'Cards', icon: LayoutGrid },
]

const VIEW_KEY = 'ems.employees.view'
function savedView() {
  try { return localStorage.getItem(VIEW_KEY) === 'cards' ? 'cards' : 'list' } catch { return 'list' }
}

/**
 * The search, filters and sort live in the address: a profile is a page of
 * its own, and coming back from it — its back link, or the browser's — used to
 * find the list reset. The menu's link opens the list afresh.
 */
const FILTER_DEFAULTS = { q: '', dept: 'All', status: 'All', stage: 'All', sort: 'full_name', dir: 'asc' }

/** One empty list, so the filters below are not recomputed on every render. */
const NO_EMPLOYEES = []

export default function Employees() {
  const [params, setParams] = useSearchParams()
  // An older link to somebody — a notification's "open" — goes to their profile page.
  const openParam = params.get('open')
  if (openParam) return <Navigate to={`/employees/${openParam}`} replace />
  return <EmployeeList params={params} setParams={setParams} />
}

function EmployeeList({ params, setParams }) {
  const navigate = useNavigate()
  const location = useLocation()
  // Somebody whose profile was open, taken out of sight by a step there.
  const gone = location.state?.gone ?? null
  const employeesQuery = useEmployees()
  const employees = employeesQuery.data ?? NO_EMPLOYEES
  // Counts only from a list the server actually sent. A request that failed
  // is not "0 total employees".
  const known = employeesQuery.data !== undefined && !employeesQuery.isError
  const canCreate = useAuthStore((state) => state.can('employee:create'))
  const companyWide = useAuthStore((state) => state.employeeReach === 'ORGANIZATION')
  const canUpdate = useAuthStore((state) => state.can('employee:update'))

  const filter = (key) => params.get(key) ?? FILTER_DEFAULTS[key]
  // Replaced, not pushed: Back leaves the list rather than undoing a filter.
  const setFilters = (changes) => setParams((prev) => {
    const next = new URLSearchParams(prev)
    for (const [key, value] of Object.entries(changes)) {
      if (value === FILTER_DEFAULTS[key]) next.delete(key)
      else next.set(key, value)
    }
    return next
  }, { replace: true })
  // The search box keeps its own text, copied into the address as it is
  // typed: drawn from the address alone, each keystroke waited for the router
  // (which updates in a transition), and fast typing lost letters. Back,
  // Forward or a link — anything but this page replacing its own address —
  // puts the address's text back in the box.
  const navigationType = useNavigationType()
  const [search, setSearchText] = useState(() => filter('q'))
  const [syncedKey, setSyncedKey] = useState(location.key)
  if (location.key !== syncedKey) {
    setSyncedKey(location.key)
    if (navigationType !== 'REPLACE') setSearchText(filter('q'))
  }
  const deptFilter = filter('dept')
  const statusFilter = filter('status')
  const stageFilter = filter('stage')
  const sortKey = filter('sort')
  const sortDir = filter('dir') === 'desc' ? 'desc' : 'asc'
  const setSearch = (value) => {
    setSearchText(value)
    setFilters({ q: value })
  }
  const setDeptFilter = (value) => setFilters({ dept: value })
  const setStatusFilter = (value) => setFilters({ status: value })
  const setStageFilter = (value) => setFilters({ stage: value })
  const [view, setView] = useState(savedView)
  const [modalOpen, setModalOpen] = useState(false)
  const [editTarget, setEditTarget] = useState(null)
  const [menuOpenId, setMenuOpenId] = useState(null)
  const [importOpen, setImportOpen] = useState(false)
  const { busy: exporting, start: startExport } = useDownload()

  // "Add employee" from the home page or the search opens the form — once per
  // link, followed while this page is already open.
  const addParam = params.get('add')
  const [followedAdd, setFollowedAdd] = useState(null)
  if (addParam !== followedAdd) {
    setFollowedAdd(addParam)
    if (addParam === '1' && canCreate) { setEditTarget(null); setModalOpen(true) }
  }

  // The company's own departments, from the people in the list — not a list
  // typed into this page that named departments the company does not have.
  const departments = useMemo(
    () => [...new Set(employees.map((e) => e.department).filter(Boolean))].sort(),
    [employees],
  )

  const counts = useMemo(() => ({
    active: employees.filter((e) => e.status === 'active').length,
    onboarding: employees.filter((e) => e.lifecycle_stage === 'onboarding').length,
    probation: employees.filter((e) => e.lifecycle_stage === 'probation').length,
    notice: employees.filter((e) => e.lifecycle_stage === 'notice_period').length,
  }), [employees])

  const filtered = useMemo(() => {
    let list = employees
    if (search.trim()) {
      const q = search.toLowerCase()
      list = list.filter((e) =>
        (e.full_name || '').toLowerCase().includes(q) ||
        (e.employee_id || '').toLowerCase().includes(q)
      )
    }
    if (deptFilter !== 'All') list = list.filter((e) => e.department === deptFilter)
    if (statusFilter !== 'All') list = list.filter((e) => e.status === statusFilter)
    if (stageFilter !== 'All') list = list.filter((e) => e.lifecycle_stage === stageFilter)
    list = [...list].sort((a, b) => {
      const av = a[sortKey] ?? ''
      const bv = b[sortKey] ?? ''
      return sortDir === 'asc' ? String(av).localeCompare(String(bv)) : String(bv).localeCompare(String(av))
    })
    return list
  }, [employees, search, deptFilter, statusFilter, stageFilter, sortKey, sortDir])

  function toggleSort(key) {
    setFilters(sortKey === key ? { dir: sortDir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: 'asc' })
  }

  function chooseView(next) {
    setView(next)
    try { localStorage.setItem(VIEW_KEY, next) } catch { /* storage blocked: the choice lasts this visit */ }
  }

  /** A tile sets its filter, or clears it when it is the one already set. */
  function tileOn(tile) {
    return tile.status ? statusFilter === tile.status && stageFilter === 'All' : stageFilter === tile.stage && statusFilter === 'All'
  }
  function pickTile(tile) {
    const on = tileOn(tile)
    // One change to the address: two in a row would each start from the old one.
    setFilters({ status: !on && tile.status ? tile.status : 'All', stage: !on && tile.stage ? tile.stage : 'All' })
  }

  function closeModal() {
    setModalOpen(false)
    setEditTarget(null)
    // The link that opened it is done with, so a reload does not open it again.
    if (params.get('add')) setParams((p) => { p.delete('add'); return p }, { replace: true })
  }

  function openAdd() { setEditTarget(null); setModalOpen(true) }
  function openEdit(emp) { setEditTarget(emp); setModalOpen(true); setMenuOpenId(null) }
  // A profile is told the list's address — its search, filters and sort — for its back link.
  const listState = (() => {
    const kept = new URLSearchParams(params)
    kept.delete('add')
    kept.delete('open')
    const rest = kept.toString()
    return { list: rest ? `?${rest}` : '' }
  })()
  const openProfile = (emp) => navigate(`/employees/${emp.id}`, { state: listState })

  // Made on the server with the page's filters and the caller's field access —
  // a CTC column only for those who may see salaries — through the one CSV writer.
  function handleExport() {
    const query = new URLSearchParams()
    if (search.trim()) query.set('search', search.trim())
    if (statusFilter !== 'All') query.set('status', statusFilter)
    if (stageFilter !== 'All') query.set('stage', stageFilter)
    if (deptFilter !== 'All') {
      const departmentId = employees.find((e) => e.department === deptFilter)?.department_id
      if (departmentId) query.set('departmentId', departmentId)
    }
    startExport('csv', () => saveFromApi(`/employees/export${query.size ? `?${query}` : ''}`))
  }

  const sortIcon = (key) => sortKey === key
    ? (sortDir === 'asc' ? <ChevronUp className="w-3 h-3 text-brand-600" aria-hidden="true" /> : <ChevronDown className="w-3 h-3 text-brand-600" aria-hidden="true" />)
    : <ChevronUp className="w-3 h-3 text-gray-300" aria-hidden="true" />
  const sortable = (key, label, className = '') => (
    <th className={`${th} ${className}`} aria-sort={sortKey === key ? (sortDir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" onClick={() => toggleSort(key)} className="inline-flex items-center gap-1 uppercase tracking-wider hover:text-gray-800">
        {label}{sortIcon(key)}
      </button>
    </th>
  )

  return (
    <>
      <PageHeader
        title="Employees"
        subtitle={known ? `${employees.length} ${employees.length === 1 ? 'person' : 'people'} · ${counts.active} active` : ' '}
        actions={<>
          <button onClick={handleExport} disabled={exporting === 'csv'} className={btn.secondary}>
            {exporting === 'csv' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" aria-hidden="true" />}
            Export
          </button>
          {/* A roster adds people outside any team or department: only a
              company-wide reach may, as the server says. */}
          {canCreate && companyWide && (
            <button onClick={() => setImportOpen(true)} className={btn.secondary}>
              <Upload className="w-4 h-4" aria-hidden="true" />Import
            </button>
          )}
          {canCreate && (
            <button onClick={openAdd} className={btn.primary}>
              <Plus className="w-4 h-4" aria-hidden="true" />Add Employee
            </button>
          )}
        </>}
      />

      <div className="space-y-4">
        {gone && (
          <div role="status" className="flex items-start gap-3 text-sm text-sky-900 bg-sky-50 border border-sky-100 rounded-xl px-4 py-3">
            <Info className="w-4 h-4 mt-0.5 shrink-0 text-sky-600" aria-hidden="true" />
            <p className="flex-1">{gone} is no longer among the people you can see — the step you took moved them out of your reach.</p>
            <button type="button" onClick={() => navigate({ search: location.search }, { replace: true, state: null })}
              aria-label="Dismiss" className="p-0.5 rounded text-sky-700 hover:text-sky-900"><X className="w-4 h-4" /></button>
          </div>
        )}
        {known && (
          <div className="hidden sm:grid grid-cols-4 gap-3">
            {TILES.map((tile) => (
              <StatTile key={tile.key} label={tile.label} value={counts[tile.key]} icon={tile.icon} tone={tile.tone}
                onClick={() => pickTile(tile)} active={tileOn(tile)} />
            ))}
          </div>
        )}

        <div className={`${card} overflow-hidden`}>
          {/* Filters */}
          <div className="px-4 py-3 flex flex-wrap gap-2.5 items-center border-b border-gray-200">
            <label className="relative flex-1 min-w-48">
              <span className="sr-only">Search employees</span>
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
              <input type="text" placeholder="Search by name or ID…" value={search} onChange={(e) => setSearch(e.target.value)}
                className={`w-full pl-9 ${field}`} />
            </label>
            <select value={deptFilter} onChange={(e) => setDeptFilter(e.target.value)} aria-label="Department" className={`${field} flex-1 sm:flex-none`}>
              {/* The departments are read off the list, so they share its fate. */}
              <option value="All">{optionsNote(employeesQuery, 'All departments')}</option>
              {departments.map((d) => <option key={d}>{d}</option>)}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} aria-label="Status" className={`${field} flex-1 sm:flex-none`}>
              {STATUS_OPTIONS.map((s) => (
                <option key={s} value={s}>{s === 'All' ? 'All Status' : s.charAt(0).toUpperCase() + s.slice(1)}</option>
              ))}
            </select>
            <select value={stageFilter} onChange={(e) => setStageFilter(e.target.value)} aria-label="Stage" className={`${field} flex-1 sm:flex-none`}>
              <option value="All">All Stages</option>
              {STAGE_ORDER.map((s) => <option key={s} value={s}>{stageOf(s).label}</option>)}
            </select>
            {known && (
              <span className="text-xs font-medium text-gray-500 sm:ml-auto">{filtered.length} result{filtered.length !== 1 ? 's' : ''}</span>
            )}
            <Segmented label="View" items={VIEWS} value={view} onChange={chooseView} className="hidden! md:inline-flex!" />
          </div>

          {/* On a phone: one line a person, the whole line opening the profile. */}
          <div className="md:hidden">
            <DataState query={employeesQuery} loading="Loading employees…" empty="No employees found." isEmpty={() => filtered.length === 0}>
              {() => (
                <ul className="divide-y divide-gray-100" aria-label="Employees">
                  {filtered.map((emp) => (
                    <li key={emp.id}>
                      <Link to={`/employees/${emp.id}`} state={listState} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50">
                        <Avatar name={emp.full_name} />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-semibold text-gray-900 truncate">{emp.full_name}</span>
                          <span className="block text-xs text-gray-500 truncate">{[emp.designation, emp.department].filter(Boolean).join(' · ') || emp.employee_id}</span>
                        </span>
                        <Chip tone={STAGE_TONE[emp.lifecycle_stage] ?? 'gray'}>{stageOf(emp.lifecycle_stage).label}</Chip>
                        <ChevronRight className="w-4 h-4 text-gray-300 shrink-0" aria-hidden="true" />
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </DataState>
          </div>

          {view === 'cards' ? (
            <div className="hidden md:block p-4">
              <DataState query={employeesQuery} loading="Loading employees…" empty="No employees found." isEmpty={() => filtered.length === 0}>
                {() => (
                  <ul className="grid grid-cols-2 xl:grid-cols-3 gap-3" aria-label="Employees">
                    {filtered.map((emp) => (
                      <li key={emp.id} className="rounded-xl border border-gray-200 p-4 hover:border-brand-300 hover:shadow-sm transition-colors flex flex-col gap-3">
                        <div className="flex items-start gap-3">
                          <Avatar name={emp.full_name} size="lg" />
                          <div className="min-w-0 flex-1">
                            <Link to={`/employees/${emp.id}`} state={listState} className="block text-sm font-bold text-gray-900 truncate hover:text-brand-700">{emp.full_name}</Link>
                            <p className="text-xs text-gray-500 truncate">{emp.designation || '—'}</p>
                            <p className="text-xs text-gray-400 font-mono mt-0.5">{emp.employee_id}</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          <Chip tone={STAGE_TONE[emp.lifecycle_stage] ?? 'gray'}>{stageOf(emp.lifecycle_stage).label}</Chip>
                          <Chip tone={emp.status === 'active' ? 'ok' : 'bad'}><span className="capitalize">{emp.status}</span></Chip>
                        </div>
                        <p className="text-xs text-gray-500">{emp.department || 'No department'} · joined {formatDay(emp.date_of_joining)}</p>
                        <div className="flex gap-2 mt-auto">
                          <Link to={`/employees/${emp.id}`} state={listState} className={`${btn.softSm} flex-1`}>View profile</Link>
                          {canUpdate && (
                            <button type="button" onClick={() => openEdit(emp)} className={btn.secondarySm} aria-label={`Edit ${emp.full_name}`}>
                              <Edit2 className="w-3.5 h-3.5" aria-hidden="true" />Edit
                            </button>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </DataState>
            </div>
          ) : (
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full min-w-200">
                <thead>
                  <tr>
                    {sortable('full_name', 'Employee', 'pl-5')}
                    {sortable('employee_id', 'ID')}
                    {sortable('department', 'Department')}
                    {sortable('date_of_joining', 'Joined')}
                    <th className={th}>Type</th>
                    <th className={th}>Stage</th>
                    <th className={th}>Status</th>
                    {/* Named by aria-label, not a hidden span: an absolutely placed span at the far
                        end of a scrolling table widens the whole page on a narrow screen. */}
                    <th className={`${th} text-right pr-5`} aria-label="Actions" />
                  </tr>
                </thead>
                <tbody>
                  {/* Empty means none match — and only once the list has loaded;
                      a list that failed shows the error, never "No employees". */}
                  <DataRows query={employeesQuery} colSpan={8} loading="Loading employees…"
                    empty="No employees found." isEmpty={() => filtered.length === 0}>
                    {() => filtered.map((emp, index) => (
                      <tr key={emp.id} className="hover:bg-gray-50 transition-colors cursor-pointer" onClick={() => openProfile(emp)}>
                        <td className={`${td} pl-5`}>
                          <div className="flex items-center gap-3">
                            <Avatar name={emp.full_name} />
                            <div className="min-w-0">
                              <Link to={`/employees/${emp.id}`} state={listState} onClick={(e) => e.stopPropagation()}
                                className="block text-sm font-semibold text-gray-900 truncate hover:text-brand-700">{emp.full_name}</Link>
                              <p className="text-xs text-gray-500 truncate">{emp.designation || '—'}</p>
                            </div>
                          </div>
                        </td>
                        <td className={`${td} font-mono text-gray-600`}>{emp.employee_id || '—'}</td>
                        <td className={td}>{emp.department || '—'}</td>
                        <td className={`${td} whitespace-nowrap`}>{formatDay(emp.date_of_joining)}</td>
                        <td className={td}>{EMP_TYPE[emp.employment_type] ? <Chip tone="brand" dot={false}>{EMP_TYPE[emp.employment_type]}</Chip> : '—'}</td>
                        <td className={td}><Chip tone={STAGE_TONE[emp.lifecycle_stage] ?? 'gray'}>{stageOf(emp.lifecycle_stage).label}</Chip></td>
                        <td className={td}><Chip tone={emp.status === 'active' ? 'ok' : 'bad'}><span className="capitalize">{emp.status}</span></Chip></td>
                        <td className={`${td} text-right pr-5`} onClick={(e) => e.stopPropagation()}>
                          <div className="relative inline-block">
                            <button type="button" onClick={() => setMenuOpenId(menuOpenId === emp.id ? null : emp.id)}
                              aria-label={`More for ${emp.full_name}`} aria-haspopup="menu" aria-expanded={menuOpenId === emp.id}
                              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-700 transition-colors">
                              <MoreVertical className="w-4 h-4" />
                            </button>
                            {menuOpenId === emp.id && (
                              <>
                                <EscapeCloses onClose={() => setMenuOpenId(null)} />
                                <div className="fixed inset-0 z-10" onClick={() => setMenuOpenId(null)} />
                                <div role="menu" className={`absolute right-0 ${index >= Math.max(1, filtered.length - 2) ? 'bottom-full mb-1' : 'top-full mt-1'} w-40 bg-white rounded-xl border border-gray-200 shadow-lg z-20 overflow-hidden py-1 text-left`}>
                                  <button role="menuitem" onClick={() => openProfile(emp)}
                                    className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                                    View Profile
                                  </button>
                                  {canUpdate && (
                                    <button role="menuitem" onClick={() => openEdit(emp)}
                                      className="w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-50 transition-colors">
                                      Edit
                                    </button>
                                  )}
                                  {/* No Deactivate here. It sent a status the employee
                                      endpoint refuses, so it could only ever fail;
                                      taking away access is Settings → Users. */}
                                </div>
                              </>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </DataRows>
                </tbody>
              </table>
            </div>
          )}

          {known && filtered.length > 0 && (
            <div className="px-4 sm:px-5 py-3 border-t border-gray-100 flex items-center justify-between gap-3 text-xs text-gray-500">
              <span>Showing {filtered.length} of {employees.length} employees</span>
              <span className="hidden md:inline">{view === 'cards' ? 'Open a card to see the profile' : 'Click a row to open the profile'}</span>
            </div>
          )}
        </div>
      </div>

      {/* Keyed, so each opening starts from the employee being edited. */}
      {modalOpen && (
        <AddEmployeeModal
          key={editTarget?.id ?? 'new'}
          open
          onClose={closeModal}
          initial={editTarget}
          onSave={() => {}}
        />
      )}

      {importOpen && <ImportEmployeesModal onClose={() => setImportOpen(false)} />}
    </>
  )
}
