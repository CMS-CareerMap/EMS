import { btn, th } from '../../components/ui/styles'
import { useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { toast } from 'sonner'
import { Plus, Trash2, Edit2, X, Check, Archive, Info, SlidersHorizontal } from 'lucide-react'
import {
  usePayrollSettings, useSavePayroll,
  useLeaveTypes, useCreateLeaveType, useUpdateLeaveType, useArchiveLeaveType,
  useHolidays, useAddHoliday, useUpdateHoliday, useDeleteHoliday,
} from '../../hooks/useSettings'
import { useAuthStore } from '../../stores/authStore'
import { useLeaveReminder, useSaveLeaveReminder } from '../../hooks/useLeave'
import { calendarDayIn } from '../../lib/dates'
import DataState, { DataRows } from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import WeeklyOffPicker from './WeeklyOffPicker'
import { Section, Field, Toggle, inpSm } from './ui'
import { MONTHS } from './format'
import { formatDay } from '../../lib/dates'
import LeaveTypeRulesDialog from './LeaveTypeRulesDialog'
import { leaveRulesSummary, perMonth } from '../../lib/rules'

/**
 * The Leave Config tab.
 *
 * Three owners share it, so each part is drawn for whoever holds its
 * permission: the working week and leave year are company settings; leave
 * types are `leave:type:manage` (Super Admin, Admin, HR); the holiday calendar
 * is read with `leave:read` and kept by `holiday:manage`. Admin manages leave
 * types but holds no leave records, so sees no calendar rather than a 403.
 *
 * The version this replaces had a Save button that saved nothing, a list of
 * seven leave types that was never read, an "Applicable To" column the server
 * has no field for, no way to add or retire a type, and no holidays at all —
 * so Diwali was charged as leave.
 */
export default function LeaveSettings() {
  const canEditSettings = useAuthStore((s) => s.can('settings:update'))
  const canManageTypes = useAuthStore((s) => s.can('leave:type:manage'))
  const canReadHolidays = useAuthStore((s) => s.can('leave:read'))
  const canManageHolidays = useAuthStore((s) => s.can('holiday:manage'))

  return (
    <div className="space-y-6">
      {/*
        The working week first: a quota of twelve days means something different
        in a five-day week than a six-day one. Company settings, so drawn only for
        somebody who can change them — HR opening this tab would otherwise see a
        section that fails to load.
      */}
      {canEditSettings && (
        <Section title="Working Week" desc="Which days the company is closed, and when a leave year begins.">
          <Field label="Weekly Offs" hint="Saved on each click. Leave is not charged for these days.">
            <WeeklyOffPicker />
          </Field>
          <LeaveYear />
        </Section>
      )}

      {canManageTypes && <LeaveTypes />}

      {canManageTypes && (
        <Section title="Year-end Reminder" desc="Before the leave year ends, each employee is told of the days that will lapse — once, by bell and email. It can be switched off in Settings → Notifications.">
          <YearEndReminder />
        </Section>
      )}

      {canReadHolidays && <Holidays canManage={canManageHolidays} />}
    </div>
  )
}

// ─── Leave year ─────────────────────────────────────────────────────────────

function LeaveYear() {
  const settings = usePayrollSettings()
  const savePayroll = useSavePayroll()
  const [draft, setDraft] = useState(null)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)

  const current = settings.data?.leave_year_start_month
  const value = draft ?? current

  async function handleSave() {
    setError('')
    const ok = await savePayroll.mutateAsync({ leaveYearStartMonth: value }).then(
      () => true,
      (err) => { setError(err.message); return false },
    )
    if (ok) {
      setDraft(null)
      setSaved(true)
    }
  }

  return (
    <Field label="Leave Year Starts" hint="Balances are granted and reset each leave year. Fixed once any leave has been granted.">
      {/* No month is offered until the stored one has loaded — a failed load would otherwise read as January. */}
      <DataState query={settings} compact>
        <div className="flex items-center gap-2">
          <select className={inpSm} value={value ?? ''}
            onChange={(e) => { setDraft(Number(e.target.value)); setSaved(false); setError('') }}>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
          <button type="button" onClick={handleSave} disabled={savePayroll.isPending || value === current}
            className={btn.primary}>
            {savePayroll.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && value === current && <span className="text-xs text-green-700 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved</span>}
        </div>
      </DataState>
      {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mt-2">{error}</p>}
    </Field>
  )
}

// ─── Year-end reminder (client, 10 Oct 2026) ────────────────────────────────

function YearEndReminder() {
  const reminder = useLeaveReminder()
  const save = useSaveLeaveReminder()
  const [draft, setDraft] = useState(null)
  const [saved, setSaved] = useState(false)
  const current = reminder.data?.days
  const value = draft ?? (current === undefined ? '' : String(current))
  const n = Number(value)
  const valid = value !== '' && Number.isInteger(n) && n >= 1 && n <= 90

  async function handleSave() {
    if (!valid) return
    const ok = await save.mutateAsync({ days: n }).then(() => true, () => false)
    if (ok) { setDraft(null); setSaved(true) }
  }

  return (
    <Field label="Remind before the year ends" hint="Days before the last day of the leave year. Leave that carries forward is left out; only what would be lost is named.">
      <DataState query={reminder} compact>
        <div className="flex flex-wrap items-center gap-2">
          <input type="number" min="1" max="90" step="1" className={`${inpSm} w-24`} value={value} aria-label="Days before the year ends"
            onChange={(e) => { setDraft(e.target.value); setSaved(false) }} />
          <span className="text-sm text-gray-600">days before</span>
          <button type="button" onClick={handleSave} disabled={!valid || save.isPending || n === current} className={btn.primary}>
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          {saved && n === current && <span className="text-xs text-green-700 flex items-center gap-1"><Check className="w-3.5 h-3.5" /> Saved</span>}
        </div>
        {value !== '' && !valid && <p className="text-xs text-red-700 mt-1.5">Whole days, from 1 to 90.</p>}
      </DataState>
    </Field>
  )
}

// ─── Leave types ────────────────────────────────────────────────────────────

const EMPTY_TYPE = { name: '', code: '', days: '12', paid: true, carry_forward: false, carry_forward_cap: '' }

/** What is wrong with a leave type as typed, in words; empty when nothing is. */
function typeProblem(t) {
  if (!t.name.trim()) return 'Give the leave type a name.'
  if (!/^[A-Za-z]{1,6}$/.test(t.code.trim())) return 'The code is one to six letters, such as CL.'
  const days = Number(t.days)
  if (t.days === '' || !(days >= 0 && days <= 365)) return 'Days a year is between 0 and 365.'
  if (t.carry_forward && !(Number(t.carry_forward_cap) > 0)) return 'Carry forward is on — say how many days may be carried.'
  if (!t.paid && t.carry_forward) return 'Unpaid leave does not carry forward. Turn carry forward off, or make it paid.'
  return ''
}

const dayCount = (n) => `${n} day${Math.abs(n) === 1 ? '' : 's'}`

/** Days a year, as the table reads them: unpaid with none is no limit (Loss of Pay); paid with none is given as needed. */
function daysCell(t) {
  if (t.unlimited) return <span className="text-amber-700 font-semibold" title="Unpaid with no days a year: no limit — each day is cut from pay">No limit</span>
  // Earned a twelfth a month: the month's share said beside the year's, as people think of it.
  if (t.days > 0 && t.accrual === 'monthly') return <>{dayCount(t.days)} <span className="text-gray-500">· {perMonth(t.days)} a month</span></>
  if (t.days > 0) return dayCount(t.days)
  return <span className="text-gray-500" title="Given to a person by HR, or as their own days a year">Granted as needed</span>
}

/** What saving new days a year did, in a sentence. */
function daysSaved(name, days, balances) {
  const head = `${name}: ${dayCount(days)} a year`
  if (!balances) return `${head}.`
  if (!balances.this_year) return `${head}, from the next leave year.${balances.days ? ` Next year’s grant changed to match for ${balances.people} ${balances.people === 1 ? 'person' : 'people'}.` : ''}`
  const kept = balances.not_taken_back ? ` ${dayCount(balances.not_taken_back)} already taken or applied for ${balances.not_taken_back === 1 ? 'was' : 'were'} not taken back.` : ''
  return `${head}. Balances changed for ${balances.people} ${balances.people === 1 ? 'person' : 'people'}.${kept}`
}

function LeaveTypes() {
  const leaveTypes = useLeaveTypes()
  const createType = useCreateLeaveType()
  const archiveType = useArchiveLeaveType()
  const updateType = useUpdateLeaveType()
  // Changing this year's balances is for whoever manages them (HR, the Super Admin).
  const managesBalances = useAuthStore((s) => s.can('leave:balance:manage'))

  const [editId, setEditId] = useState(null)
  const [adding, setAdding] = useState(false)
  const [notice, setNotice] = useState('')
  const [archiving, setArchiving] = useState(null)
  const [ruling, setRuling] = useState(null)
  // New days a year for a type, waiting for the word on this year's balances.
  const [daysChange, setDaysChange] = useState(null)
  const [thisYear, setThisYear] = useState(false)
  const askDays = (type, body, done) => {
    setThisYear(false)
    // Unpaid with 0 days a year has no limit (Loss of Pay): said as such, going in or coming out of it.
    const unpaid = (body.isPaid ?? type.paid) === false
    setDaysChange({ type, body, done, wasUnlimited: Boolean(type.unlimited) && unpaid, becomesUnlimited: unpaid && body.annualQuota === 0 })
  }

  async function handleAdd(t) {
    const result = await createType.mutateAsync({
      name: t.name.trim(),
      code: t.code.trim().toUpperCase(),
      annualQuota: Number(t.days),
      isPaid: t.paid,
      carryForward: t.carry_forward,
      ...(t.carry_forward ? { carryForwardCap: Number(t.carry_forward_cap) } : {}),
    }).catch(() => null)
    if (!result) return false

    setAdding(false)
    setNotice(result.restored
      ? `${result.row.name} (${result.row.code}) had been archived. It is back, with its earlier balances and history, and the values you entered.`
      : '')
    return true
  }

  return (
    <Section title="Leave Types" desc="Days granted each leave year, whether they are paid, and what carries into the next year. An unpaid type with 0 days a year has no limit — Loss of Pay: each day is cut from pay. Each type's rules — what a new joiner gets, from when it can be used, notice, monthly accrual, half days, encashment — are under its sliders button. One person's own days a year are set on their profile, under Leave.">
      <div className="py-3 space-y-3">
        {notice && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-brand-50 border border-brand-200 text-xs text-brand-800">
            <Info className="w-4 h-4 shrink-0" /><span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice('')} className="text-brand-500 hover:text-brand-700"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        <div className="border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full min-w-160">
            <thead>
              <tr>
                {['Leave Type', 'Code', 'Days / Year', 'Paid', 'Carry Forward', ''].map((h) => (
                  <th key={h} className={th}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <DataRows query={leaveTypes} colSpan={6} empty="No leave types yet. Add the first one below.">
                {(types) => types.map((t) => (editId === t.id ? (
                <LeaveTypeEditor key={t.id} type={t} onClose={() => setEditId(null)} onAskDays={askDays} />
              ) : (
                <tr key={t.id} className="border-b border-gray-100 last:border-0 hover:bg-gray-50">
                  <td className="px-4 py-3">
                    <p className="text-sm font-medium text-gray-900">{t.name}</p>
                    {leaveRulesSummary(t) && <p className="text-xs text-gray-400">{leaveRulesSummary(t)}</p>}
                  </td>
                  <td className="px-4 py-3">
                    <span className="font-mono text-xs font-semibold text-gray-600 bg-gray-100 px-2 py-0.5 rounded">{t.code}</span>
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-700">{daysCell(t)}</td>
                  <td className="px-4 py-3 text-sm">{t.paid ? <span className="text-green-700">Paid</span> : <span className="text-amber-700">Unpaid</span>}</td>
                  <td className="px-4 py-3 text-sm text-gray-700">{t.carry_forward ? `Up to ${t.carry_forward_cap} days` : 'No'}</td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button type="button" onClick={() => setRuling(t)} title={`Rules of ${t.name}: notice, accrual, encashment`} aria-label={`Rules of ${t.name}`}
                        className="p-1.5 rounded-lg hover:bg-brand-50 text-gray-400 hover:text-brand-600"><SlidersHorizontal className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => { setEditId(t.id); setAdding(false) }} title={`Change ${t.name}`}
                        className="p-1.5 rounded-lg hover:bg-brand-50 text-gray-400 hover:text-brand-600"><Edit2 className="w-3.5 h-3.5" /></button>
                      <button type="button" onClick={() => setArchiving(t)} disabled={archiveType.isPending} title={`Archive ${t.name}`}
                        className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"><Archive className="w-3.5 h-3.5" /></button>
                    </div>
                  </td>
                </tr>
              )))}
              </DataRows>
              {adding && <LeaveTypeEditor type={null} onAdd={handleAdd} saving={createType.isPending} onClose={() => setAdding(false)} />}
            </tbody>
          </table>
        </div>

        {!adding && (
          <button type="button" onClick={() => { setAdding(true); setEditId(null); setNotice('') }}
            className="inline-flex items-center gap-1.5 text-sm font-medium text-brand-600 hover:text-brand-800">
            <Plus className="w-4 h-4" /> Add a leave type
          </button>
        )}
      </div>

      {ruling && <LeaveTypeRulesDialog type={ruling} onClose={() => setRuling(null)} />}

      {daysChange && (
        <ConfirmDialog
          title={`${daysChange.type.name}: ${daysChange.becomesUnlimited ? 'no limit' : `${dayCount(daysChange.body.annualQuota)} a year`}?`}
          confirmLabel="Save"
          onConfirm={async () => {
            const result = await updateType.mutateAsync({ id: daysChange.type.id, ...daysChange.body, ...(thisYear ? { applyToThisYear: true } : {}) })
            toast.success(daysChange.becomesUnlimited
              ? `${daysChange.body.name ?? daysChange.type.name}: no limit.`
              : daysSaved(daysChange.body.name ?? daysChange.type.name, daysChange.body.annualQuota, result.balances))
            daysChange.done()
          }}
          onClose={() => setDaysChange(null)}>
          {daysChange.becomesUnlimited ? (
            // Unpaid with 0 days a year: no limit (Loss of Pay).
            <p>
              {daysChange.type.name} will have no limit: nobody needs days of it to apply, it is approved like any leave, and each day taken is cut from pay.
              Days of it already given stay in balances, unless this year’s balances are changed below.
            </p>
          ) : daysChange.wasUnlimited ? (
            // Unpaid with no limit becoming a limit: given like other leave from now on.
            <p>
              {daysChange.type.name} will have a limit of {dayCount(daysChange.body.annualQuota)} a year, given to each person like other leave — from the next leave year, or this year too if you tick below.
              Nobody can take more than they are given. While no unpaid type has no limit, a short application is not offered the rest as unpaid leave.
            </p>
          ) : (
            <p>
              It was {dayCount(daysChange.type.days)}. From the next leave year everybody gets {dayCount(daysChange.body.annualQuota)} of {daysChange.type.name} — people given days of their own keep theirs.
              A year already given in advance changes to match.
            </p>
          )}
          {managesBalances ? (
            <label className="flex items-start gap-2.5 rounded-lg border border-gray-200 p-3 cursor-pointer">
              <input type="checkbox" checked={thisYear} onChange={(e) => setThisYear(e.target.checked)} className="mt-0.5 w-4 h-4 accent-brand-600" />
              <span>
                <span className="block font-semibold text-gray-900">Also change this year’s balances now</span>
                <span className="block text-xs text-gray-500">Everybody already given this year’s leave gets the difference in {daysChange.type.name} — a joiner by their share. Days already taken or applied for are never taken back.</span>
              </span>
            </label>
          ) : (
            <p className="text-xs text-gray-500">This year’s balances stay as they are. Whoever manages leave balances can change them.</p>
          )}
        </ConfirmDialog>
      )}

      {archiving && (
        <ConfirmDialog title={`Archive ${archiving.name}?`} confirmLabel="Archive" danger
          onConfirm={() => archiveType.mutateAsync({ id: archiving.id })}
          onClose={() => setArchiving(null)}>
          <p>Nobody will be able to apply for <strong>{archiving.name}</strong>. Balances and leave already taken stay on record.</p>
          <p>Adding {archiving.code} again brings it back.</p>
        </ConfirmDialog>
      )}
    </Section>
  )
}

/**
 * One row, editable. With `type` it changes that type and sends only what
 * changed; without, it is the new-type row and hands the draft to `onAdd`.
 */
function LeaveTypeEditor({ type, onAdd, saving, onClose, onAskDays }) {
  const updateType = useUpdateLeaveType()
  const [t, setT] = useState(() => (type
    ? { ...type, days: String(type.days), carry_forward_cap: type.carry_forward_cap ? String(type.carry_forward_cap) : '' }
    : EMPTY_TYPE))
  const [tried, setTried] = useState(false)

  const problem = typeProblem(t)
  // Unpaid leave has no paid days to carry: turning Paid off turns carry forward off with it.
  const set = (key, value) => setT({ ...t, [key]: value, ...(key === 'paid' && !value ? { carry_forward: false } : {}) })

  async function handleSave() {
    setTried(true)
    if (problem) return

    if (!type) {
      await onAdd(t)
      return
    }

    const body = {}
    if (t.name.trim() !== type.name) body.name = t.name.trim()
    if (t.code.trim().toUpperCase() !== type.code) body.code = t.code.trim().toUpperCase()
    if (Number(t.days) !== type.days) body.annualQuota = Number(t.days)
    if (t.paid !== type.paid) body.isPaid = t.paid
    if (t.carry_forward !== type.carry_forward) body.carryForward = t.carry_forward
    if (t.carry_forward && Number(t.carry_forward_cap) !== type.carry_forward_cap) body.carryForwardCap = Number(t.carry_forward_cap)
    // The server checks carry-forward and its cap together, so they travel together.
    if (body.carryForward === true) body.carryForwardCap = Number(t.carry_forward_cap)
    // Unpaid — made so now, or saved so before the rule — cannot be encashed either (set under its rules).
    if (!t.paid && type.encashable) body.encashable = false

    if (Object.keys(body).length === 0) return onClose()
    // New days a year: asked first whether this year's balances change too.
    if (body.annualQuota !== undefined && onAskDays) return onAskDays(type, body, onClose)
    const ok = await updateType.mutateAsync({ id: type.id, ...body }).then(() => true, () => false)
    if (ok) onClose()
  }

  const busy = saving || updateType.isPending

  return (
    <>
      <tr className="bg-brand-50/40 border-b border-gray-100">
        <td className="px-4 py-2"><input className={`${inpSm} w-full`} value={t.name} maxLength={60} placeholder="e.g. Casual Leave" onChange={(e) => set('name', e.target.value)} /></td>
        <td className="px-4 py-2"><input className={`${inpSm} w-20 font-mono uppercase`} value={t.code} maxLength={6} placeholder="CL" onChange={(e) => set('code', e.target.value)} /></td>
        <td className="px-4 py-2"><input type="number" min="0" max="365" step="0.5" className={`${inpSm} w-20`} value={t.days} onChange={(e) => set('days', e.target.value)} /></td>
        <td className="px-4 py-2"><Toggle checked={t.paid} onChange={(v) => set('paid', v)} label="Paid leave" /></td>
        <td className="px-4 py-2">
          <div className="flex items-center gap-2">
            {/* Off for unpaid leave — but never stuck on: one saved on before the rule can still be turned off. */}
            <Toggle checked={t.carry_forward} onChange={(v) => set('carry_forward', v)} label="Carry forward" disabled={!t.paid && !t.carry_forward} />
            {t.carry_forward && (
              <input type="number" min="0.5" max="365" step="0.5" className={`${inpSm} w-20`} value={t.carry_forward_cap}
                placeholder="days" title="Most days that may be carried into the next leave year" onChange={(e) => set('carry_forward_cap', e.target.value)} />
            )}
          </div>
        </td>
        <td className="px-4 py-2">
          <div className="flex items-center justify-end gap-1">
            <button type="button" onClick={handleSave} disabled={busy} title={type ? 'Save' : 'Add'}
              className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 disabled:opacity-50"><Check className="w-3.5 h-3.5" /></button>
            <button type="button" onClick={onClose} title="Cancel"
              className="p-1.5 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200"><X className="w-3.5 h-3.5" /></button>
          </div>
        </td>
      </tr>
      {!t.paid && (
        <tr><td colSpan={6} className="px-4 py-2 text-xs text-amber-800 bg-amber-50">
          Unpaid: each day is cut from pay. 0 days a year means no limit (Loss of Pay); a number caps it. Unpaid leave does not carry forward.
        </td></tr>
      )}
      {tried && problem && (
        <tr><td colSpan={6} className="px-4 py-2 text-xs text-red-700 bg-red-50">{problem}</td></tr>
      )}
    </>
  )
}

// ─── Holidays ───────────────────────────────────────────────────────────────

const TYPE_LABEL = { public: 'Public', optional: 'Optional', weekly_off: 'Weekly off' }
const TYPE_STYLE = {
  public: 'bg-green-50 text-green-700 border-green-200',
  optional: 'bg-purple-50 text-purple-700 border-purple-200',
  weekly_off: 'bg-gray-100 text-gray-600 border-gray-200',
}

function holidayDay(day) {
  return formatDay(day, { weekday: true, year: false })
}

/**
 * What a calendar change did NOT do. Leave already approved was counted on the
 * calendar as it stood; the server says how many requests cover the day, and
 * this says so in words. Only a PUBLIC holiday frees a day, so adding or
 * removing an optional one changes nobody's count and needs no notice.
 */
function leaveNotice(count, day, change) {
  if (!count) return ''
  const requests = count === 1 ? '1 approved leave request covers' : `${count} approved leave requests cover`
  const tail = {
    added: 'It was charged for that day before the holiday existed, and has not been changed — credit the day back if it should be.',
    removed: 'It was not charged for that day while it was a holiday, and has not been changed — adjust it if the day should now count.',
    changed: 'Leave already approved was counted on the calendar as it stood and has not been recalculated — adjust it if it should be.',
  }[change]
  return `${requests} ${holidayDay(day)}. ${tail}`
}

/**
 * The calendar everybody's leave is counted against. A PUBLIC holiday is off
 * for everybody; an OPTIONAL one is each person's pick from a short list, so it
 * does not free the day by itself.
 */
function Holidays({ canManage }) {
  const timezone = useAuthStore((s) => s.organization?.timezone)
  const thisYear = Number(calendarDayIn(timezone).slice(0, 4))
  const [year, setYear] = useState(thisYear)
  const holidays = useHolidays(year)
  const addHoliday = useAddHoliday()
  const deleteHoliday = useDeleteHoliday()

  const [draft, setDraft] = useState({ date: '', name: '', type: 'public' })
  const [editId, setEditId] = useState(null)
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState(null)

  // Opened from Home's "Add holidays" (…#holidays): straight to here, below the
  // leave types, with the focus here too, so the next Tab goes into this
  // section. The sections above may still be loading, and grow after the first
  // scroll, so for a moment it is kept in place as they do — until the person
  // scrolls, clicks or types themselves.
  const { hash } = useLocation()
  useEffect(() => {
    const section = hash === '#holidays' ? document.getElementById('holidays') : null
    if (!section) return undefined
    const bring = () => section.scrollIntoView({ block: 'start' })
    bring()
    section.focus({ preventScroll: true })
    const grows = new ResizeObserver(bring)
    grows.observe(section.parentElement ?? section)
    const stop = () => grows.disconnect()
    const timer = setTimeout(stop, 3000)
    const theirs = ['wheel', 'touchstart', 'pointerdown', 'keydown']
    for (const event of theirs) window.addEventListener(event, stop, { passive: true })
    return () => {
      stop()
      clearTimeout(timer)
      for (const event of theirs) window.removeEventListener(event, stop)
    }
  }, [hash])

  async function handleAdd(e) {
    e.preventDefault()
    const result = await addHoliday.mutateAsync({ date: draft.date, name: draft.name.trim(), type: draft.type }).catch(() => null)
    if (!result) return
    // Show the year the holiday went into, so it does not seem to vanish.
    const addedYear = Number(result.row.date.slice(0, 4))
    if (addedYear !== year) setYear(addedYear)
    setDraft({ date: '', name: '', type: draft.type })
    setNotice(result.row.type === 'public' ? leaveNotice(result.approvedLeaveAffected, result.row.date, 'added') : '')
  }

  async function handleDelete(h) {
    const result = await deleteHoliday.mutateAsync({ id: h.id })
    setNotice(h.type === 'public' ? leaveNotice(result.approvedLeaveAffected, h.date, 'removed') : '')
  }

  const years = [thisYear - 1, thisYear, thisYear + 1]
  const publicCount = holidays.data?.filter((h) => h.type === 'public').length

  return (
    <Section id="holidays" title="Holidays" desc="Diwali, Holi, Eid and the state holidays move every year — enter them here. Leave is not charged for a public holiday.">
      <div className="py-3 space-y-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {years.map((y) => (
              <button key={y} type="button" onClick={() => { setYear(y); setEditId(null) }}
                className={`px-3.5 py-1.5 text-sm font-medium ${y === year ? 'bg-brand-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {y}
              </button>
            ))}
          </div>
          {/* Counted only from an answer — a failed load is not "0 public". */}
          {holidays.isSuccess && <p className="text-xs text-gray-500">{publicCount} public, {holidays.data.length - publicCount} other in {year}</p>}
        </div>

        {notice && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
            <Info className="w-4 h-4 shrink-0" /><span className="flex-1">{notice}</span>
            <button type="button" onClick={() => setNotice('')} className="text-amber-600 hover:text-amber-800"><X className="w-3.5 h-3.5" /></button>
          </div>
        )}

        <div className="border border-gray-200 rounded-xl divide-y divide-gray-100">
          <DataState query={holidays} compact empty={`No holidays entered for ${year}.`}>
            {(list) => list.map((h) => (editId === h.id ? (
            <HolidayEditor key={h.id} holiday={h} onDone={(message) => { setEditId(null); if (message) setNotice(message) }} />
          ) : (
            <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
              <span className="w-28 text-sm text-gray-600 shrink-0">{holidayDay(h.date)}</span>
              <span className="flex-1 text-sm font-medium text-gray-900">{h.name}</span>
              <span className={`text-xs font-medium px-2 py-0.5 rounded-full border ${TYPE_STYLE[h.type] ?? TYPE_STYLE.weekly_off}`}>{TYPE_LABEL[h.type] ?? h.type}</span>
              {canManage && (
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => setEditId(h.id)} title={`Change ${h.name}`}
                    className="p-1.5 rounded-lg hover:bg-brand-50 text-gray-400 hover:text-brand-600"><Edit2 className="w-3.5 h-3.5" /></button>
                  <button type="button" onClick={() => setRemoving(h)} disabled={deleteHoliday.isPending} title={`Remove ${h.name}`}
                    className="p-1.5 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-500"><Trash2 className="w-3.5 h-3.5" /></button>
                </div>
              )}
            </div>
          )))}
          </DataState>
        </div>

        {canManage && (
          <form onSubmit={handleAdd} className="flex items-end gap-2 flex-wrap pt-1">
            <label className="text-xs text-gray-500">
              Date
              <input type="date" required value={draft.date} onChange={(e) => setDraft({ ...draft, date: e.target.value })}
                min="2000-01-01" max="2100-12-31" className={`${inpSm} block mt-1`} />
            </label>
            <label className="text-xs text-gray-500 flex-1 min-w-45">
              Name
              <input required maxLength={80} value={draft.name} placeholder="e.g. Diwali" onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className={`${inpSm} block w-full mt-1`} />
            </label>
            <label className="text-xs text-gray-500">
              Type
              <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} className={`${inpSm} block mt-1`}>
                <option value="public">Public — off for everybody</option>
                <option value="optional">Optional — each person picks</option>
              </select>
            </label>
            <button type="submit" disabled={addHoliday.isPending}
              className={btn.primary}>
              <Plus className="w-4 h-4" /> {addHoliday.isPending ? 'Adding…' : 'Add holiday'}
            </button>
          </form>
        )}
      </div>

      {removing && (
        <ConfirmDialog title={`Remove ${removing.name} on ${holidayDay(removing.date)} ${removing.date.slice(0, 4)}?`} confirmLabel="Remove" danger
          onConfirm={() => handleDelete(removing)}
          onClose={() => setRemoving(null)}>
          <p><strong>{removing.name}</strong> comes off the calendar everybody's leave is counted against.</p>
          {removing.type === 'public' && <p>Leave already approved for that day is not recalculated — you will be told if any covers it.</p>}
        </ConfirmDialog>
      )}
    </Section>
  )
}

function HolidayEditor({ holiday, onDone }) {
  const updateHoliday = useUpdateHoliday()
  const [h, setH] = useState({ date: holiday.date, name: holiday.name, type: holiday.type })

  async function handleSave(e) {
    e.preventDefault()
    const body = {}
    if (h.date !== holiday.date) body.date = h.date
    if (h.name.trim() !== holiday.name) body.name = h.name.trim()
    if (h.type !== holiday.type) body.type = h.type
    if (Object.keys(body).length === 0) return onDone('')

    const result = await updateHoliday.mutateAsync({ id: holiday.id, ...body }).catch(() => null)
    // A rename changes nothing anybody was charged; a new date or type can.
    const matters = body.type || (body.date && result?.row.type === 'public')
    if (result) onDone(matters ? leaveNotice(result.approvedLeaveAffected, result.row.date, 'changed') : '')
  }

  return (
    <form onSubmit={handleSave} className="flex items-center gap-2 px-4 py-2 bg-brand-50/40 flex-wrap">
      <input type="date" required value={h.date} min="2000-01-01" max="2100-12-31" onChange={(e) => setH({ ...h, date: e.target.value })} className={inpSm} />
      <input required maxLength={80} value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} className={`${inpSm} flex-1 min-w-40`} />
      <select value={h.type} onChange={(e) => setH({ ...h, type: e.target.value })} className={inpSm}>
        {holiday.type === 'weekly_off' && <option value="weekly_off" disabled>Weekly off (older entry)</option>}
        <option value="public">Public</option>
        <option value="optional">Optional</option>
      </select>
      <button type="submit" disabled={updateHoliday.isPending} title="Save"
        className="p-1.5 rounded-lg bg-green-100 text-green-700 hover:bg-green-200 disabled:opacity-50"><Check className="w-3.5 h-3.5" /></button>
      <button type="button" onClick={() => onDone('')} title="Cancel"
        className="p-1.5 rounded-lg bg-gray-100 text-gray-500 hover:bg-gray-200"><X className="w-3.5 h-3.5" /></button>
    </form>
  )
}
