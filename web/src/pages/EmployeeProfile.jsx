import { useState } from 'react'
import { Link, Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom'
import {
  ChevronLeft, Edit2, Landmark, CheckCircle2, XCircle, Clock, CircleDashed, Paperclip,
  ArrowRight, FileText, UserX, Wallet,
} from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useEmployee } from '../hooks/useEmployees'
import { useChecklist } from '../hooks/useDocuments'
import { ApiError } from '../api/http'
import DataState from '../components/DataState'
import ProfileCover from '../components/ui/ProfileCover'
import { TabPanel } from '../components/ui/Tabs'
import { Card, CardLink, Chip, EmptyState, Ring } from '../components/ui/bits'
import { btn } from '../components/ui/styles'
import AddEmployeeModal from '../features/employees/AddEmployeeModal'
import EmployeeLogins from '../features/employees/EmployeeLogins'
import EmploymentSection from '../features/employees/EmploymentSection'
import { formatDay } from '../lib/dates'
import { stageOf } from '../lib/lifecycle'

/**
 * One employee, as the server holds them — a page of its own (it was a drawer
 * over the list), opened from the list, the home page and the search.
 *
 * Each tab is drawn only when the server SENT its fields: salary to those who
 * hold compensation (and only within their salary reach), statutory numbers to
 * those who hold identity, bank details to those who hold bank, logins to those
 * who manage them. Drawing a tab anyway would show blanks that read as "none".
 *
 *   · Only recorded salary figures are shown — never an estimate from the CTC.
 *   · Documents stand against the company's checklist, for those who check
 *     them, with the way to their files.
 *   · A bank account is shown as recorded, the number by its last four digits;
 *     checking it is done under Payroll → Bank accounts.
 */

const BANK_STATUS = {
  verified: { label: 'Verified', tone: 'ok', icon: CheckCircle2 },
  rejected: { label: 'Rejected', tone: 'bad', icon: XCircle },
  pending: { label: 'Waiting for a check', tone: 'warn', icon: Clock },
  unverified: { label: 'Not checked yet', tone: 'gray', icon: CircleDashed },
}

const EMPLOYMENT_TYPE = { full_time: 'Full-time', part_time: 'Part-time', contract: 'Contract', intern: 'Intern' }
const ATTENDANCE_MODE = { app: 'App punch-in', biometric: 'Biometric machine', manual: 'Marked by HR' }
const WORK_ARRANGEMENT = { office: 'At the office', hybrid: 'Hybrid — office and home', remote: 'Remote' }
const GENDER = { male: 'Male', female: 'Female', other: 'Other' }

/** The stage's colour, in the chip tones. */
const STAGE_TONE = {
  joining_soon: 'info', onboarding: 'brand', probation: 'warn', confirmed: 'ok',
  resigned: 'warn', notice_period: 'leave', exit_due: 'bad', left: 'gray',
}

const money = (value) => (value == null ? '—' : '₹' + Number(value).toLocaleString('en-IN'))

export default function EmployeeProfile() {
  const { id } = useParams()
  const query = useEmployee(id)
  // The list as it was left — its search, filters and sort — when opened from
  // it; kept while the tabs here change the address.
  const location = useLocation()
  const [listUrl] = useState(() => `/employees${typeof location.state?.list === 'string' ? location.state.list : ''}`)
  // A mistyped address is refused before the lookup (400/422); both mean nobody is there.
  const notFound = query.error instanceof ApiError && [400, 404, 422].includes(query.error.status)

  // Shown a moment ago, gone now: a step here (an exit, a transfer away) took
  // them out of this login's sight. Back to the list, which says so.
  if (notFound && query.data) return <Navigate to={listUrl} replace state={{ gone: query.data.full_name }} />

  return (
    <div className="space-y-4">
      <Link to={listUrl} className="inline-flex items-center gap-1 text-xs font-semibold text-gray-500 hover:text-brand-700">
        <ChevronLeft className="w-3.5 h-3.5" aria-hidden="true" />Employees
        {query.data && <span className="text-gray-400 font-medium"> / <span className="text-gray-800">{query.data.full_name}</span></span>}
      </Link>

      {/* 404 also for somebody outside the caller's reach: the server does not say which. */}
      {notFound ? (
        <Card>
          <EmptyState icon={UserX} title="This employee could not be found">
            There is nobody at this address among the people you can see.{' '}
            <Link to={listUrl} className="font-semibold text-brand-600 hover:underline">Back to Employees</Link>
          </EmptyState>
        </Card>
      ) : (
        <DataState query={query} loading="Loading the profile…">
          {(employee) => <Profile employee={employee} />}
        </DataState>
      )}
    </div>
  )
}

