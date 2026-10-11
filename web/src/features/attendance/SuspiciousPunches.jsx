import { useState } from 'react'
import { toast } from 'sonner'
import { ShieldAlert, MapPin, Fingerprint, Smartphone } from 'lucide-react'
import { useDecideDevice, useDevices, useSuspiciousPunches } from '../../hooks/useAttendance'
import { useAuthStore } from '../../stores/authStore'
import DataState from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import PunchEvidenceDialog from './PunchEvidence'
import { Avatar } from '../../components/ui/bits'
import { btn, card, field } from '../../components/ui/styles'
import { addDays, formatDay, formatDayOf, wallClockIn } from '../../lib/dates'
import { MACHINE_MATCH, PUNCH_FLAG_WORDS, refusalWords, shortDevice } from '../../lib/attendance'

/**
 * Suspicious punches (client, 11 Oct 2026), for whoever looks after other
 * people's attendance: everything worth a second look between two days, by
 * person and day — punches refused at the fence or from a computer, punches
 * with a sign they may not be what they seem, and app days the fingerprint
 * machine did not bear out. Evidence to look at, never a verdict: a web page
 * cannot tell a fake-location app from the phone's own GPS.
 */
export default function SuspiciousPunches({ today }) {
  const [from, setFrom] = useState(addDays(today, -6))
  const [to, setTo] = useState(today)
  const list = useSuspiciousPunches(from, to)
  // Whoever corrects attendance approves a new phone (one phone per employee).
  const decidesPhones = useAuthStore((state) => state.can('attendance:update'))
  // A day's punches with their evidence — a refused one's selfie included, which the roster cannot reach.
  const [evidence, setEvidence] = useState(null)
  return (
    <div className="space-y-4">
      {decidesPhones && <WaitingPhones />}
      <div className={`${card} px-4 py-3 flex flex-wrap items-end gap-3`}>
        <label className="text-xs font-semibold text-gray-500">
          From
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className={`${field} block mt-1`} aria-label="From" />
        </label>
        <label className="text-xs font-semibold text-gray-500">
          To
          <input type="date" value={to} min={from} max={today} onChange={(e) => e.target.value && setTo(e.target.value)} className={`${field} block mt-1`} aria-label="To" />
        </label>
        <p className="text-xs text-gray-500 flex-1 min-w-48">
          Signs, not verdicts: look at the evidence, and ask. A website cannot tell a fake-location app from a phone’s own GPS.
        </p>
      </div>
      <DataState query={list} loading="Looking through the punches…">
        {(data) => (data.days.length === 0 ? (
          <p className={`${card} px-4 py-10 text-center text-sm text-gray-500`}>Nothing to look at between {formatDay(data.from)} and {formatDay(data.to)}.</p>
        ) : (
          <ul className="space-y-3" aria-label="Suspicious punches">
            {data.days.map((day) => <Day key={`${day.employee_id}|${day.date}`} day={day} onEvidence={() => setEvidence(day)} />)}
          </ul>
        ))}
      </DataState>
      {evidence && (
        <PunchEvidenceDialog person={{ id: evidence.employee_id, full_name: evidence.full_name }} date={evidence.date} onClose={() => setEvidence(null)} />
      )}
    </div>
  )
}

/**
 * Phones waiting for approval (client, 11 Oct 2026: one phone per employee):
 * somebody punched from a phone that is not theirs. Approving it makes it
 * theirs and takes the old one off; taking it off keeps it refused.
 */
