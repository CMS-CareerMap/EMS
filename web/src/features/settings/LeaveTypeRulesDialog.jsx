import { btn } from '../../components/ui/styles'
import { useState } from 'react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import { Toggle } from './ui'
import { useUpdateLeaveType } from '../../hooks/useSettings'
import { perMonth } from '../../lib/rules'

/**
 * A leave type's own rules (client §36–37, and 9 Oct 2026): what a new joiner
 * gets of the year, from when it can be used, how it is earned, the notice it
 * needs, the longest application, who may use it, half days, weekends inside
 * it, and encashment. Each defaults to what applied before.
 */
export default function LeaveTypeRulesDialog({ type, onClose }) {
  const update = useUpdateLeaveType()
  const blank = (v) => (v === null || v === undefined ? '' : String(v))
  const unpaid = type.paid === false
  const [f, setF] = useState({
    joinerGrant: type.joiner_grant ?? 'months_left',
    usableAfterConfirmation: type.usable_after_confirmation ?? false,
    accrual: type.accrual ?? 'yearly',
    minNoticeDays: blank(type.min_notice_days ?? 0),
    maxDaysPerRequest: blank(type.max_days_per_request),
    eligibleAfterDays: blank(type.eligible_after_days ?? 0),
    eligibleGender: type.eligible_gender ?? '',
    halfDayAllowed: type.half_day_allowed ?? true,
    countsNonWorkingDays: type.counts_non_working_days ?? false,
    encashable: type.encashable ?? false,
    encashMaxDaysPerYear: blank(type.encash_max_days_per_year),
  })
  const set = (key, value) => setF({ ...f, [key]: value })
  const orNull = (v) => (v === '' ? null : Number(v))

  async function submit(e) {
    e.preventDefault()
    const done = await update
      .mutateAsync({
        id: type.id,
        joinerGrant: f.joinerGrant,
        usableAfterConfirmation: f.usableAfterConfirmation,
        accrual: f.accrual,
        minNoticeDays: Number(f.minNoticeDays || 0),
        maxDaysPerRequest: orNull(f.maxDaysPerRequest),
        eligibleAfterDays: Number(f.eligibleAfterDays || 0),
        eligibleGender: f.eligibleGender || null,
        halfDayAllowed: f.halfDayAllowed,
        countsNonWorkingDays: f.countsNonWorkingDays,
        // Unpaid leave is never encashed: there is no pay in it to turn into money.
        encashable: unpaid ? false : f.encashable,
        encashMaxDaysPerYear: !unpaid && f.encashable ? orNull(f.encashMaxDaysPerYear) : null,
      })
      .then(() => true, () => false)
    if (done) {
      toast.success(`${type.name}: rules saved`)
      onClose()
    }
  }

  return (
    <Dialog title={`${type.name} — rules`} onClose={update.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <Row label="A new joiner gets" hint="For somebody who joins partway through the leave year. They get it on the day they are added, and HR sees it in Leave → Team Balances. Somebody already here gets the whole year.">
          <select className={inputCls} value={f.joinerGrant} onChange={(e) => set('joinerGrant', e.target.value)} aria-label="A new joiner gets">
            <option value="months_left">The months left, the joining month counted</option>
            <option value="months_after_joining">Whole months left (the joining month only if joined on its 1st)</option>
            <option value="full_year">The full year’s days</option>
          </select>
        </Row>
        <Switch label="Only after confirmation" hint="Usable from the day somebody is confirmed, at the end of probation (Employees → Employment). Works together with the days of service below." checked={f.usableAfterConfirmation} onChange={(v) => set('usableAfterConfirmation', v)} />
        <Row label="Usable after (days of service)" hint="For example 80 for maternity benefit. 0: from the first day.">
          <input type="number" min="0" max="3650" className={inputCls} value={f.eligibleAfterDays} onChange={(e) => set('eligibleAfterDays', e.target.value)} aria-label="Usable after days of service" />
        </Row>
        <Row label="How it is earned" hint={`Monthly: a twelfth of the year’s days is earned each month, and only what is earned by the month a leave starts can be taken.${f.accrual === 'monthly' && type.days > 0 ? ` ${type.name}: ${type.days} days a year = ${perMonth(type.days)} a month.` : ''}`}>
          <select className={inputCls} value={f.accrual} onChange={(e) => set('accrual', e.target.value)} aria-label="How it is earned">
            <option value="yearly">All at the start of the leave year</option>
            <option value="monthly">A twelfth each month</option>
          </select>
        </Row>
        <Row label="Notice (days)" hint="How many days ahead somebody must apply. Leave already begun — sick leave applied for on return — is never refused for this.">
          <input type="number" min="0" max="365" className={inputCls} value={f.minNoticeDays} onChange={(e) => set('minNoticeDays', e.target.value)} aria-label="Notice in days" />
        </Row>
        <Row label="Most days in one application" hint="Empty: no limit beyond the balance.">
          <input type="number" min="0.5" max="365" step="0.5" placeholder="No limit" className={inputCls} value={f.maxDaysPerRequest} onChange={(e) => set('maxDaysPerRequest', e.target.value)} aria-label="Most days in one application" />
        </Row>
        <Row label="Who may use it" hint="For maternity or paternity leave. The gender comes from the employee record.">
          <select className={inputCls} value={f.eligibleGender} onChange={(e) => set('eligibleGender', e.target.value)} aria-label="Who may use it">
            <option value="">Everybody</option>
            <option value="female">Women only</option>
            <option value="male">Men only</option>
          </select>
        </Row>
        <Switch label="Half days allowed" hint="First or second half of a day." checked={f.halfDayAllowed} onChange={(v) => set('halfDayAllowed', v)} />
        <Switch label="Count weekends and holidays inside it" hint="On for leave counted in calendar days, such as maternity leave. Off: only working days come off the balance." checked={f.countsNonWorkingDays} onChange={(v) => set('countsNonWorkingDays', v)} />
        {unpaid ? (
          <p className="text-xs text-gray-500">Unpaid leave is never encashed: there is no pay in it to turn into money.</p>
        ) : (
          <Switch label="Can be encashed" hint="Employees may ask to turn unused days into pay, through Requests. Whoever Settings → Approvals names approves it (HR, to start); it is paid with the first payroll still open." checked={f.encashable} onChange={(v) => set('encashable', v)} />
        )}
        {!unpaid && f.encashable && (
          <Row label="Most days encashed in a leave year" hint="Empty: no limit beyond the balance.">
            <input type="number" min="0.5" max="365" step="0.5" placeholder="No limit" className={inputCls} value={f.encashMaxDaysPerYear} onChange={(e) => set('encashMaxDaysPerYear', e.target.value)} aria-label="Most days encashed in a leave year" />
          </Row>
        )}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={update.isPending} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={update.isPending} className={btn.primary}>{update.isPending ? 'Saving…' : 'Save rules'}</button>
        </div>
      </form>
    </Dialog>
  )
}

function Row({ label, hint, children }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium text-gray-700">{label}</span>
      {children}
      <span className="block text-xs text-gray-500">{hint}</span>
    </label>
  )
}

function Switch({ label, hint, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <p className="text-sm font-medium text-gray-700">{label}</p>
        <p className="text-xs text-gray-500">{hint}</p>
      </div>
      <Toggle checked={checked} onChange={onChange} label={label} />
    </div>
  )
}
