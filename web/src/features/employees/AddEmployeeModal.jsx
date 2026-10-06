import { btn } from '../../components/ui/styles'
import { useState } from 'react'
import { X, Info } from 'lucide-react'
import { toast } from 'sonner'
import { useEmployees, useMasterData, useCreateEmployee, useUpdateEmployee } from '../../hooks/useEmployees'
import { EscapeCloses } from '../../hooks/useEscape'
import { useAuthStore } from '../../stores/authStore'
import { PasswordLinkPanel } from '../settings/UserAccess'
import PasswordFields from '../../components/PasswordFields'
import { maySetPasswordOf, passwordPairProblem, passwordSetBy, passwordSetterName } from '../../lib/logins'
import { useInvitableRoles } from '../../hooks/useRoles'
import { optionsNote } from '../../lib/optionsNote'
import { calendarDayIn } from '../../lib/dates'
import { useLifecycleSettings } from '../../hooks/useLifecycle'

/**
 * Adding or editing an employee, against the server.
 *
 * The old form was built for a different system and could not have saved to
 * this one: it sent department and designation as NAMES from lists typed into
 * this file, where the server stores ids; it asked for an initial password; it
 * offered super_admin as a role; and it saved salary and bank details, which
 * the employee endpoints refuse. Each of those was a field that looked saved
 * and was not.
 *
 * Mounted fresh for each opening (the page keys it), so its state starts from
 * the employee being edited without an effect copying props into state.
 */

const EMPLOYMENT_TYPES = [
  ['full_time', 'Full-time'],
  ['part_time', 'Part-time'],
  ['contract', 'Contract'],
  ['intern', 'Intern'],
]

const GENDERS = [
  ['', 'Not recorded'],
  ['female', 'Female'],
  ['male', 'Male'],
  ['other', 'Other'],
]

const WORK_ARRANGEMENTS = [
  ['office', 'At the office — home only on approved work-from-home days'],
  ['hybrid', 'Hybrid — office and home, home days approved as requests'],
  ['remote', 'Remote — checks in from anywhere'],
]

const ATTENDANCE_MODES = [
  ['app', 'App — punch in with location'],
  ['biometric', 'Biometric machine'],
  ['manual', 'Marked by HR'],
]


function priorToForm(value) {
  if (value === true) return 'yes'
  if (value === false) return 'no'
  return ''
}

function priorFromForm(value) {
  if (value === 'yes') return true
  if (value === 'no') return false
  return null
}

function fromEmployee(employee) {
  return {
    fullName: employee?.full_name ?? '',
    employeeCode: employee?.employee_id ?? '',
    personalEmail: employee?.personal_email ?? '',
    phone: employee?.phone ?? '',
    gender: employee?.gender ?? '',
    dateOfJoining: employee?.date_of_joining ?? '',
    lastWorkingDate: employee?.last_working_date ?? '',
    // Only on creation: somebody already working here, confirmed on this day.
    confirmedOn: '',
    employmentType: employee?.employment_type ?? 'full_time',
    departmentId: employee?.department_id ?? '',
    designationId: employee?.designation_id ?? '',
    shiftId: employee?.shift_id ?? '',
    reportingManagerId: employee?.reporting_manager_id ?? '',
    attendanceMode: employee?.attendance_mode ?? 'app',
    workArrangement: employee?.work_arrangement ?? 'office',

    // Personal details (client §42): read only by whoever sees statutory details.
    dateOfBirth: employee?.date_of_birth ?? '',
    nationality: employee?.nationality ?? '',
    address: employee?.address ?? '',
    emergencyContactName: employee?.emergency_contact_name ?? '',
    emergencyContactRelation: employee?.emergency_contact_relation ?? '',
    emergencyContactPhone: employee?.emergency_contact_phone ?? '',

    pan: employee?.pan ?? '',
    uan: employee?.uan ?? '',
    pfAccountNumber: employee?.pf_acc_no ?? '',
    esiNumber: employee?.esi_number ?? '',
    ptState: employee?.pt_state ?? '',
    // No statutory record reads as the column's default: PF applies.
    pfApplicable: employee?.pf_applicable ?? true,
    hasPriorPfMembership: priorToForm(employee?.has_prior_pf_membership),
    // As their PF record has it; blank leaves it to payroll, from what they joined on.
    epsMember: priorToForm(employee?.eps_member),

    withLogin: false,
    loginEmail: '',
    loginRole: 'employee',
  }
}

