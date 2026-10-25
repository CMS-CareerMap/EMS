import { useState } from 'react'
import { toast } from 'sonner'
import { Loader2 } from 'lucide-react'
import { useAbsentRule, useAbsentRulePreview, useSaveAbsentRule } from '../../hooks/useSettings'
import DataState from '../../components/DataState'
import { addDays, formatDay } from '../../lib/dates'
import { monthLabel } from '../../lib/attendance'
import { Section, Field, SaveBar, Toggle, inpSm } from './ui'

/**
 * No check-in means Absent (client, 25 Oct 2026): "punch nahi rhega to absent
 * hi mana jayega". A working day that ends with no punch, no leave and nobody's
 * mark is Absent — for everybody — from the day chosen. Before saving, the page
 * says what it will do: how many days it marks, how many it gives back.
 */
export default function AbsentRuleSection({ canEdit }) {
  const rule = useAbsentRule()
  return (
    <Section title="No Check-in Means Absent"
      desc="A working day that ends with no check-in, no leave and nobody’s mark is recorded Absent, for everybody. On the app a day is judged once the person’s shift has ended — a night shift the next morning. Weekly offs and holidays never are. A check-in after all, leave approved, an attendance correction or HR’s mark replaces it, and the person is told, with the way to apply leave or ask for a correction.">
      <DataState query={rule} compact loading="Loading the rule…">
        {(saved) => <RuleForm key={`${saved.on}|${saved.from}|${saved.wait_days}`} saved={saved} canEdit={canEdit} />}
      </DataState>
    </Section>
  )
}

function monthOf(key) {
  const [y, m] = key.split('-').map(Number)
  return monthLabel(y, m)
}

function RuleForm({ saved, canEdit }) {
  const save = useSaveAbsentRule()
  const [on, setOn] = useState(saved.on)
  // Off, the rule starts again when switched on: from today unless another day is chosen.
  const [from, setFrom] = useState(saved.on && saved.from ? saved.from : saved.today)
  const [waitDays, setWaitDays] = useState(String(saved.wait_days))
  const wait = Number(waitDays)
  const values = { on, from: on ? from : saved.from, waitDays: wait }
  // The earliest start is checked only when the start is moved: a rule on since long ago keeps its day.
  const latest = addDays(saved.today, 366)
  const valid = Number.isInteger(wait) && wait >= 1 && wait <= 14 && (!on || (from && ((saved.on && from === saved.from) || from >= saved.earliest_from) && from <= latest))
  const changed = on !== saved.on || (on && from !== saved.from) || wait !== saved.wait_days
  const preview = useAbsentRulePreview(values, { enabled: canEdit && changed && valid })

  async function onSave() {
    const done = await save.mutateAsync(values).catch(() => null)
    if (!done) return
    const r = done.run
    toast.success(r.marked || r.removed
      ? `Saved: ${r.marked} day${r.marked === 1 ? '' : 's'} marked absent, ${r.removed} given back.`
      : 'Saved.')
  }

  return (
    <>
      <Field label="No check-in means absent" hint="Off: a day with nothing recorded stays “Not marked”, and is paid.">
        <Toggle checked={on} onChange={setOn} disabled={!canEdit} label="No check-in means absent" />
      </Field>
      {on && (
        <Field label="From" hint={`Days before it stay as they are. A month whose payroll is approved never changes. The 1st of last month (${formatDay(saved.earliest_from)}) at the earliest.`}>
          <input type="date" value={from ?? ''} min={saved.on && saved.from && saved.from < saved.earliest_from ? saved.from : saved.earliest_from} max={latest} onChange={(e) => setFrom(e.target.value)} disabled={!canEdit}
            aria-label="The first day the rule applies to" className={inpSm} />
        </Field>
      )}
      <Field label="Wait for the machine’s file or HR’s marking" hint="For people whose days come from the fingerprint machine, or are marked by HR: a day is judged only after these days, so its file or mark can come first. 1 to 14.">
        <div className="flex items-center gap-2">
          <input type="number" min="1" max="14" step="1" value={waitDays} onChange={(e) => setWaitDays(e.target.value)} disabled={!canEdit}
            aria-label="Days to wait" className={`${inpSm} w-24`} />
          <span className="text-sm text-gray-600">days</span>
        </div>
      </Field>

      {canEdit && changed && valid && (
        <div role="status" className="my-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {preview.isLoading ? (
            <span className="inline-flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />Working out what saving will do…</span>
          ) : preview.isError ? (
            <span>What saving will do could not be worked out. It can still be saved.</span>
          ) : preview.data ? (
            <span>
              Saving will mark <b>{preview.data.marked}</b> day{preview.data.marked === 1 ? '' : 's'} absent
              {preview.data.people > 0 && <> for <b>{preview.data.people}</b> {preview.data.people === 1 ? 'person' : 'people'}</>}
              {' '}and give back <b>{preview.data.removed}</b>. Each person is told.
              {preview.data.closed_months.length > 0 && <> {preview.data.closed_months.map(monthOf).join(', ')} {preview.data.closed_months.length === 1 ? 'is' : 'are'} left as {preview.data.closed_months.length === 1 ? 'it is' : 'they are'}: payroll is closed.</>}
            </span>
          ) : null}
        </div>
      )}

      {/* Its own name: the page has the method's Save Changes too. */}
      {canEdit && <SaveBar onSave={onSave} saving={save.isPending} saved={false} disabled={!changed || !valid} label="Save rule" />}
    </>
  )
}