function Profile({ employee }) {
  const can = useAuthStore((state) => state.can)
  const [params, setParams] = useSearchParams()
  const [editing, setEditing] = useState(false)
  const checksDocuments = can('document:verify')
  const has = (field) => Object.hasOwn(employee, field)

  const tabs = [
    { key: 'about', label: 'About' },
    { key: 'employment', label: 'Employment' },
    { key: 'logins', label: has('logins') ? 'Logins' : 'Login' },
    ...(checksDocuments ? [{ key: 'documents', label: 'Documents' }] : []),
    // Only when the server sent this person's salary at all: since Day 21 a
    // salary outside the caller's salary reach is left out, and "no salary is
    // recorded" would not be the truth.
    ...(can('employee:compensation:read') && has('ctc') ? [{ key: 'salary', label: 'Salary' }] : []),
    ...(has('pan') ? [{ key: 'statutory', label: 'Statutory' }] : []),
    ...(has('bank_name') ? [{ key: 'bank', label: 'Bank account' }] : []),
  ]
  const tab = tabs.some((t) => t.key === params.get('tab')) ? params.get('tab') : 'about'
  const setTab = (key) => setParams(key === 'about' ? {} : { tab: key }, { replace: true })

  const stage = employee.lifecycle_stage
  const left = Boolean(employee.archived_at)

  return (
    <>
      <ProfileCover
        name={employee.full_name}
        line={[employee.designation || 'No designation', employee.department, employee.employee_id].filter(Boolean).join(' · ')}
        chips={<>
          <Chip tone={employee.status === 'active' ? 'ok' : 'bad'}><span className="capitalize">{employee.status}</span></Chip>
          {EMPLOYMENT_TYPE[employee.employment_type] && <Chip tone="brand" dot={false}>{EMPLOYMENT_TYPE[employee.employment_type]}</Chip>}
          {stage && <Chip tone={STAGE_TONE[stage] ?? 'gray'}>{stageOf(stage).label}</Chip>}
        </>}
        // A record somebody left with is kept as it was: no Edit, as the list never offered one.
        action={can('employee:update') && !left && (
          <button type="button" onClick={() => setEditing(true)} className={btn.primary}>
            <Edit2 className="w-4 h-4" aria-hidden="true" />Edit
          </button>
        )}
        tabs={tabs} tab={tab} onTab={setTab} panelId="profile-panel"
      />

      {left && (
        <p className="text-xs font-medium text-gray-600 bg-gray-100 border border-gray-200 rounded-lg px-3 py-2">
          {employee.full_name} has left the company{employee.last_working_date ? ` — last working day ${formatDay(employee.last_working_date)}` : ''}. Their record is kept, and they cannot sign in.
        </p>
      )}

      <TabPanel id="profile-panel" tab={tabs.length > 1 ? tab : null} className="space-y-4">
      {tab === 'about' && <About employee={employee} />}
      {tab === 'employment' && (
        <Card title="Employment" subtitle="From joining to leaving">
          <EmploymentSection employeeId={employee.id} />
        </Card>
      )}
      {tab === 'logins' && (
        has('logins') ? (
          <Card title="Logins" subtitle="Each login has its own email and password">
            <EmployeeLogins employee={employee} />
          </Card>
        ) : (
          <Card title="Login">
            <Facts items={[['Work email', employee.email || 'No login']]} />
          </Card>
        )
      )}
      {tab === 'documents' && checksDocuments && <Documents employeeId={employee.id} />}
      {tab === 'salary' && <Salary employee={employee} />}
      {tab === 'statutory' && <Statutory employee={employee} />}
      {tab === 'bank' && <Bank employee={employee} />}
      </TabPanel>

      {/* Keyed, so each opening starts from the record as it is now. */}
      {editing && (
        <AddEmployeeModal key={employee.id} open initial={employee} onSave={() => {}} onClose={() => setEditing(false)} />
      )}
    </>
  )
}