/** A blank field is "not recorded", which the server stores as null. */
const orNull = (value) => (value === '' || value === undefined ? null : value)

function personalOf(form) {
  return {
    dateOfBirth: orNull(form.dateOfBirth),
    nationality: orNull(form.nationality.trim()),
    address: orNull(form.address.trim()),
    emergencyContactName: orNull(form.emergencyContactName.trim()),
    emergencyContactRelation: orNull(form.emergencyContactRelation.trim()),
    emergencyContactPhone: orNull(form.emergencyContactPhone.trim()),
  }
}

function statutoryOf(form) {
  return {
    pan: orNull(form.pan.trim().toUpperCase()),
    uan: orNull(form.uan.trim()),
    pfAccountNumber: orNull(form.pfAccountNumber.trim()),
    esiNumber: orNull(form.esiNumber.trim()),
    ptState: orNull(form.ptState.trim()),
    pfApplicable: form.pfApplicable,
    hasPriorPfMembership: priorFromForm(form.hasPriorPfMembership),
    epsMember: priorFromForm(form.epsMember),
  }
}

export default function AddEmployeeModal({ open, onClose, initial = null, onSave }) {
  const isEdit = Boolean(initial)
  const canSeeIdentity = useAuthStore((state) => state.can('employee:identity:read'))
  const setsTree = useAuthStore((state) => state.can('role:manage'))
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const today = calendarDayIn(timezone)
  // The company's probation, for the hint — asked only of those who may read it.
  const readsLifecycle = useAuthStore((state) => state.canAny(['settings:read', 'employee:lifecycle:manage']))
  const probationMonths = useLifecycleSettings({ enabled: open && !isEdit && readsLifecycle }).data?.probation_months ?? null

  // Both only fill dropdowns. Each says in its first option when its list is
  // loading or failed, so an empty dropdown never reads as "none exist".
  const people = useEmployees()
  const lists = useMasterData()
  const employees = people.data ?? []
  const masterData = lists.data
  const loadingLists = lists.isLoading
  const createEmployee = useCreateEmployee()
  const updateEmployee = useUpdateEmployee()

  const [form, setForm] = useState(() => fromEmployee(initial))
  const [errors, setErrors] = useState({})
  // Set once an employee with a login has been created: the link is shown here,
  // once, before the modal closes.
  const [issued, setIssued] = useState(null)
  // The new login's password, typed twice, where the company sets it (Settings → Passwords).
  const [loginPair, setLoginPair] = useState({ password: '', again: '' })
  const rules = useAuthStore((state) => state.passwords.rules)
  const isSuperAdmin = useAuthStore((state) => state.can('role:manage'))
  const holdsPasswords = useAuthStore((state) => state.can('user:password:set'))
  // The roles this person may give, asked for only once a login is wanted.
  const loginRoles = useInvitableRoles({ enabled: open && !isEdit && form.withLogin })
  // The Employee role unless somebody chose another; one they may not give is never sent.
  const loginRole = loginRoles.roles.some((r) => r.key === form.loginRole)
    ? form.loginRole
    : loginRoles.roles.some((r) => r.key === 'employee') ? 'employee' : (loginRoles.roles[0]?.key ?? '')
  // The kind of login that role makes, and so how it starts: with the password
  // typed here — where the company sets it and this person may — a link, or
  // waiting for its password. An employee login needs no email: the person
  // signs in with their Employee ID.
  const loginChoice = loginRoles.roles.find((r) => r.key === loginRole)
  const loginKind = loginChoice ? loginChoice.login_kind : null
  const loginSetBy = loginKind ? passwordSetBy(loginKind, rules) : null
  const typesPassword = loginSetBy === 'company' && maySetPasswordOf(loginKind, { isSuperAdmin, holds: holdsPasswords })
  const emailOptional = loginKind === 'employee'

  if (!open) return null

  function set(field, value) {
    setForm((f) => ({ ...f, [field]: value }))
    setErrors((e) => ({ ...e, [field]: '' }))
  }

  function validate() {
    const e = {}
    if (!form.fullName.trim()) e.fullName = 'Required'
    if (!form.employeeCode.trim()) e.employeeCode = 'Required'
    // Required here though the server allows it blank: payroll works out who
    // was employed on which days from it, and a blank one is paid in full.
    if (!form.dateOfJoining) e.dateOfJoining = 'Required'
    if (!isEdit && form.confirmedOn && form.dateOfJoining && form.confirmedOn < form.dateOfJoining) {
      e.confirmedOn = 'Cannot be before the joining date'
    }
    if (!isEdit && form.confirmedOn && form.confirmedOn > today) e.confirmedOn = 'Cannot be in the future — leave it empty for somebody on probation'
    if (form.lastWorkingDate && form.dateOfJoining && form.lastWorkingDate < form.dateOfJoining) {
      e.lastWorkingDate = 'Cannot be before the joining date'
    }
    const loginEmail = form.loginEmail.trim()
    if (form.withLogin && loginEmail && !/\S+@\S+\.\S+/.test(loginEmail)) e.loginEmail = 'That is not a valid email'
    if (form.withLogin && !loginEmail && !emailOptional) e.loginEmail = 'A role login needs a work email of its own'
    if (form.withLogin && typesPassword) {
      const wrong = passwordPairProblem(loginPair, rules.passwordMinLength)
      if (wrong) e.loginPassword = wrong
    }
    // Why there is no role to send, told truthfully: still loading, failed to
    // load, or genuinely none this person may give.
    if (form.withLogin && !loginRole) {
      e.loginRole = loginRoles.query.isError
        ? 'The list of roles could not be loaded. Try again below.'
        : loginRoles.query.isSuccess
          ? 'There is no role you may give. Ask the Super Admin.'
          : 'The list of roles is still loading.'
    }
    return e
  }

  function bodyFrom() {
    const body = {
      fullName: form.fullName.trim(),
      employeeCode: form.employeeCode.trim(),
      personalEmail: orNull(form.personalEmail.trim()),
      phone: orNull(form.phone.trim()),
      gender: orNull(form.gender),
      dateOfJoining: orNull(form.dateOfJoining),
      employmentType: form.employmentType,
      departmentId: orNull(form.departmentId),
      designationId: orNull(form.designationId),
      shiftId: orNull(form.shiftId),
      reportingManagerId: orNull(form.reportingManagerId),
      attendanceMode: form.attendanceMode,
      workArrangement: form.workArrangement,
    }

    if (isEdit) body.lastWorkingDate = orNull(form.lastWorkingDate)
    else body.confirmedOn = orNull(form.confirmedOn)
    // Not theirs to change on an edit (the Super Admin's), so not sent at all.
    if (isEdit && !setsTree) delete body.reportingManagerId

    // Only somebody who can SEE the statutory record may send it. Anybody else
    // would be saving the blanks they were shown over the real values.
    if (canSeeIdentity) {
      const next = statutoryOf(form)
      const before = statutoryOf(fromEmployee(initial))
      const changed = JSON.stringify(next) !== JSON.stringify(before)
      // A new employee gets a statutory record only if something was entered;
      // an existing one only if something changed.
      if (changed) body.statutory = next
      // The same for personal details: sent only when something was entered or changed.
      const personal = personalOf(form)
      if (JSON.stringify(personal) !== JSON.stringify(personalOf(fromEmployee(initial)))) body.personal = personal
    }

    if (!isEdit && form.withLogin) {
      const loginEmail = form.loginEmail.trim().toLowerCase()
      body.login = {
        ...(loginEmail ? { email: loginEmail } : {}),
        role: loginRole,
        ...(typesPassword ? { password: loginPair.password } : {}),
      }
    }

    return body
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }

    // A refusal is shown by the app-wide toast; the form stays open with
    // everything still in it.
    if (isEdit) {
      const saved = await updateEmployee.mutateAsync({ id: initial.id, ...bodyFrom() }).then(() => true, () => false)
      if (saved) { onSave(); onClose() }
      return
    }

    const result = await createEmployee.mutateAsync(bodyFrom()).catch(() => null)
    if (!result) return

    if (result.invite) {
      setIssued({ email: form.loginEmail.trim().toLowerCase() || `Employee ID ${form.employeeCode.trim()}`, invite: result.invite })
      return
    }
    // A login with the password typed here works at once: say how they sign in.
    if (result.loginStart === 'password') {
      const email = form.loginEmail.trim().toLowerCase()
      toast.success(`${form.fullName.trim()} added. They sign in with ${email ? `${email} or ` : ''}Employee ID ${form.employeeCode.trim()} and the password you set — tell them the password yourself.`)
    } else if (result.loginStart === 'none') {
      toast.success(`${form.fullName.trim()} added. Their login waits for its password — ${passwordSetterName(loginKind)} sets it on their page.`)
    }
    onSave()
    onClose()
  }

  const saving = createEmployee.isPending || updateEmployee.isPending
  const managers = employees.filter((emp) => emp.id !== initial?.id)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-gray-950/45 backdrop-blur-[2px] p-3 sm:p-4 overflow-y-auto"
      role="dialog" aria-modal="true" aria-label={isEdit ? 'Edit Employee' : 'Add New Employee'}>
      <EscapeCloses onClose={onClose} />
      <div className="bg-white rounded-2xl shadow-[0_30px_70px_-20px_rgba(26,16,41,0.5)] w-full max-w-2xl my-6 sm:my-8 overflow-hidden">

        <div className="flex items-center justify-between px-6 py-5 border-b border-gray-100 bg-white sticky top-0 z-10">
          <div>
            <h2 className="text-lg font-semibold text-gray-900">{isEdit ? 'Edit Employee' : 'Add New Employee'}</h2>
            <p className="text-sm text-gray-400 mt-0.5">{isEdit ? 'Update the employee record' : 'Create the employee record, and a login if they need one'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        {issued ? (
          <div className="p-6 space-y-4">
            <p className="text-sm text-gray-700">
              <span className="font-semibold">{form.fullName}</span> has been added. Send them this link so they can set their password.
            </p>
            <PasswordLinkPanel email={issued.email} invite={issued.invite} onDone={() => { onSave(); onClose() }} />
            <div className="flex justify-end">
              <button onClick={() => { onSave(); onClose() }}
                className={btn.primary}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-6 space-y-6 max-h-[80vh] overflow-y-auto">

            {/* Basic information */}
            <Section title="Basic Information">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Full Name" error={errors.fullName} required>
                  <input type="text" placeholder="e.g. Priya Sharma" value={form.fullName}
                    onChange={(e) => set('fullName', e.target.value)} className={inp(errors.fullName)} />
                </Field>
                <Field label="Employee Code" error={errors.employeeCode} required>
                  <input type="text" placeholder="e.g. CMS-1042" value={form.employeeCode}
                    onChange={(e) => set('employeeCode', e.target.value)} className={inp(errors.employeeCode)} />
                </Field>
                <Field label="Personal Email">
                  <input type="email" placeholder="Optional" value={form.personalEmail}
                    onChange={(e) => set('personalEmail', e.target.value)} className={inp()} />
                </Field>
                <Field label="Phone Number">
                  <input type="tel" placeholder="+91 98765 43210" value={form.phone}
                    onChange={(e) => set('phone', e.target.value)} className={inp()} />
                </Field>
                <Field label="Gender" hint="Professional tax differs by gender in some states.">
                  <select value={form.gender} onChange={(e) => set('gender', e.target.value)} className={inp()}>
                    {GENDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <Field label="Employment Type">
                  <select value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)} className={inp()}>
                    {EMPLOYMENT_TYPES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
              </div>
            </Section>

            {/* Role in the company */}
            <Section title="Employment">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <Field label="Date of Joining" error={errors.dateOfJoining} required>
                  <input type="date" value={form.dateOfJoining}
                    onChange={(e) => set('dateOfJoining', e.target.value)} className={inp(errors.dateOfJoining)} />
                </Field>
                {isEdit ? (
                  <Field label="Last Working Day" error={errors.lastWorkingDate} hint="Set by accepting a resignation or completing the exit, in their profile. Change it here only to correct it. Pay stops on this day.">
                    <input type="date" value={form.lastWorkingDate} min={form.dateOfJoining || undefined}
                      onChange={(e) => set('lastWorkingDate', e.target.value)} className={inp(errors.lastWorkingDate)} />
                  </Field>
                ) : (
                  <Field label="Confirmed On" error={errors.confirmedOn}
                    hint={`Only for somebody already working here and past probation. Left empty, they start as a new joiner — onboarding, then ${probationMonths == null ? 'the company’s' : `a ${probationMonths}-month`} probation.`}>
                    <input type="date" value={form.confirmedOn} min={form.dateOfJoining || undefined} max={today}
                      onChange={(e) => set('confirmedOn', e.target.value)} className={inp(errors.confirmedOn)} aria-label="Confirmed On" />
                  </Field>
                )}
                <Field label="Department">
                  <select value={form.departmentId} onChange={(e) => set('departmentId', e.target.value)} className={inp()} disabled={loadingLists}>
                    <option value="">{optionsNote(lists, 'Not assigned')}</option>
                    {masterData?.departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </Field>
                <Field label="Designation">
                  <select value={form.designationId} onChange={(e) => set('designationId', e.target.value)} className={inp()} disabled={loadingLists}>
                    <option value="">{optionsNote(lists, 'Not assigned')}</option>
                    {masterData?.designations.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  </select>
                </Field>
                <Field label="Shift" hint="Daily hours are read against the shift's expected hours.">
                  <select value={form.shiftId} onChange={(e) => set('shiftId', e.target.value)} className={inp()} disabled={loadingLists}>
                    <option value="">{optionsNote(lists, 'No shift')}</option>
                    {masterData?.shifts.map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.start_time}–{s.end_time})</option>
                    ))}
                  </select>
                </Field>
                <Field label="Attendance">
                  <select value={form.attendanceMode} onChange={(e) => set('attendanceMode', e.target.value)} className={inp()}>
                    {ATTENDANCE_MODES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <Field label="Work Arrangement" hint="Remote: no office location is asked at check-in. Hybrid: work from home on approved days.">
                  <select value={form.workArrangement} onChange={(e) => set('workArrangement', e.target.value)} className={inp()} aria-label="Work arrangement">
                    {WORK_ARRANGEMENTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                  </select>
                </Field>
                <div className="sm:col-span-2">
                  {/* For somebody already here, who they report to is the Super
                      Admin's to change (the company tree); a new joiner is placed
                      by whoever adds them. */}
                  <Field label="Reporting Manager"
                    hint={isEdit && !setsTree
                      ? 'Who they report to is changed by the Super Admin, on Settings → Company Tree.'
                      : 'Their leave requests go to this person.'}>
                    <select value={form.reportingManagerId} onChange={(e) => set('reportingManagerId', e.target.value)} className={inp()}
                      disabled={isEdit && !setsTree} aria-label="Reporting Manager">
                      <option value="">{optionsNote(people, 'No reporting manager')}</option>
                      {managers.map((m) => (
                        <option key={m.id} value={m.id}>{m.full_name}{m.designation ? ` — ${m.designation}` : ''}</option>
                      ))}
                    </select>
                  </Field>
                </div>
              </div>
            </Section>

            {/* Personal details (client §42) — only for somebody who can see them */}
            {canSeeIdentity && (
              <Section title="Personal Details">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="Date of Birth">
                    <input type="date" value={form.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} className={inp()} aria-label="Date of birth" />
                  </Field>
                  <Field label="Nationality">
                    <input type="text" value={form.nationality} maxLength={80} onChange={(e) => set('nationality', e.target.value)} className={inp()} aria-label="Nationality" />
                  </Field>
                  <div className="sm:col-span-2">
                    <Field label="Address">
                      <textarea rows={2} value={form.address} maxLength={500} onChange={(e) => set('address', e.target.value)} className={inp()} aria-label="Address" />
                    </Field>
                  </div>
                  <Field label="Emergency Contact">
                    <input type="text" value={form.emergencyContactName} maxLength={200} onChange={(e) => set('emergencyContactName', e.target.value)} className={inp()} aria-label="Emergency contact" />
                  </Field>
                  <Field label="Relation">
                    <input type="text" placeholder="e.g. Mother" value={form.emergencyContactRelation} maxLength={80} onChange={(e) => set('emergencyContactRelation', e.target.value)} className={inp()} aria-label="Emergency contact relation" />
                  </Field>
                  <Field label="Emergency Contact Phone">
                    <input type="tel" value={form.emergencyContactPhone} maxLength={30} onChange={(e) => set('emergencyContactPhone', e.target.value)} className={inp()} aria-label="Emergency contact phone" />
                  </Field>
                </div>
              </Section>
            )}

            {/* Statutory — only for somebody who can see it */}
            {canSeeIdentity && (
              <Section title="Statutory Details">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <Field label="PAN">
                    <input type="text" placeholder="ABCDE1234F" maxLength={10} value={form.pan}
                      onChange={(e) => set('pan', e.target.value)} className={`${inp()} uppercase`} />
                  </Field>
                  <Field label="UAN" hint="Leave blank until EPFO issues one.">
                    <input type="text" placeholder="12 digits" maxLength={12} value={form.uan}
                      onChange={(e) => set('uan', e.target.value)} className={inp()} />
                  </Field>
                  <Field label="PF Member ID">
                    <input type="text" value={form.pfAccountNumber} maxLength={30}
                      onChange={(e) => set('pfAccountNumber', e.target.value)} className={inp()} />
                  </Field>
                  <Field label="ESIC Number">
                    <input type="text" value={form.esiNumber} maxLength={20}
                      onChange={(e) => set('esiNumber', e.target.value)} className={inp()} />
                  </Field>
                  <Field label="PT State" hint="Where they physically work.">
                    <input type="text" placeholder="e.g. Maharashtra" value={form.ptState} maxLength={50}
                      onChange={(e) => set('ptState', e.target.value)} className={inp()} />
                  </Field>
                  <Field label="Previously a PF member?" hint="Decides pension (EPS) membership for a new joiner.">
                    <select value={form.hasPriorPfMembership} onChange={(e) => set('hasPriorPfMembership', e.target.value)} className={inp()}>
                      <option value="">Not asked yet</option>
                      <option value="yes">Yes, at a previous employer</option>
                      <option value="no">No, first job with PF</option>
                    </select>
                  </Field>
                  <Field label="Pension (EPS) Member?" hint="As their PF record with EPFO has it. Recorded, it never changes with the payroll settings.">
                    <select value={form.epsMember} onChange={(e) => set('epsMember', e.target.value)} className={inp()} aria-label="Pension (EPS) member">
                      <option value="">Let payroll work it out from the joining salary</option>
                      <option value="yes">Yes, an EPS member</option>
                      <option value="no">No, not in the pension scheme</option>
                    </select>
                  </Field>
                  <label className="sm:col-span-2 flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" checked={form.pfApplicable} onChange={(e) => set('pfApplicable', e.target.checked)}
                      className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                    Provident fund applies to this employee
                  </label>
                </div>
              </Section>
            )}

            {/* A login, on creation only — afterwards one is added on their page, under Logins (Day 23) */}
            {!isEdit && (
              <Section title="Login">
                <label className="flex items-center gap-2 text-sm text-gray-700">
                  <input type="checkbox" checked={form.withLogin} onChange={(e) => set('withLogin', e.target.checked)}
                    className="rounded border-gray-300 text-brand-600 focus:ring-brand-500" />
                  Give them a login to the system
                </label>
                {form.withLogin && (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-3">
                    <Field label={emailOptional ? 'Work Email (optional)' : 'Work Email'} error={errors.loginEmail} required={!emailOptional}>
                      <input type="email" placeholder={emailOptional ? 'Leave empty to sign in with the Employee ID' : 'priya@company.in'} value={form.loginEmail}
                        onChange={(e) => set('loginEmail', e.target.value)} className={inp(errors.loginEmail)} />
                    </Field>
                    <Field label="Role" error={errors.loginRole}>
                      {/* Only roles below the person adding them (Day 21), never the
                          Super Admin's — handing that over is its own deliberate step. */}
                      <select value={loginRole} onChange={(e) => set('loginRole', e.target.value)}
                        disabled={!loginRoles.query.isSuccess || loginRoles.roles.length === 0} className={inp(errors.loginRole)}>
                        {loginRoles.query.isSuccess && loginRoles.roles.length > 0
                          ? loginRoles.roles.map((r) => <option key={r.key} value={r.key}>{r.name}</option>)
                          : <option value="">{optionsNote(loginRoles.query, 'No role you may give')}</option>}
                      </select>
                      {loginRoles.query.isError && (
                        <button type="button" onClick={() => loginRoles.query.refetch()}
                          className="mt-1 text-xs font-medium text-brand-700 hover:underline">
                          Try loading the roles again
                        </button>
                      )}
                    </Field>
                    {/* How the login starts, by whose password it is (Settings → Passwords). */}
                    {typesPassword ? (
                      <div className="sm:col-span-2 space-y-1.5">
                        <PasswordFields value={loginPair} onChange={(next) => { setLoginPair(next); setErrors((e) => ({ ...e, loginPassword: '' })) }}
                          minLength={rules.passwordMinLength} />
                        {errors.loginPassword && <p role="alert" className="text-xs text-red-600">{errors.loginPassword}</p>}
                        <p className="text-xs text-gray-500">
                          They sign in with {emailOptional ? 'their Employee ID (or the email, if given)' : 'this email'} and this password, as soon as you save.
                          Tell them the password yourself — it is not shown again, and {loginKind === 'employee' ? 'only HR or the Super Admin can change it' : 'only the Super Admin can change it'}.
                        </p>
                      </div>
                    ) : (
                      <p className="sm:col-span-2 text-xs text-gray-500">
                        {loginSetBy === 'self'
                          ? 'No password is set here. After saving you get a one-time link to send them, and they choose their own.'
                          : loginKind
                            ? `No password is set here: the login waits for ${passwordSetterName(loginKind)} to set it on their page.`
                            : null}
                      </p>
                    )}
                  </div>
                )}
              </Section>
            )}

            {/* Said plainly, instead of fields that look saved and are not */}
            <div className="flex items-start gap-2.5 p-3 rounded-lg bg-slate-50 border border-slate-200">
              <Info className="w-4 h-4 text-slate-500 mt-0.5 shrink-0" />
              <p className="text-xs text-slate-600 leading-relaxed">
                Salary is not entered here — Accounts sets it under Payroll. Bank details are added and verified
                separately. Neither is saved from this form.
              </p>
            </div>

            <div className="flex flex-wrap justify-end gap-3 pt-1">
              <button type="button" onClick={onClose}
                className={btn.secondary}>
                Cancel
              </button>
              <button type="submit" disabled={saving}
                className={btn.primary}>
                {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Add Employee'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

function Section({ title, children }) {
  return (
    <div>
      <h3 className="text-sm font-semibold text-gray-900 mb-3 flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-brand-600"></span>
        {title}
      </h3>
      {children}
    </div>
  )
}

function Field({ label, error, required, hint, children }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium text-gray-600">
        {label}{required && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {error ? <p className="text-xs text-red-500">{error}</p> : hint ? <p className="text-xs text-gray-400">{hint}</p> : null}
    </div>
  )
}

function inp(error) {
  return `w-full border ${error ? 'border-red-400 bg-red-50' : 'border-gray-300'} rounded-lg px-3 py-2 text-sm
    focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent
    placeholder:text-gray-400 text-gray-900 bg-white disabled:bg-gray-50`
}
