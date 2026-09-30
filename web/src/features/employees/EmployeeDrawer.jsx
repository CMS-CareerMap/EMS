import { createElement } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  X, Mail, Phone, Building2, Briefcase, Calendar, BadgeCheck, Edit2, Users, Clock,
  Landmark, CheckCircle2, XCircle, UserRound, KeyRound, Fingerprint, CalendarX,
  FileText, Paperclip, ArrowRight, CircleDashed,
} from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import { useChecklist } from '../../hooks/useDocuments'
import { roleLabel } from '../../lib/roles'

/**
 * One employee, as the server holds them.
 *
 * Each section is shown only to somebody permitted to see it — salary to those
 * who hold compensation, statutory numbers to those who hold identity, bank
 * details to those who hold bank — because the server only SENDS those fields
 * to them. Rendering the section anyway would show blanks that read as "none".
 *
 * What was removed, and why:
 *   · The salary card fell back to an ESTIMATE computed from the CTC whenever no
 *     salary was recorded, and presented it as the person's pay. Only recorded
 *     figures are shown now.
 *   · The documents list said "Not uploaded" for three documents it never
 *     looked for. It now shows where they really stand against the company's
 *     checklist, for those who check documents, with the way to their files.
 *   · Bank verification ran against the old store. It is done under Payroll →
 *     Bank accounts now; this card shows the account as recorded — the number
 *     by its last four digits, as every list does — and links there.
 */

/** A bank account's status as the rest of the app words it. */
const BANK_STATUS = {
  verified: { label: 'Verified', cls: 'bg-emerald-100 text-emerald-800', icon: CheckCircle2 },
  rejected: { label: 'Rejected', cls: 'bg-rose-100 text-rose-800', icon: XCircle },
  pending: { label: 'Waiting for a check', cls: 'bg-amber-100 text-amber-800', icon: Clock },
  unverified: { label: 'Not checked yet', cls: 'bg-gray-100 text-gray-700', icon: CircleDashed },
}

const EMPLOYMENT_TYPE = {
  full_time: { label: 'Full-time', cls: 'bg-blue-100 text-blue-700' },
  part_time: { label: 'Part-time', cls: 'bg-amber-100 text-amber-700' },
  contract: { label: 'Contract', cls: 'bg-purple-100 text-purple-700' },
  intern: { label: 'Intern', cls: 'bg-teal-100 text-teal-700' },
}

const STATUS_CLASS = {
  active: 'bg-green-100 text-green-700',
  inactive: 'bg-red-100 text-red-600',
}

const ATTENDANCE_MODE = { app: 'App punch-in', biometric: 'Biometric machine', manual: 'Marked by HR' }
const GENDER = { male: 'Male', female: 'Female', other: 'Other' }
const ACCOUNT = { active: 'Can sign in', invited: 'Invited — has not set a password', inactive: 'Access removed' }

function money(value) {
  return value == null ? '—' : '₹' + Number(value).toLocaleString('en-IN')
}

function formatDate(day) {
  if (!day) return '—'
  return new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC',
  })
}

