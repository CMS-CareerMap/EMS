import { useState } from 'react'
import { toast } from 'sonner'
import { Search, Gift, CheckCircle, SlidersHorizontal } from 'lucide-react'
import DataState, { DataRows } from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import Dialog, { inputCls } from '../../components/Dialog'
import { useTeamBalances, useGrantPreview, useGrantLeave, useAdjustBalance } from '../../hooks/useLeave'
import { useAuthStore } from '../../stores/authStore'
import { formatDay } from '../../lib/dates'

/**
 * Leave → Team Balances.
 *
 * Everybody's leave for the year — the company for HR and the Super Admin,
 * the team for a manager — and, for HR and the Super Admin, the two things a
 * balance needs from a person:
 *
 *   Grant leave   the year's leave for everybody who has not had it: all at
 *                 once when a year begins, or only the people added since.
 *                 New joiners get the months that are left. Nothing is ever
 *                 granted twice, so pressing it again is safe.
 *   Correct       one person, one type, whole or half days, with a reason the
 *                 employee is shown. Written as its own entry — never an edit.
 *
 * Until the year is granted, an employee's balance is zero and they cannot
 * apply for a day; the banner says so, with the button beside it.
 */

const days = (n) => `${n} day${Math.abs(n) === 1 ? '' : 's'}`

