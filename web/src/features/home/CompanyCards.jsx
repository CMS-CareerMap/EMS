import { Link } from 'react-router-dom'
import { FileText, Gift, ShieldCheck, Upload } from 'lucide-react'
import DataState from '../../components/DataState'
import { Avatar, Card, CardLink, Chip, EmptyState, IconBox } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { usePeopleSummary } from '../../hooks/useDashboard'
import { useCompliance, useCompanyDocuments } from '../../hooks/useDocuments'
import { useHolidays } from '../../hooks/useLeave'
import { useAuthStore } from '../../stores/authStore'
import { calendarDayIn, formatDay, formatDayOf } from '../../lib/dates'

/**
 * The home page's cards about the company: its people, the papers waiting for
 * a check, its documents and its holidays.
 */

const DEPARTMENT_COLOURS = ['#8B2FE6', '#3BB8F5', '#FF8A3D', '#F2479A', '#0E9F6E', '#F59E0B', '#14B8A6', '#6366F1']
const SHORT_MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

/** Who works here within this login's reach: how many, where, who joined, who is leaving. */
export function PeopleCard() {
  const people = usePeopleSummary()
  return (
    <DataState query={people}>
      {(p) => {
        const top = Math.max(1, ...p.by_department.map((d) => d.headcount))
        return (
          <Card title="People" subtitle={`${p.active} active${p.inactive ? ` · ${p.inactive} left` : ''}`} action={<CardLink to="/employees">Employees</CardLink>}>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
              <div>
                <p className="text-4xl font-extrabold tracking-tight text-gray-900 tabular-nums leading-none">{p.active}</p>
                <p className="text-xs text-gray-500 mt-1 mb-2.5">active employees</p>
                <Chip tone={p.joiners.length ? 'ok' : 'gray'}>{p.joiners.length} joined in the last 60 days</Chip>
                {p.leaving.length > 0 && (
                  <p className="text-xs text-gray-500 mt-2.5">
                    Leaving: {p.leaving.slice(0, 2).map((e) => `${e.full_name} (${formatDay(e.last_working_date, { year: false })})`).join(', ')}{p.leaving.length > 2 ? ` and ${p.leaving.length - 2} more` : ''}
                  </p>
                )}
                {p.recently_left.length > 0 && (
                  <p className="text-xs text-gray-500 mt-1.5">
                    Left: {p.recently_left.slice(0, 2).map((e) => `${e.full_name} (${formatDay(e.last_working_date, { year: false })})`).join(', ')}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs font-bold text-gray-700 mb-2">By department</p>
                {p.by_department.length === 0
                  ? <p className="text-xs text-gray-500">Nobody yet.</p>
                  : (
                    <ul className="space-y-2">
                      {p.by_department.map((d, i) => (
                        <li key={d.department} className="grid grid-cols-[minmax(0,7rem)_1fr_1.5rem] items-center gap-2 text-xs">
                          <span className="truncate text-gray-700" title={d.department}>{d.department}</span>
                          <span className="h-2 rounded-full bg-gray-100 overflow-hidden" aria-hidden="true">
                            <span className="block h-full rounded-full" style={{ width: `${(d.headcount / top) * 100}%`, background: DEPARTMENT_COLOURS[i % DEPARTMENT_COLOURS.length] }} />
                          </span>
                          <b className="text-right tabular-nums text-gray-900">{d.headcount}</b>
                        </li>
                      ))}
                    </ul>
                  )}
              </div>
              <div>
                <p className="text-xs font-bold text-gray-700 mb-2">New joiners · last 60 days</p>
                {p.joiners.length === 0
                  ? <p className="text-xs text-gray-500">Nobody joined in the last 60 days.</p>
                  : (
                    <ul className="space-y-2.5">
                      {p.joiners.slice(0, 4).map((e) => (
                        <li key={e.id}>
                          <Link to={`/employees/${e.id}`} className="flex items-center gap-2.5 group">
                            <Avatar name={e.full_name} size="sm" />
                            <span className="min-w-0">
                              <span className="block text-[13px] font-semibold text-gray-900 truncate group-hover:text-brand-700">{e.full_name}</span>
                              <span className="block text-xs text-gray-500 truncate">{[e.designation, e.department].filter(Boolean).join(' · ')} · {formatDay(e.date_of_joining)}</span>
                            </span>
                          </Link>
                        </li>
                      ))}
                      {p.joiners.length > 4 && <li className="text-xs text-gray-500">and {p.joiners.length - 4} more</li>}
                    </ul>
                  )}
              </div>
            </div>
          </Card>
        )
      }}
    </DataState>
  )
}

/** Papers to check, and people missing required ones — for whoever verifies documents. */
export function DocumentsCard() {
  const compliance = useCompliance()
  return (
    <Card title="Documents to check" subtitle="Employee papers" action={<CardLink to="/documents?tab=employees">Documents</CardLink>}>
      <DataState query={compliance} compact>
        {(data) => {
          const waiting = data.waiting?.length ?? 0
          const missing = (data.employees ?? []).filter((e) => e.missing > 0)
          return (
            <ul className="divide-y divide-gray-100">
              <li className="flex items-center gap-3 pb-3">
                <IconBox icon={ShieldCheck} tone={waiting ? 'warn' : 'ok'} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-gray-900">{waiting} waiting for a check</p>
                  <p className="text-xs text-gray-500">{waiting ? 'Uploaded and not yet verified' : 'Nothing uploaded is waiting'}</p>
                </div>
                {waiting > 0 && <Link to="/documents?tab=employees" className={btn.secondarySm}>Check</Link>}
              </li>
              <li className="flex items-center gap-3 pt-3">
                <IconBox icon={FileText} tone={missing.length ? 'warn' : 'ok'} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-gray-900">
                    {missing.length ? `${missing.length} ${missing.length === 1 ? 'person misses' : 'people miss'} a required document` : 'Everybody has their required documents'}
                  </p>
                  {missing.length > 0 && <p className="text-xs text-gray-500 truncate">{missing.slice(0, 3).map((e) => e.full_name).join(', ')}{missing.length > 3 ? '…' : ''}</p>}
                </div>
              </li>
            </ul>
          )
        }}
      </DataState>
    </Card>
  )
}

/** The company's policies and handbook. */
export function CompanyDocumentsCard() {
  const docs = useCompanyDocuments()
  const publishes = useAuthStore((state) => state.can('document:company:manage'))
  const timezone = useAuthStore((state) => state.organization?.timezone)
  return (
    <Card title="Company documents" subtitle="Policies and handbook" action={<CardLink to="/documents?tab=company">All</CardLink>}>
      <DataState query={docs} compact empty={<EmptyState icon={FileText} title="No company documents yet" />}>
        {(list) => (
          <ul className="divide-y divide-gray-100">
            {list.slice(0, 3).map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 py-2.5 first:pt-0 last:pb-0">
                <IconBox icon={FileText} />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-semibold text-gray-900 truncate">{doc.title}</p>
                  {/* The day on the company's clock: an instant's first ten characters are the UTC day. */}
                  <p className="text-xs text-gray-500 truncate">{doc.description || `Published ${formatDayOf(doc.uploaded_at, timezone)}`}</p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </DataState>
      {publishes && <Link to="/documents?tab=company" className={`${btn.softSm} mt-3`}><Upload className="w-3.5 h-3.5" aria-hidden="true" />Publish a document</Link>}
    </Card>
  )
}

/** Where holidays are entered: Settings → Leave Config, at its Holidays section. */
const HOLIDAY_SETTINGS = '/settings?tab=leave#holidays'

/**
 * The next holidays from HR's list — this year's and next year's.
 *
 * A new company starts with only the three fixed national holidays; the
 * festivals move every year, and HR enters them. So once this year's entered
 * holidays are behind us, the next one is in January — said plainly, so it does
 * not look like the calendar skipped the rest of the year, with the way to add
 * them for whoever keeps the calendar.
 */
export function HolidaysCard() {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const canManage = useAuthStore((state) => state.can('holiday:manage'))
  const today = calendarDayIn(timezone)
  const year = Number(today.slice(0, 4))
  const thisYear = useHolidays(year)
  const nextYear = useHolidays(year + 1)
  const addLink = (label) => (
    <Link to={HOLIDAY_SETTINGS} className="font-semibold text-brand-600 hover:text-brand-800 underline-offset-2 hover:underline">{label}</Link>
  )
  return (
    <DataState queries={[thisYear, nextYear]}>
      {([a, b]) => {
        const upcoming = [...a, ...b].filter((h) => h.date >= today && h.type !== 'weekly_off').sort((x, y) => x.date.localeCompare(y.date))
        const [next, ...rest] = upcoming
        if (!next) {
          return (
            <Card title="Upcoming holidays" action={<CardLink to="/leave?tab=holidays">All</CardLink>}>
              <EmptyState icon={Gift} title="No holidays ahead">
                HR has not entered any holidays after today.
                {canManage && <span className="block mt-2">{addLink('Add holidays')}</span>}
              </EmptyState>
            </Card>
          )
        }
        const noneLeftThisYear = Number(next.date.slice(0, 4)) > year
        const days = Math.round((new Date(`${next.date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86_400_000)
        return (
          <section className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden" aria-label="Upcoming holidays">
            <div className="relative overflow-hidden p-4 text-white bg-[linear-gradient(135deg,#FF9A4D,#F2479A_55%,#A93CEB)]">
              <span aria-hidden="true" className="absolute -right-8 -bottom-10 w-36 h-36 rounded-full bg-white/15" />
              <p className="relative text-[11px] font-bold uppercase tracking-wider text-white/90">
                Next holiday · {days === 0 ? 'today' : days === 1 ? 'tomorrow' : `in ${days} days`}
              </p>
              <p className="relative text-lg font-extrabold mt-1">{next.name}</p>
              <p className="relative text-[13px] text-white/95">{WEEKDAYS[new Date(`${next.date}T00:00:00Z`).getUTCDay()]}, {formatDay(next.date)}</p>
            </div>
            <div className="p-4">
              {noneLeftThisYear && (
                <p className="text-xs rounded-lg bg-amber-50 text-amber-800 px-3 py-2 mb-3">
                  No more holidays entered for {year}.
                  {/* "Add holidays", not "this year's": after Christmas it is next year's that are missing. */}
                  {canManage && <span className="block mt-0.5">{addLink('Add holidays')}</span>}
                </p>
              )}
              {rest.length === 0
                ? <p className="text-xs text-gray-500">No more holidays entered after this one.</p>
                : (
                  <ul className="space-y-2.5">
                    {rest.slice(0, 2).map((h) => (
                      <li key={h.id ?? h.date} className="flex items-center gap-3">
                        <span className="w-11 shrink-0 rounded-[10px] overflow-hidden text-center border border-gray-200">
                          <span className="block text-[9.5px] font-extrabold tracking-wider text-white bg-logo py-0.5">{SHORT_MONTHS[Number(h.date.slice(5, 7)) - 1]}</span>
                          <span className="block text-base font-extrabold py-0.5">{Number(h.date.slice(8, 10))}</span>
                        </span>
                        <span className="min-w-0">
                          <span className="block text-[13px] font-semibold text-gray-900 truncate">{h.name}</span>
                          <span className="block text-xs text-gray-500">{formatDay(h.date, { weekday: true })}</span>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              <Link to="/leave?tab=holidays" className="inline-flex items-center gap-1 mt-3 text-[12.5px] font-semibold text-brand-600 hover:text-brand-800">Holiday calendar</Link>
            </div>
          </section>
        )
      }}
    </DataState>
  )
}

