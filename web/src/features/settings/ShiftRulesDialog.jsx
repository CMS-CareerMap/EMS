import { useState } from 'react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import { useEditShift } from '../../hooks/useMasterDataAdmin'

/**
 * A shift's rules (client §34): grace, when lateness or leaving early costs
 * half a day, the hours a full and a half day need, and when overtime starts.
 * Each left empty is off, or takes the fraction of the expected hours it took
 * before these existed.
 */
export default function ShiftRulesDialog({ shift, onClose }) {
  const edit = useEditShift()
  const blank = (v) => (v === null || v === undefined ? '' : String(v))
  const [form, setForm] = useState({
    graceMinutes: blank(shift.grace_minutes),
    lateThresholdMinutes: blank(shift.late_threshold_minutes),
    earlyLeavingMinutes: blank(shift.early_leaving_minutes),
    minFullDayHours: blank(shift.min_full_day_hours),
    minHalfDayHours: blank(shift.min_half_day_hours),
    overtimeAfterMinutes: blank(shift.overtime_after_minutes),
  })
  const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })
  const orNull = (v) => (v === '' ? null : Number(v))

  async function submit(e) {
    e.preventDefault()
    const done = await edit
      .mutateAsync({
        id: shift.id,
        graceMinutes: Number(form.graceMinutes || 0),
        lateThresholdMinutes: orNull(form.lateThresholdMinutes),
        earlyLeavingMinutes: orNull(form.earlyLeavingMinutes),
        minFullDayHours: orNull(form.minFullDayHours),
        minHalfDayHours: orNull(form.minHalfDayHours),
        overtimeAfterMinutes: Number(form.overtimeAfterMinutes || 0),
      })
      .then(() => true, () => false)
    if (done) {
      toast.success(`${shift.name}: rules saved`)
      onClose()
    }
  }

  const full = shift.expected_hours
  return (
    <Dialog title={`${shift.name} — rules`} onClose={edit.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-gray-500">
          {shift.start_time} to {shift.end_time}, {full} hours expected. These apply to days recorded from now on; days already recorded keep what they were measured against.
        </p>
        <Row label="Grace period (minutes)" hint="Arriving this late, or leaving this early, is not marked at all.">
          <input type="number" min="0" max="240" step="1" className={inputCls} value={form.graceMinutes} onChange={set('graceMinutes')} aria-label="Grace period in minutes" />
        </Row>
        <Row label="Late threshold (minutes)" hint="Arriving more than this after the start makes the day a half day. Empty: lateness is marked, never costs a day.">
          <input type="number" min="0" max="720" step="1" placeholder="Off" className={inputCls} value={form.lateThresholdMinutes} onChange={set('lateThresholdMinutes')} aria-label="Late threshold in minutes" />
        </Row>
        <Row label="Early leaving (minutes)" hint="Leaving more than this before the end makes the day a half day. Empty: marked only.">
          <input type="number" min="0" max="720" step="1" placeholder="Off" className={inputCls} value={form.earlyLeavingMinutes} onChange={set('earlyLeavingMinutes')} aria-label="Early leaving in minutes" />
        </Row>
        <Row label="Minimum hours — full day" hint={`Empty: three quarters of the shift (${Math.round(full * 0.75 * 100) / 100} h).`}>
          <input type="number" min="0.25" max="24" step="0.25" placeholder={String(Math.round(full * 0.75 * 100) / 100)} className={inputCls} value={form.minFullDayHours} onChange={set('minFullDayHours')} aria-label="Minimum hours for a full day" />
        </Row>
        <Row label="Minimum hours — half day" hint={`Below this the day is absent. Empty: half the shift (${full / 2} h).`}>
          <input type="number" min="0.25" max="24" step="0.25" placeholder={String(full / 2)} className={inputCls} value={form.minHalfDayHours} onChange={set('minHalfDayHours')} aria-label="Minimum hours for a half day" />
        </Row>
        <Row label="Overtime after (minutes)" hint="Work past the expected hours counts as overtime once it reaches this — then all of it counts. Only approved overtime is paid.">
          <input type="number" min="0" max="720" step="1" className={inputCls} value={form.overtimeAfterMinutes} onChange={set('overtimeAfterMinutes')} aria-label="Overtime after minutes" />
        </Row>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={edit.isPending} className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={edit.isPending} className="px-4 py-2 text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 rounded-lg disabled:opacity-60">{edit.isPending ? 'Saving…' : 'Save rules'}</button>
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
