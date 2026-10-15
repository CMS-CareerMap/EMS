import { useState } from 'react'
import { toast } from 'sonner'
import { Smartphone } from 'lucide-react'
import { useDecideDevice, useDevices } from '../../hooks/useAttendance'
import { useAuthStore } from '../../stores/authStore'
import DataState from '../../components/DataState'
import ConfirmDialog from '../../components/ConfirmDialog'
import { Card, Chip } from '../../components/ui/bits'
import { btn } from '../../components/ui/styles'
import { formatDayOf, wallClockIn } from '../../lib/dates'

/**
 * The phone somebody punches from (client, 14 Oct 2026: one phone per
 * employee), on their page — for whoever holds "replace or reset a punch
 * phone", Admin included, who has no Attendance pages.
 *
 *   - Replace: a phone that waited becomes theirs, and the old one is taken
 *     off in the same step — never neither.
 *   - Reset: their phone is taken off; the next new phone they check in from
 *     becomes theirs, as the first one did.
 *   - Refuse: a phone that waited stays refused.
 *
 * Their own phone, a fellow phone-keeper's or a senior's goes up the tree: the
 * server says who may, and the buttons are not offered.
 */
const MAX_PAST = 5

export default function PunchPhones({ employee }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const phones = useDevices('all', { employeeId: employee.id })
  const decide = useDecideDevice()
  const [asking, setAsking] = useState(null)
  const when = (instant) => `${formatDayOf(instant, timezone)}, ${wallClockIn(timezone, instant)}`

  return (
    <Card title="Punch phone" subtitle="One phone per employee: the phone this person checks in and out from">
      <DataState query={phones} loading="Loading their phone…">
        {({ one_device: checked, phones: rows }) => {
          const current = rows.find((p) => p.status === 'approved') ?? null
          const waiting = rows.filter((p) => p.status === 'waiting')
          const past = rows.filter((p) => p.status === 'retired').slice(0, MAX_PAST)
          const stop = rows.find((p) => !p.may_decide)
          // Off, nothing is checked: no phone is registered, refused or reset — said, and nothing offered.
          const acts = checked
          return (
            <div className="space-y-3">
              {!checked && (
                <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  One phone per employee is off: {employee.full_name} can check in from any phone. The Super Admin turns it on in Settings → Attendance Security.
                </p>
              )}
              {checked && stop && (
                <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
                  {employee.full_name}’s punch phone is replaced or reset by {stop.ask}.
                </p>
              )}
              {checked && current && waiting.length > 0 && current.may_decide && (
                <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                  A new phone has already tried: replace their phone with it below — or refuse it — rather than reset.
                </p>
              )}
              <ul className="rounded-xl border border-gray-200 divide-y divide-gray-100" aria-label="Punch phones">
                {current ? (
                  <li className="px-3 py-2.5 flex flex-wrap items-center gap-3">
                    <Smartphone className="w-4 h-4 text-emerald-600 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-900"><b>{current.label ?? 'A phone'}</b> <Chip tone="ok">Their phone</Chip></p>
                      <p className="text-xs text-gray-500">Since {when(current.first_seen_at)} · last used {when(current.last_seen_at)}</p>
                    </div>
                    {/* A reset lets only a phone never used before in: with one waiting, it is replaced with or refused first. */}
                    {acts && current.may_decide && waiting.length === 0 && (
                      <button type="button" disabled={decide.isPending} className={btn.secondary} onClick={() => setAsking({ kind: 'reset', device: current })}>
                        Reset
                      </button>
                    )}
                  </li>
                ) : (
                  <li className="px-3 py-2.5 text-sm text-gray-600">
                    {checked
                      ? `No phone yet — the first phone ${employee.full_name} checks in from becomes theirs, by itself.`
                      : 'No phone registered.'}
                  </li>
                )}
                {waiting.map((d) => (
                  <li key={d.id} className="px-3 py-2.5 flex flex-wrap items-center gap-3">
                    <Smartphone className="w-4 h-4 text-amber-600 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-gray-900"><b>{d.label ?? 'A phone'}</b> <Chip tone="warn">Waiting</Chip></p>
                      <p className="text-xs text-gray-500">Tried {when(d.last_seen_at)} — refused until it is made theirs</p>
                    </div>
                    {acts && d.may_decide && (
                      <div className="flex flex-wrap gap-2">
                        <button type="button" disabled={decide.isPending} className={btn.primary} onClick={() => setAsking({ kind: 'replace', device: d })}>
                          Replace with this phone
                        </button>
                        <button type="button" disabled={decide.isPending} className={btn.secondary} onClick={() => setAsking({ kind: 'refuse', device: d })}>
                          Refuse
                        </button>
                      </div>
                    )}
                  </li>
                ))}
                {past.map((d) => (
                  <li key={d.id} className="px-3 py-2 flex items-center gap-3 text-xs text-gray-500">
                    <Smartphone className="w-3.5 h-3.5 text-gray-400 shrink-0" aria-hidden="true" />
                    <span className="min-w-0 flex-1">{d.label ?? 'A phone'} — taken off{d.decided_at ? ` ${when(d.decided_at)}` : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )
        }}
      </DataState>
      {asking && (
        <ConfirmDialog
          title={asking.kind === 'replace' ? `Replace ${employee.full_name}’s phone?` : asking.kind === 'reset' ? `Reset ${employee.full_name}’s phone?` : `Refuse this phone for ${employee.full_name}?`}
          confirmLabel={asking.kind === 'replace' ? 'Replace' : asking.kind === 'reset' ? 'Reset' : 'Refuse'}
          danger={asking.kind !== 'replace'}
          onConfirm={() => decide.mutateAsync({ id: asking.device.id, approve: asking.kind === 'replace' }).then(() => toast.success(
            asking.kind === 'replace' ? `${asking.device.label ?? 'The new phone'} is now ${employee.full_name}’s phone`
              : asking.kind === 'reset' ? `Reset — the next new phone ${employee.full_name} checks in from becomes theirs`
                : 'Refused — punches from it stay refused',
          ))}
          onClose={() => setAsking(null)}
        >
          {asking.kind === 'replace' && <p>{asking.device.label ?? 'This phone'} becomes the phone {employee.full_name} checks in and out from, and their old phone is taken off — both at once. Do it only once you know the phone is theirs.</p>}
          {asking.kind === 'reset' && <p>{asking.device.label ?? 'Their phone'} is taken off. The next new phone {employee.full_name} checks in from becomes theirs by itself — use this when their new phone has not punched yet, or the old one is lost.</p>}
          {asking.kind === 'refuse' && <p>Punches from {asking.device.label ?? 'this phone'} stay refused. {employee.full_name} keeps the phone they have.</p>}
        </ConfirmDialog>
      )}
    </Card>
  )
}