function About({ employee }) {
  const has = (field) => Object.hasOwn(employee, field)
  const manager = employee.reporting_manager_name
    ? employee.reporting_manager_left
      ? `Nobody above — ${employee.reporting_manager_name} has left`
      : `${employee.reporting_manager_name}${employee.reporting_manager_designation ? ` (${employee.reporting_manager_designation})` : ''}`
    : 'Nobody above'

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 items-start">
      <Card title="Contact">
        <Facts columns={1} items={[
          ['Work email', employee.email || 'No login'],
          ['Phone', employee.phone],
          ['Personal email', employee.personal_email],
        ]} />
      </Card>
      <Card title="Employment details" className="lg:col-span-2">
        <Facts items={[
          ['Employee code', employee.employee_id, true],
          ['Department', employee.department],
          ['Designation', employee.designation],
          ['Date of joining', employee.date_of_joining ? formatDay(employee.date_of_joining) : null],
          ['Shift', employee.shift ? `${employee.shift.name} · ${employee.shift.start_time} – ${employee.shift.end_time}` : null],
          ['Attendance', ATTENDANCE_MODE[employee.attendance_mode]],
          ['Work arrangement', WORK_ARRANGEMENT[employee.work_arrangement]],
          // Who their leave goes to (Day 22: the company tree). One who has left decides nothing.
          ['Reports to', manager],
          ['Gender', GENDER[employee.gender]],
        ]} />
      </Card>
      {/* Personal details (client §42) — sent only to whoever reads statutory details, and to the person. */}
      {has('date_of_birth') && (
        <Card title="Personal details" className="lg:col-span-3">
          <Facts items={[
            ['Date of birth', employee.date_of_birth ? formatDay(employee.date_of_birth) : null],
            ['Nationality', employee.nationality],
            ['Address', employee.address],
            ['Emergency contact', employee.emergency_contact_name
              ? `${employee.emergency_contact_name}${employee.emergency_contact_relation ? ` (${employee.emergency_contact_relation})` : ''}${employee.emergency_contact_phone ? ` · ${employee.emergency_contact_phone}` : ''}`
              : null],
          ]} />
        </Card>
      )}
    </div>
  )
}

/**
 * Where somebody stands against the required documents — from their checklist.
 * A checklist that failed shows the error with a way to try again, not a
 * summary that reads as "nothing uploaded".
 */