function WaitingPhones() {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const devices = useDevices('waiting')
  const decide = useDecideDevice()
  // Asked first: approving takes the person's other phone off; taking off keeps this one refused.
  const [asking, setAsking] = useState(null)
  if (!devices.data?.length) return null
  return (
    <section aria-label="Phones waiting for approval" className={`${card} p-4 space-y-3`}>
      <p className="text-sm font-semibold text-gray-900">Phones waiting for approval</p>
      <ul className="divide-y divide-gray-100">
        {devices.data.map((d) => (
          <li key={d.id} className="py-2.5 flex flex-wrap items-center gap-3">
            <Smartphone className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-gray-900"><b>{d.full_name}</b> <span className="font-mono text-xs text-gray-500">{d.employee_code}</span> — {d.label ?? 'a phone'}</p>
              <p className="text-xs text-gray-500">Tried {formatDayOf(d.last_seen_at, timezone)} at {wallClockIn(timezone, d.last_seen_at)}</p>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={decide.isPending} className={btn.primary} onClick={() => setAsking({ device: d, approve: true })}>
                Approve
              </button>
              <button type="button" disabled={decide.isPending} className={btn.secondary} onClick={() => setAsking({ device: d, approve: false })}>
                Take off
              </button>
            </div>
          </li>
        ))}
      </ul>
      {asking && (
        <ConfirmDialog
          title={asking.approve ? `Approve ${asking.device.full_name}’s new phone?` : `Take off ${asking.device.full_name}’s phone?`}
          confirmLabel={asking.approve ? 'Approve' : 'Take off'}
          danger={!asking.approve}
          onConfirm={() => decide.mutateAsync({ id: asking.device.id, approve: asking.approve }).then(() => toast.success(asking.approve ? `${asking.device.full_name}’s new phone is approved` : 'Taken off — punches from it stay refused'))}
          onClose={() => setAsking(null)}
        >
          {asking.approve
            ? <p>{asking.device.label ?? 'This phone'} becomes the one {asking.device.full_name} checks in and out from. Their other phone is taken off. Approve it only once you know the phone is theirs.</p>
            : <p>Punches from {asking.device.label ?? 'this phone'} stay refused. {asking.device.full_name} keeps the phone they have.</p>}
        </ConfirmDialog>
      )}
    </section>
  )
}

function Day({ day, onEvidence }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const machine = day.machine ? MACHINE_MATCH[day.machine.match] : null
  return (
    <li className={`${card} p-4 space-y-3`}>
      <div className="flex items-center gap-3 min-w-0">
        <Avatar name={day.full_name} size="sm" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-gray-900 truncate">{day.full_name}</p>
          <p className="text-xs text-gray-500"><span className="font-mono">{day.employee_code}</span> · {formatDay(day.date, { weekday: true })}</p>
        </div>
        {day.punches.length > 0 && (
          <button type="button" onClick={onEvidence} className={btn.secondary} aria-label={`Evidence of ${day.full_name}’s punches on ${formatDay(day.date)}`}>
            Evidence
          </button>
        )}
      </div>
      {day.punches.map((p) => {
        const refused = refusalWords(p)
        const device = shortDevice(p.device)
        return (
          <div key={p.id} className="flex items-start gap-2">
            <MapPin className={`w-4 h-4 shrink-0 mt-0.5 ${refused ? 'text-red-600' : 'text-amber-600'}`} aria-hidden="true" />
            <div className="min-w-0 text-sm">
              <p className="text-gray-900">
                <b>{p.action === 'in' ? 'Check-in' : 'Check-out'}</b> at {wallClockIn(timezone, p.at)}
                {refused ? <span className="text-red-700"> — {refused}</span> : p.distance_meters != null ? <span className="text-gray-600"> — {p.distance_meters} m from the office</span> : null}
              </p>
              {p.flags.length > 0 && (
                <ul className="mt-1 space-y-0.5">
                  {p.flags.map((f) => (
                    <li key={f} className="flex items-start gap-1.5 text-xs text-amber-800">
                      <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />{PUNCH_FLAG_WORDS[f] ?? f}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-gray-400 mt-0.5 wrap-break-word">
                {[p.accuracy_meters != null && `accurate to ${p.accuracy_meters} m`, p.readings > 0 && `${p.readings} reading${p.readings === 1 ? '' : 's'}`, device, p.ip && `from ${p.ip}`].filter(Boolean).join(' · ')}
              </p>
            </div>
          </div>
        )
      })}
      {machine && (
        <div className="flex items-start gap-2">
          <Fingerprint className={`w-4 h-4 shrink-0 mt-0.5 ${day.machine.match === 'not_on_machine' ? 'text-red-600' : 'text-amber-600'}`} aria-hidden="true" />
          <p className="text-sm text-gray-900">
            {machine.said}
            <span className="block text-xs text-gray-500">
              App {wallClockIn(timezone, day.machine.check_in) || '—'}{day.machine.check_out ? ` – ${wallClockIn(timezone, day.machine.check_out)}` : ''}
              {day.machine.first_scan ? ` · machine ${wallClockIn(timezone, day.machine.first_scan)}${day.machine.last_scan ? ` – ${wallClockIn(timezone, day.machine.last_scan)}` : ''}` : ''}
              {day.machine.status === 'absent' ? ' · marked absent' : ''}
            </span>
          </p>
        </div>
      )}
    </li>
  )
}