export default function TeamBalances() {
  const canManage = useAuthStore((s) => s.can('leave:balance:manage'))
  const [leaveYear, setLeaveYear] = useState(null)
  const [search, setSearch] = useState('')
  const [granting, setGranting] = useState(false)
  const [correcting, setCorrecting] = useState(null)
  const balances = useTeamBalances(leaveYear)
  const data = balances.data
  // The year the rows on screen belong to — not the one being fetched while
  // they are still the last year's. Every action uses this one.
  const year = data?.leave_year ?? null
  const switching = balances.isPlaceholderData
  // The years to choose from, kept once known: a year that fails to load must
  // not take the way back to the other one with it.
  const [years, setYears] = useState([])
  if (data?.years?.length && years.length === 0) setYears(data.years)
  const shownYear = leaveYear ?? year

  const q = search.trim().toLowerCase()
  const shown = (data?.people ?? []).filter((p) => !q || p.full_name.toLowerCase().includes(q) || p.employee_code.toLowerCase().includes(q))

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm px-4 py-3 flex flex-wrap gap-3 items-center">
        <div className="relative flex-1 min-w-48">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" aria-hidden="true" />
          <input type="text" placeholder="Search employee…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search employee"
            className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 placeholder:text-gray-400" />
        </div>
        {years.length > 0 && (
          <div className="flex rounded-lg border border-gray-200 overflow-hidden" role="group" aria-label="Leave year">
            {years.map((y) => (
              <button key={y.leave_year} type="button" onClick={() => setLeaveYear(y.leave_year)}
                className={`px-3 py-1.5 text-sm font-medium ${y.leave_year === shownYear ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                {y.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {canManage && data?.waiting && !switching && (
        data.waiting.people > 0 ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200">
            <Gift className="w-5 h-5 text-amber-600 shrink-0" aria-hidden="true" />
            <p className="flex-1 text-sm text-amber-900">
              <strong>{data.waiting.people} {data.waiting.people === 1 ? 'person has' : 'people have'} not been given their {data.label} leave yet.</strong>{' '}
              Until then their balance is zero and they cannot apply. New joiners get the months that are left; nobody is given it twice.
            </p>
            <button type="button" onClick={() => setGranting(true)}
              className="shrink-0 px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium">
              Grant leave
            </button>
          </div>
        ) : (
          <p className="flex items-center gap-2 p-3 rounded-xl bg-green-50 border border-green-200 text-sm text-green-800">
            <CheckCircle className="w-4 h-4 shrink-0" aria-hidden="true" /> Everybody here has their {data.label} leave.
          </p>
        )
      )}

      {/* inert while another year loads: the rows are still the last year's. */}
      <div className={`bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden transition-opacity ${switching ? 'opacity-60' : ''}`} inert={switching}>
        <div className="px-5 py-4 border-b border-gray-100">
          <p className="text-base font-semibold text-gray-900">Leave balances{data ? ` — ${data.label}` : ''}</p>
          <p className="text-xs text-gray-400 mt-0.5">Days each person can still apply for. Days already applied for and not yet decided are shown beneath.</p>
        </div>

        {/* On a phone, one card a person. */}
        <div className="md:hidden">
          <DataState query={balances} isEmpty={() => shown.length === 0} empty={q ? 'Nobody matches that search.' : 'Nobody here yet.'}>
            {() => (
              <ul className="divide-y divide-gray-100">
                {shown.map((p) => (
                  <li key={p.employee_id} className="p-4 space-y-2">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-gray-900">{p.full_name}</p>
                        <p className="text-xs text-gray-400">{[p.employee_code, p.department].filter(Boolean).join(' · ')}</p>
                      </div>
                      <CorrectButton person={p} canManage={canManage} onClick={() => setCorrecting(p)} />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      {data.types.map((t) => {
                        const b = p.balances.find((x) => x.leave_type_id === t.id)
                        return (
                          <div key={t.id} className="rounded-lg bg-gray-50 px-3 py-2">
                            <p className="text-xs text-gray-500">{t.name}</p>
                            <p className="text-base font-bold text-gray-900">{b.available}</p>
                            {b.pending > 0 && <p className="text-[11px] text-amber-700">{days(b.pending)} applied for</p>}
                          </div>
                        )
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </DataState>
        </div>

        <div className="hidden md:block overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <th className="px-5 py-3 text-left">Employee</th>
                {(data?.types ?? []).map((t) => <th key={t.id} className="px-4 py-3 text-right whitespace-nowrap">{t.name}</th>)}
                <th className="px-5 py-3 text-right">{canManage ? 'Correct' : ''}</th>
              </tr>
            </thead>
            <tbody>
              <DataRows query={balances} colSpan={(data?.types.length ?? 0) + 2} isEmpty={() => shown.length === 0} empty={q ? 'Nobody matches that search.' : 'Nobody here yet.'}>
                {() => shown.map((p) => (
                  <tr key={p.employee_id} className="border-b border-gray-100 last:border-0">
                    <td className="px-5 py-3">
                      <p className="font-medium text-gray-900">{p.full_name}</p>
                      <p className="text-xs text-gray-400">{[p.employee_code, p.department].filter(Boolean).join(' · ')}</p>
                    </td>
                    {data.types.map((t) => {
                      const b = p.balances.find((x) => x.leave_type_id === t.id)
                      return (
                        <td key={t.id} className="px-4 py-3 text-right">
                          <span className="font-semibold text-gray-900">{b.available}</span>
                          {b.pending > 0 && <span className="block text-[11px] text-amber-700">{days(b.pending)} applied for</span>}
                        </td>
                      )
                    })}
                    <td className="px-5 py-3 text-right">
                      <CorrectButton person={p} canManage={canManage} onClick={() => setCorrecting(p)} />
                    </td>
                  </tr>
                ))}
              </DataRows>
            </tbody>
          </table>
        </div>
      </div>

      {granting && year && <GrantDialog leaveYear={year} onClose={() => setGranting(false)} />}
      {correcting && data && <CorrectDialog person={correcting} types={data.types} leaveYear={year} label={data.label} onClose={() => setCorrecting(null)} />}
    </div>
  )
}

function CorrectButton({ person, canManage, onClick }) {
  if (!canManage) return null
  // Nobody corrects their own balance; the server refuses it too.
  if (person.own) return <span className="text-xs text-gray-400 italic">Your own</span>
  return (
    <button type="button" onClick={onClick} aria-label={`Correct ${person.full_name}’s balance`}
      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs font-medium">
      <SlidersHorizontal className="w-3.5 h-3.5" aria-hidden="true" /> Correct
    </button>
  )
}

function GrantDialog({ leaveYear, onClose }) {
  const preview = useGrantPreview(leaveYear)
  const grant = useGrantLeave()
  const label = preview.data?.label ?? ''
  // Nothing is granted that nobody has seen: held until the preview is in, and when it is empty.
  const ready = preview.isSuccess && preview.data.people > 0

  return (
    <ConfirmDialog title={`Grant the ${label || 'year’s'} leave?`} confirmLabel="Grant leave" disabled={!ready}
      onConfirm={async () => {
        const r = await grant.mutateAsync({ leaveYear })
        toast.success(`Leave granted: ${days(r.days)} to ${r.people} ${r.people === 1 ? 'person' : 'people'}`)
      }}
      onClose={onClose}>
      <DataState query={preview} compact>
        {(p) => (
          <div className="space-y-3">
            <p>
              <strong>{p.people} {p.people === 1 ? 'person' : 'people'}</strong> get their {p.label} leave: {days(p.days)} in all.
              Everybody else already has it and is left as they are.
            </p>
            {p.pro_rated.length > 0 && (
              <Lines title="Joined partway through the year — the months that are left" lines={p.pro_rated} />
            )}
            {p.people === 0 && <p>Everybody already has it. There is nothing to grant.</p>}
            {p.no_joining_date.length > 0 && (
              <div className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900">
                <p className="font-semibold">No joining date recorded — given the full year:</p>
                <p>{p.no_joining_date.map((n) => n.full_name).join(', ')}</p>
                <p className="mt-1">If any of them joined this year, cancel, set their joining date under Employees, then grant.</p>
              </div>
            )}
            {p.carried.length > 0 && (
              <Lines title="Carried in from last year" lines={p.carried} />
            )}
            {p.carry_later && (
              <p className="text-xs text-gray-500">Days left over from this year are carried in when {p.label} begins: press Grant leave again then.</p>
            )}
            <p className="text-xs text-gray-500">Each person is told in the bell. This cannot be undone as a whole, but any one balance can be corrected afterwards.</p>
          </div>
        )}
      </DataState>
    </ConfirmDialog>
  )
}

function Lines({ title, lines }) {
  return (
    <div>
      <p className="text-xs font-semibold text-gray-700 mb-1">{title}</p>
      <ul className="max-h-40 overflow-y-auto divide-y divide-gray-100 border border-gray-100 rounded-lg text-xs">
        {lines.map((l) => (
          <li key={`${l.employee_id}-${l.leave_type}`} className="px-3 py-1.5 flex justify-between gap-2">
            <span className="text-gray-700 truncate">{l.full_name} · {l.leave_type}</span>
            <span className="font-semibold text-gray-900 shrink-0">{days(l.days)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function CorrectDialog({ person, types, leaveYear, label, onClose }) {
  const adjust = useAdjustBalance()
  const [typeId, setTypeId] = useState(types[0]?.id ?? '')
  const [direction, setDirection] = useState('add')
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const current = person.balances.find((b) => b.leave_type_id === typeId)
  const n = Number(amount)
  const change = direction === 'add' ? n : -n
  const wellFormed = amount !== '' && n > 0 && Number.isInteger(n * 2) && n <= 365
  // Days already applied for are spoken for; the server refuses to take them.
  const maxTake = current ? Math.max(0, current.balance - current.pending) : 0
  const tooMany = wellFormed && direction === 'take' && n > maxTake
  const valid = wellFormed && !tooMany && note.trim().length >= 3
  const typeName = types.find((t) => t.id === typeId)?.name ?? ''

  async function save(e) {
    e.preventDefault()
    if (!valid) return
    const ok = await adjust.mutateAsync({ employeeId: person.employee_id, leaveTypeId: typeId, leaveYear, days: change, note: note.trim() }).then(() => true, () => false)
    if (ok) {
      toast.success(`${person.full_name}: ${direction === 'add' ? 'added' : 'took away'} ${days(n)} of ${typeName}`)
      onClose()
    }
  }

  return (
    <Dialog title={`Correct ${person.full_name}’s leave — ${label}`} onClose={adjust.isPending ? () => {} : onClose}>
      <form onSubmit={save} className="space-y-4">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Leave type</span>
          <select value={typeId} onChange={(e) => setTypeId(e.target.value)} className={inputCls}>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </label>
        {current && (
          <p className="text-xs text-gray-500">
            Now: {days(current.balance)}{current.pending > 0 ? `, of which ${current.pending} applied for` : ''}.
            {wellFormed && !tooMany && ` After this: ${days(current.balance + change)}.`}
          </p>
        )}
        {tooMany && (
          <p className="text-xs text-red-600">
            At most {days(maxTake)} can be taken away{current?.pending > 0 ? ' — the rest are applied for' : ''}.
          </p>
        )}
        <fieldset className="flex gap-4 text-sm">
          <legend className="sr-only">Add or take away</legend>
          <label className="flex items-center gap-1.5"><input type="radio" name="direction" checked={direction === 'add'} onChange={() => setDirection('add')} /> Add days</label>
          <label className="flex items-center gap-1.5"><input type="radio" name="direction" checked={direction === 'take'} onChange={() => setDirection('take')} /> Take days away</label>
        </fieldset>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Days</span>
          <input type="number" min="0.5" max="365" step="0.5" value={amount} onChange={(e) => setAmount(e.target.value)} className={inputCls} placeholder="1 or 1.5" />
          {amount !== '' && !Number.isInteger(n * 2) && <span className="text-xs text-red-600">Use whole or half days.</span>}
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-gray-700">Why</span>
          <input type="text" value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} className={inputCls}
            placeholder="Worked on a holiday; granted twice by mistake…" />
          <span className="text-xs text-gray-400">{person.full_name} sees this in their notice.</span>
        </label>
        {person.date_of_joining && <p className="text-xs text-gray-400">Joined {formatDay(person.date_of_joining)}.</p>}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <button type="button" onClick={onClose} disabled={adjust.isPending}
            className="px-4 py-2 text-sm font-medium text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-60">Cancel</button>
          <button type="submit" disabled={!valid || adjust.isPending}
            className="px-4 py-2 text-sm font-medium text-white bg-blue-600 rounded-lg hover:bg-blue-700 disabled:opacity-60">
            {adjust.isPending ? 'Saving…' : 'Save correction'}
          </button>
        </div>
      </form>
    </Dialog>
  )
}