function Documents({ employeeId }) {
  const checklist = useChecklist(employeeId)
  const to = `/documents?tab=employees&employee=${employeeId}`
  return (
    <Card title="Documents" subtitle="Against the company's checklist" action={<CardLink to={to}>Open their documents</CardLink>}>
      <DataState query={checklist} compact>
        {(data) => {
          const required = data.items.filter((i) => i.type.required)
          const verified = required.filter((i) => i.current?.status === 'verified').length
          return (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <Ring value={verified} total={required.length} size={64} stroke={7} label={`${verified} of ${required.length} required verified`}>
                  <span className="text-sm font-extrabold text-gray-900">{verified}/{required.length}</span>
                </Ring>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-gray-900">{verified} of {required.length} required verified</p>
                  <p className="text-xs text-gray-500 mt-0.5">Checking, rejecting and uploading are done on their documents page.</p>
                </div>
              </div>
              {data.items.length > 0 && (
                <ul className="divide-y divide-gray-100 border-t border-gray-100" aria-label="Their documents">
                  {data.items.map((item) => (
                    <li key={item.type.id} className="flex items-center gap-3 py-2.5">
                      <FileText className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 text-sm font-medium text-gray-900 truncate">
                        {item.type.label}
                        {item.type.required && <span className="ml-1.5 text-[11px] font-semibold text-gray-400">Required</span>}
                      </span>
                      <DocumentStatus status={item.current?.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )
        }}
      </DataState>
    </Card>
  )
}

function DocumentStatus({ status }) {
  if (status === 'verified') return <Chip tone="ok">Verified</Chip>
  if (status === 'pending') return <Chip tone="warn">Waiting for a check</Chip>
  if (status === 'rejected') return <Chip tone="bad">Rejected</Chip>
  return <Chip tone="gray">Not uploaded</Chip>
}

function Salary({ employee }) {
  // Null is "not recorded". Zero would say they earn nothing.
  if (employee.ctc == null) {
    return (
      <Card title="Salary">
        <EmptyState icon={Wallet} title="No salary is recorded yet">
          Accounts sets it under Payroll → Salary structure.
        </EmptyState>
      </Card>
    )
  }
  const components = employee.components ?? []
  const earnings = components.filter((c) => c.type === 'earning')
  const deductions = components.filter((c) => c.type === 'deduction')
  const gross = earnings.reduce((sum, c) => sum + Number(c.amount ?? 0), 0)

  return (
    <Card title="Salary" subtitle={`Since ${formatDay(employee.salary_effective_from)}`}>
      <div className="rounded-xl bg-logo-soft p-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-gray-600">Annual CTC</p>
          <p className="text-2xl font-extrabold tracking-tight text-gray-900 tabular-nums">{money(employee.ctc)}</p>
        </div>
        {earnings.length > 0 && <p className="text-xs text-gray-600">Gross <b className="text-gray-900 tabular-nums">{money(gross)}</b> a month</p>}
      </div>
      {components.length > 0 && (
        <dl className="mt-3 divide-y divide-gray-100">
          {[...earnings, ...deductions].map((c) => (
            <div key={c.code} className="flex items-center justify-between gap-3 py-2 text-sm">
              <dt className="text-gray-600">{c.label}{c.type === 'deduction' && <span className="text-gray-400"> · deduction</span>}</dt>
              <dd className="font-semibold text-gray-900 tabular-nums">{money(c.amount)} <span className="text-xs font-medium text-gray-400">/ month</span></dd>
            </div>
          ))}
        </dl>
      )}
    </Card>
  )
}

function Statutory({ employee }) {
  return (
    <Card title="Statutory details">
      <Facts items={[
        ['PAN', employee.pan, true],
        ['UAN', employee.uan || 'Not issued yet', true],
        ['PF member ID', employee.pf_acc_no, true],
        ['ESIC number', employee.esi_number, true],
        ['PT state', employee.pt_state],
        ['Provident Fund', employee.pf_applicable === false ? 'Does not apply'
          : employee.has_prior_pf_membership == null ? 'Applies · prior membership not asked'
          : employee.has_prior_pf_membership ? 'Applies · was a member before' : 'Applies · first PF membership'],
        ['Pension (EPS)', employee.eps_member == null ? 'Worked out by payroll from the joining salary' : employee.eps_member ? 'Member' : 'Not a member'],
      ]} />
    </Card>
  )
}

function Bank({ employee }) {
  const can = useAuthStore((state) => state.can)
  const status = BANK_STATUS[employee.bank_verification_status] ?? BANK_STATUS.unverified
  const manage = can('employee:bank:manage')
  return (
    <Card title="Bank account for salary">
      {!employee.bank_account ? (
        <EmptyState icon={Landmark} title="No bank account recorded">
          {manage ? <Link to="/payroll?tab=bank" className="font-semibold text-brand-600 hover:underline">Record it under Payroll → Bank accounts</Link> : null}
        </EmptyState>
      ) : (
        <div className="space-y-3">
          <Facts items={[
            ['Bank', employee.bank_name],
            ['Account', `•••• ${String(employee.bank_account).slice(-4)}`, true],
            ['IFSC', employee.ifsc, true],
            ['Verification', <Chip key="status" tone={status.tone} dot={false}><status.icon className="w-3 h-3" aria-hidden="true" />{status.label}</Chip>],
          ]} />
          {employee.bank_proof_name && (
            <p className="flex items-center gap-1.5 text-xs text-gray-500"><Paperclip className="w-3.5 h-3.5" aria-hidden="true" />Proof on file: {employee.bank_proof_name}</p>
          )}
          {employee.bank_verification_status === 'rejected' && employee.bank_verification_remarks && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-100 rounded-lg px-3 py-2">Why it was rejected: {employee.bank_verification_remarks}</p>
          )}
          {manage && (
            <Link to="/payroll?tab=bank" className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800">
              Check or change it under Payroll → Bank accounts <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
            </Link>
          )}
        </div>
      )}
    </Card>
  )
}

/** Label-and-value pairs in a grid. A third item marks a code, set in mono. */
function Facts({ items, columns = 2 }) {
  return (
    <dl className={`grid grid-cols-1 ${columns === 2 ? 'sm:grid-cols-2' : ''} gap-x-6 gap-y-4`}>
      {items.map(([label, value, mono]) => (
        <div key={label} className="min-w-0">
          <dt className="text-xs font-semibold text-gray-500">{label}</dt>
          <dd className={`text-sm font-semibold text-gray-900 mt-0.5 wrap-break-word ${mono ? 'font-mono' : ''}`}>{value || 'Not recorded'}</dd>
        </div>
      ))}
    </dl>
  )
}