export default function EmployeeDrawer({ employee, onClose, onEdit }) {
  const can = useAuthStore((state) => state.can)
  const navigate = useNavigate()
  // Those who check documents see where this person stands; asked for only
  // while the drawer is open on somebody.
  const checksDocuments = can('document:verify')
  const documents = useChecklist(employee?.id, { enabled: Boolean(employee) && checksDocuments })

  if (!employee) return null

  const openDocuments = () => {
    onClose()
    navigate(`/documents?tab=employees&employee=${employee.id}`)
  }
  const openBankAccounts = () => {
    onClose()
    navigate('/payroll?tab=bank')
  }
  const bankStatus = BANK_STATUS[employee.bank_verification_status] ?? BANK_STATUS.unverified

  const initials = (employee.full_name || '').split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase()
  const type = EMPLOYMENT_TYPE[employee.employment_type]
  const components = employee.components ?? []

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 bg-black/40 z-40" onClick={onClose} />

      {/* Drawer */}
      <div className="fixed right-0 top-0 h-full w-full max-w-md bg-white shadow-2xl z-50 flex flex-col">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 shrink-0">
          <p className="text-base font-semibold text-gray-900">Employee Profile</p>
          <div className="flex items-center gap-2">
            {can('employee:update') && (
              <button onClick={onEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-50 hover:bg-blue-100 text-blue-600 text-sm font-medium transition-colors">
                <Edit2 className="w-3.5 h-3.5" />
                Edit
              </button>
            )}
            <button onClick={onClose}
              className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">

          {/* Profile header */}
          <div className="px-6 py-6 bg-linear-to-br from-blue-50 to-white border-b border-gray-100">
            <div className="flex items-start gap-4">
              <div className="w-16 h-16 rounded-2xl bg-blue-600 flex items-center justify-center shrink-0">
                <span className="text-white text-xl font-bold">{initials}</span>
              </div>
              <div className="min-w-0 pt-1">
                <h2 className="text-xl font-bold text-gray-900 truncate">{employee.full_name}</h2>
                <p className="text-sm text-gray-500 mt-0.5">{employee.designation || 'No designation'}</p>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium capitalize ${STATUS_CLASS[employee.status] ?? 'bg-gray-100 text-gray-700'}`}>
                    {employee.status}
                  </span>
                  {type && (
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${type.cls}`}>
                      {type.label}
                    </span>
                  )}
                </div>
              </div>
            </div>
          </div>

          {/* Details */}
          <div className="px-6 py-5 space-y-6">

            <Section title="Contact Information">
              <InfoRow icon={Mail} label="Work Email (login)" value={employee.email || 'No login'} />
              <InfoRow icon={Mail} label="Personal Email" value={employee.personal_email || '—'} />
              <InfoRow icon={Phone} label="Phone" value={employee.phone || '—'} />
            </Section>

            <Section title="Employment Details">
              <InfoRow icon={BadgeCheck} label="Employee Code" value={employee.employee_id} />
              <InfoRow icon={Building2} label="Department" value={employee.department || '—'} />
              <InfoRow icon={Briefcase} label="Designation" value={employee.designation || '—'} />
              <InfoRow icon={Calendar} label="Date of Joining" value={formatDate(employee.date_of_joining)} />
              {employee.last_working_date && (
                <InfoRow icon={CalendarX} label="Last Working Day" value={formatDate(employee.last_working_date)} />
              )}
              <InfoRow icon={Clock} label="Shift"
                value={employee.shift ? `${employee.shift.name} (${employee.shift.start_time}–${employee.shift.end_time})` : '—'} />
              <InfoRow icon={Fingerprint} label="Attendance" value={ATTENDANCE_MODE[employee.attendance_mode] ?? '—'} />
              <InfoRow icon={Users} label="Reporting Manager"
                value={employee.reporting_manager_name
                  ? `${employee.reporting_manager_name}${employee.reporting_manager_designation ? ` (${employee.reporting_manager_designation})` : ''}`
                  : '—'} />
              <InfoRow icon={UserRound} label="Gender" value={GENDER[employee.gender] ?? 'Not recorded'} />
              <InfoRow icon={KeyRound} label="Access"
                value={employee.account_status ? `${ACCOUNT[employee.account_status] ?? employee.account_status}${employee.role ? ` · ${roleLabel(employee.role)}` : ''}` : 'No login'} />
            </Section>

            {checksDocuments && (
              <Section title="Documents">
                <DocumentsSummary query={documents} onOpen={openDocuments} />
              </Section>
            )}

            {can('employee:compensation:read') && (
              <Section title="Salary">
                {employee.ctc == null ? (
                  // Null is "not recorded". Zero would say they earn nothing.
                  <p className="text-sm text-gray-500 bg-slate-50 border border-slate-200 rounded-xl p-4">
                    No salary is recorded for this employee yet. Accounts sets it under Payroll → Salary structure.
                  </p>
                ) : (
                  <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs text-slate-400 font-medium">Annual CTC</p>
                        <p className="text-lg font-bold text-slate-900">{money(employee.ctc)}</p>
                      </div>
                      <p className="text-xs text-slate-400 text-right">Since {formatDate(employee.salary_effective_from)}</p>
                    </div>
                    {components.length > 0 && (
                      <div className="border-t border-slate-200/80 pt-2.5 grid grid-cols-2 gap-2 text-xs">
                        {components.map((c) => (
                          <div key={c.code}>
                            <span className="text-slate-400">{c.label}:</span>{' '}
                            <span className="font-semibold text-slate-700">{money(c.amount)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </Section>
            )}

            {can('employee:identity:read') && (
              <Section title="Statutory Details">
                <InfoRow icon={BadgeCheck} label="PAN" value={employee.pan || '—'} />
                <InfoRow icon={BadgeCheck} label="UAN" value={employee.uan || 'Not issued yet'} />
                <InfoRow icon={BadgeCheck} label="PF Member ID" value={employee.pf_acc_no || '—'} />
                <InfoRow icon={BadgeCheck} label="ESIC Number" value={employee.esi_number || '—'} />
                <InfoRow icon={Building2} label="PT State" value={employee.pt_state || 'Not recorded'} />
                <InfoRow icon={BadgeCheck} label="Provident Fund"
                  value={employee.pf_applicable === false ? 'Does not apply'
                    : employee.has_prior_pf_membership == null ? 'Applies · prior membership not asked'
                    : employee.has_prior_pf_membership ? 'Applies · was a member before' : 'Applies · first PF membership'} />
              </Section>
            )}

            {can('employee:bank:read') && (
              <Section title="Bank Account for Salary Credit">
                <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-3">
                  <div className="flex items-center gap-2">
                    <Landmark className="w-4 h-4 text-blue-600" />
                    <span className="text-sm font-semibold text-slate-900">{employee.bank_name || 'No bank details recorded'}</span>
                  </div>
                  {employee.bank_account && (
                    <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-slate-200/80">
                      <div>
                        <span className="text-slate-400">Account No:</span>{' '}
                        <span className="font-mono font-bold text-slate-800">•••• {String(employee.bank_account).slice(-4)}</span>
                      </div>
                      <div>
                        <span className="text-slate-400">IFSC Code:</span>{' '}
                        <span className="font-mono font-semibold text-blue-700">{employee.ifsc || '—'}</span>
                      </div>
                      {employee.bank_proof_name && (
                        <div className="col-span-2 flex items-center gap-1 text-slate-500">
                          <Paperclip className="w-3 h-3" /> Proof on file: {employee.bank_proof_name}
                        </div>
                      )}
                    </div>
                  )}
                  {employee.bank_account && (
                    <div className="flex items-center justify-between text-xs pt-2 border-t border-slate-200/60">
                      <span className="text-slate-500 font-medium">Verification</span>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${bankStatus.cls}`}>
                        <bankStatus.icon className="w-3 h-3" /> {bankStatus.label}
                      </span>
                    </div>
                  )}
                  {employee.bank_verification_status === 'rejected' && employee.bank_verification_remarks && (
                    <p className="text-xs text-rose-700">Why: {employee.bank_verification_remarks}</p>
                  )}
                  {can('employee:bank:manage') && (
                    <button onClick={openBankAccounts} className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
                      {employee.bank_account ? 'Check or change it' : 'Record it'} under Payroll → Bank accounts <ArrowRight className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </Section>
            )}

          </div>
        </div>
      </div>
    </>
  )
}

/** Where somebody stands against the required documents — from their checklist. */
function DocumentsSummary({ query, onOpen }) {
  const { data, isLoading, error } = query
  if (isLoading) return <p className="text-sm text-gray-400">Loading…</p>
  if (error || !data) return <p className="text-sm text-gray-500">{error?.message ?? 'Their documents could not be opened.'}</p>

  const required = data.items.filter((i) => i.type.required)
  const verified = required.filter((i) => i.current?.status === 'verified').length
  const waiting = data.items.filter((i) => i.current?.status === 'pending').length
  const rejected = data.items.filter((i) => i.current?.status === 'rejected').length
  const missing = required.filter((i) => !i.current).length

  return (
    <div className="bg-slate-50 p-4 rounded-xl border border-slate-200 space-y-2.5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <FileText className="w-4 h-4 text-blue-600" />
          <span className="text-sm font-semibold text-slate-900">{verified} of {required.length} required verified</span>
        </div>
        {required.length > 0 && verified === required.length && <CheckCircle2 className="w-4 h-4 text-emerald-600" aria-label="Complete" />}
      </div>
      {(waiting > 0 || rejected > 0 || missing > 0) && (
        <p className="text-xs text-slate-500">
          {[waiting > 0 && `${waiting} waiting for a check`, rejected > 0 && `${rejected} rejected`, missing > 0 && `${missing} required not uploaded`].filter(Boolean).join(' · ')}
        </p>
      )}
      <button onClick={onOpen} className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
        Open their documents <ArrowRight className="w-3.5 h-3.5" />
      </button>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">{title}</p>
      <div className="space-y-3">{children}</div>
    </div>
  )
}

function InfoRow({ icon, label, value }) {
  return (
    <div className="flex items-start gap-3">
      <div className="w-8 h-8 rounded-lg bg-gray-100 flex items-center justify-center shrink-0 mt-0.5">
        {createElement(icon, { className: 'w-4 h-4 text-gray-500' })}
      </div>
      <div>
        <p className="text-xs text-gray-400">{label}</p>
        <p className="text-sm font-medium text-gray-900 mt-0.5">{value}</p>
      </div>
    </div>
  )
}
