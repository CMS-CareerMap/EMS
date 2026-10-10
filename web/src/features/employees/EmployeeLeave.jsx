import { useState } from 'react'
import { toast } from 'sonner'
import { ScrollText, SlidersHorizontal } from 'lucide-react'
import DataState from '../../components/DataState'
import StatementDialog from '../leave/StatementDialog'
import Dialog, { inputCls } from '../../components/Dialog'
import { Card } from '../../components/ui/bits'
import { btn, th } from '../../components/ui/styles'
import { usePersonLeave, useSetEntitlement } from '../../hooks/useLeave'

/**
 * The profile's Leave tab (client, 9 Oct 2026): each leave type's days a year
 * for this person — the company's, or their own — and this year's balance.
 *
 * Their own days are set by whoever manages leave balances, never for
 * themselves or somebody senior (the server says who may, and whom to ask).
 * A change applies at once to the years already granted: 12 → 15 adds three
 * days now. Days already taken or applied for are never taken back.
 */

const dayCount = (n) => `${n} day${Math.abs(n) === 1 ? '' : 's'}`

/** Days a year as one phrase: "12 days a year", "No limit", "Granted as needed". */
function daysAYear(t) {
  if (t.unlimited) return 'No limit'
  const days = t.own_days ?? t.company_days
  return days > 0 ? `${dayCount(days)} a year` : 'Granted as needed'
}

/** The company's days of a type, as a phrase. */
function companyDays(t) {
  if (t.company_days > 0) return dayCount(t.company_days)
  return t.is_paid ? 'granted as needed' : 'no limit'
}

function thisYear(t) {
  if (t.unlimited) return `${dayCount(t.taken)} taken — unpaid`
  const parts = [`${t.available} left`, `${t.taken} taken`, `${t.granted} given`]
  if (t.pending > 0) parts.push(`${t.pending} applied for`)
  return parts.join(' · ')
}

function StatementButton({ type, onClick }) {
  return (
    <button type="button" onClick={onClick} aria-label={`${type.name} statement`}
      className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:text-brand-800 hover:underline">
      <ScrollText className="w-3.5 h-3.5" aria-hidden="true" />Statement
    </button>
  )
}

