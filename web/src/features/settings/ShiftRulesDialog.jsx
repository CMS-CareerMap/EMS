import { btn } from '../../components/ui/styles'
import { useState } from 'react'
import { toast } from 'sonner'
import Dialog, { inputCls } from '../../components/Dialog'
import { useEditShift } from '../../hooks/useMasterDataAdmin'

/**
 * A shift's rules (client §34): grace, when lateness or leaving early costs
 * half a day, and when overtime starts. Each left empty is off. The hours a
 * full and a half day need are in the Shifts table itself, where the client
 * looks for them (8 Oct 2026).
 */
export default function ShiftRulesDialog({ shift, onClose }) {
  const edit = useEditShift()
  const blank = (v) => (v === null || v === undefined ? '' : String(v))
  const [form, setForm] = useState({
    graceMinutes: blank(shift.grace_minutes),
    lateThresholdMinutes: blank(shift.late_threshold_minutes),
    earlyLeavingMinutes: blank(shift.early_leaving_minutes),
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
          {shift.start_time} to {shift.end_time}, {full} hours. These apply to days recorded from now on, and to a day marked or corrected later; days already recorded keep their status.
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
        <Row label="Overtime after (minutes)" hint="Work past the expected hours counts as overtime once it reaches this — then all of it counts. Only approved overtime is paid.">
          <input type="number" min="0" max="720" step="1" className={inputCls} value={form.overtimeAfterMinutes} onChange={set('overtimeAfterMinutes')} aria-label="Overtime after minutes" />
        </Row>
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} disabled={edit.isPending} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={edit.isPending} className={btn.primary}>{edit.isPending ? 'Saving…' : 'Save rules'}</button>
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