export default function EmployeeLeave({ employeeId }) {
  const query = usePersonLeave(employeeId)
  const [changing, setChanging] = useState(null)
  const [statementOf, setStatementOf] = useState(null)

  return (
    <Card title={`Leave${query.data ? ` — ${query.data.label}` : ''}`} subtitle="Days a year — the company’s, or their own — and this year’s balance">
      <DataState query={query}>
        {(d) => (
          <div className="space-y-3">
            {!d.may_change && (
              <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                Their days a year are changed by {d.change_goes_to ?? 'somebody above them'}.
              </p>
            )}

            {/* A computer: the table. */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr>
                    <th className={`${th} pl-4`}>Leave type</th>
                    <th className={th}>Days a year</th>
                    <th className={th}>{d.label}</th>
                    <th className={`${th} text-right pr-4`}><span className="sr-only">Change</span></th>
                  </tr>
                </thead>
                <tbody>
                  {d.types.map((t) => (
                    <tr key={t.leave_type_id} className="border-b border-gray-100 last:border-0">
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-900">{t.name}</p>
                        <p className="text-xs text-gray-400">{t.code}{t.is_paid ? '' : ' · unpaid'}</p>
                      </td>
                      <td className="px-4 py-3">
                        <p className="font-semibold text-gray-900">{daysAYear(t)}</p>
                        <p className="text-xs text-gray-500">{t.own_days != null ? `Their own — the company’s: ${companyDays(t)}` : 'The company’s'}</p>
                      </td>
                      <td className="px-4 py-3 text-gray-700 tabular-nums">{thisYear(t)}</td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <StatementButton type={t} onClick={() => setStatementOf(t)} />
                          {d.may_change && (
                            <button type="button" onClick={() => setChanging(t)} className={btn.secondarySm} aria-label={`Change ${t.name} days a year`}>
                              <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" /> Change
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* A phone: one card a type. */}
            <ul className="md:hidden divide-y divide-gray-100" aria-label="Leave types">
              {d.types.map((t) => (
                <li key={t.leave_type_id} className="py-3 space-y-1.5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{t.name}{t.is_paid ? '' : ' · unpaid'}</p>
                      <p className="text-xs text-gray-500">{daysAYear(t)} · {t.own_days != null ? `their own (company’s: ${companyDays(t)})` : 'the company’s'}</p>
                    </div>
                    {d.may_change && (
                      <button type="button" onClick={() => setChanging(t)} className={`shrink-0 ${btn.secondarySm}`} aria-label={`Change ${t.name} days a year`}>
                        <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" /> Change
                      </button>
                    )}
                  </div>
                  <p className="text-xs text-gray-700 tabular-nums">{thisYear(t)}</p>
                  <StatementButton type={t} onClick={() => setStatementOf(t)} />
                </li>
              ))}
            </ul>
          </div>
        )}
      </DataState>

      {changing && query.data && <ChangeDialog person={query.data} type={changing} onClose={() => setChanging(null)} />}
      {/* The passbook they see, for HR here (client, 10 Oct 2026). */}
      {statementOf && query.data && (
        <StatementDialog employeeId={employeeId} leaveTypeId={statementOf.leave_type_id} title={`${statementOf.name} — ${query.data.full_name}`} onClose={() => setStatementOf(null)} />
      )}
    </Card>
  )
}

function ChangeDialog({ person, type, onClose }) {
  const save = useSetEntitlement()
  const [own, setOwn] = useState(type.own_days != null)
  const [days, setDays] = useState(type.own_days != null ? String(type.own_days) : '')
  const [note, setNote] = useState('')
  const n = Number(days)
  const wellFormed = days !== '' && n >= 0 && n <= 365 && Number.isInteger(n * 2)
  const unchanged = own ? wellFormed && n === type.own_days : type.own_days == null
  const valid = (!own || wellFormed) && !unchanged && note.trim().length >= 3

  async function submit(e) {
    e.preventDefault()
    if (!valid) return
    const result = await save.mutateAsync({ employeeId: person.employee_id, leaveTypeId: type.leave_type_id, days: own ? n : null, note: note.trim() }).catch(() => null)
    if (!result) return
    const moved = result.balance_change
    const kept = result.not_taken_back ? ` ${dayCount(result.not_taken_back)} already taken or applied for ${result.not_taken_back === 1 ? 'was' : 'were'} not taken back.` : ''
    toast.success(`${person.full_name}: ${type.name} ${own ? `${dayCount(n)} a year` : 'back to the company’s'}.${moved ? ` ${dayCount(Math.abs(moved))} ${moved > 0 ? 'added to' : 'taken from'} the balance.` : ''}${kept}`)
    onClose()
  }

  return (
    <Dialog title={`${type.name} — ${person.full_name}`} onClose={save.isPending ? () => {} : onClose}>
      <form onSubmit={submit} className="space-y-4">
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-gray-700 mb-1">Days a year</legend>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="days" checked={!own} onChange={() => setOwn(false)} className="accent-brand-600" />
            The company’s — {type.unlimited && type.own_days == null ? 'no limit' : type.company_days > 0 ? dayCount(type.company_days) : type.is_paid ? 'granted as needed' : 'no limit'}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" name="days" checked={own} onChange={() => setOwn(true)} className="accent-brand-600" />
            Their own
          </label>
          {own && (
            <div className="pl-6 space-y-1">
              <input type="number" min="0" max="365" step="0.5" value={days} onChange={(e) => setDays(e.target.value)} className={inputCls} aria-label="Their own days a year" placeholder="15" autoFocus />
              {days !== '' && !wellFormed && <p className="text-xs text-red-600">Whole or half days, from 0 to 365.</p>}
              {!type.is_paid && <p className="text-xs text-gray-500">On unpaid leave a number is a limit for them, and 0 means no limit.</p>}
            </div>
          )}
        </fieldset>
        <p className="text-xs text-gray-500">
          This year’s balance changes at once by the difference — their share, if they joined this year. Days already taken or applied for are never taken back.
        </p>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Why</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={inputCls} placeholder="Agreed in their offer letter…" />
          <span className="text-xs text-gray-400">A few words, which {person.full_name} sees in their notice — Save waits for them.</span>
        </label>
        {unchanged && <p className="text-xs text-amber-700">That is what they have now: nothing to change.</p>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" onClick={onClose} disabled={save.isPending} className={btn.secondary}>Cancel</button>
          <button type="submit" disabled={!valid || save.isPending} className={btn.primary}>{save.isPending ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Dialog>
  )
}
