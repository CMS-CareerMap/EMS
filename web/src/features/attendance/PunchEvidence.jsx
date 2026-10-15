import { useState } from 'react'
import { MapPin, ShieldAlert, ImageOff, Loader2 } from 'lucide-react'
import Dialog from '../../components/Dialog'
import DataState from '../../components/DataState'
import { useDayEvidence, usePunchPhoto } from '../../hooks/useAttendance'
import { useAuthStore } from '../../stores/authStore'
import { formatDay, wallClockIn } from '../../lib/dates'
import { PUNCH_FLAG_WORDS, mapLink, refusalWords, shortDevice } from '../../lib/attendance'
import { WORK_MODES } from '../../lib/requests'

/**
 * One person's punches on one day, with everything that decided each
 * (client, 11 Oct 2026): accepted or refused, how far from the office and how
 * precisely, from which phone and address, any flags — and the selfie, while
 * it is kept. Opened from the roster by whoever looks after the person's
 * attendance.
 */
export default function PunchEvidenceDialog({ person, date, onClose }) {
  const evidence = useDayEvidence(person.id, date)
  return (
    <Dialog title={`${person.full_name} — ${formatDay(date, { weekday: true })}`} onClose={onClose}>
      <DataState query={evidence} compact loading="Loading the punches…">
        {(punches) => (punches.length === 0 ? (
          <p className="text-sm text-gray-500">No app punch that day — the day came from the machine or from HR.</p>
        ) : (
          <ul className="space-y-3" aria-label="Punches">
            {punches.map((p) => <Punch key={p.id} punch={p} />)}
          </ul>
        ))}
      </DataState>
    </Dialog>
  )
}

function Punch({ punch: p }) {
  const timezone = useAuthStore((state) => state.organization?.timezone)
  const refused = refusalWords(p)
  const [large, setLarge] = useState(false)
  return (
    <li className={`border border-gray-100 rounded-xl p-3 flex gap-3 ${large ? 'flex-col' : ''}`}>
      {p.has_photo ? <Photo id={p.id} large={large} onToggle={() => setLarge((on) => !on)} /> : (
        <div className="w-20 h-24 shrink-0 rounded-lg bg-gray-50 border border-gray-100 flex items-center justify-center" aria-hidden="true">
          <ImageOff className="w-5 h-5 text-gray-300" />
        </div>
      )}
      <div className="min-w-0 text-sm space-y-1">
        <p className="text-gray-900">
          <b>{p.action === 'in' ? 'Check-in' : 'Check-out'}</b> at {wallClockIn(timezone, p.at)}
          {refused ? <span className="text-red-700"> — {refused}</span> : <span className="text-emerald-700"> — accepted</span>}
        </p>
        <p className="flex items-start gap-1.5 text-xs text-gray-600">
          <MapPin className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />
          <span className="min-w-0">
            {p.fence_applied && p.distance_meters != null
              ? `${p.distance_meters} m from the office, accurate to ${p.accuracy_meters} m`
              // A location kept, not fenced (Location + Selfie, any site): where it was, for the map (14 Oct 2026).
              : p.latitude != null && p.longitude != null
                ? `Taken at ${p.latitude.toFixed(5)}, ${p.longitude.toFixed(5)}${p.accuracy_meters != null ? `, accurate to ${p.accuracy_meters} m` : ''}`
                : p.work_mode && p.work_mode !== 'office' ? `${WORK_MODES[p.work_mode] ?? p.work_mode} — the office is not checked` : 'No location'}
            {p.readings > 0 ? ` · ${p.readings} reading${p.readings === 1 ? '' : 's'}` : ''}
            {p.latitude != null && p.longitude != null && (
              <>
                {' · '}
                <a href={mapLink(p.latitude, p.longitude)} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-700 underline">Open map</a>
              </>
            )}
          </span>
        </p>
        {p.flags.map((f) => (
          <p key={f} className="flex items-start gap-1.5 text-xs text-amber-800">
            <ShieldAlert className="w-3.5 h-3.5 shrink-0 mt-px" aria-hidden="true" />{PUNCH_FLAG_WORDS[f] ?? f}
          </p>
        ))}
        <p className="text-[11px] text-gray-400 wrap-break-word">{[shortDevice(p.device), p.ip && `from ${p.ip}`].filter(Boolean).join(' · ')}</p>
      </div>
    </li>
  )
}

/** The selfie, small; pressed, as large as the dialog allows — the room behind somebody is what is looked at. */
function Photo({ id, large, onToggle }) {
  const photo = usePunchPhoto(id)
  if (photo.isError) {
    return <div className="w-20 h-24 shrink-0 rounded-lg bg-gray-50 border border-gray-100 text-[10px] text-gray-400 p-1 flex items-center text-center">Photo could not be loaded</div>
  }
  if (!photo.data) {
    return <div className="w-20 h-24 shrink-0 rounded-lg bg-gray-50 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-gray-400" /></div>
  }
  return (
    <div className={`shrink-0 space-y-1 ${large ? 'w-full' : 'w-20'}`}>
      <img src={photo.data} alt="Selfie taken with the punch" className={`rounded-lg border border-gray-100 ${large ? 'w-full h-auto' : 'w-20 h-24 object-cover'}`} />
      <button type="button" onClick={onToggle} aria-expanded={large} className="text-xs font-semibold text-brand-600 hover:underline px-1 py-0.5 -ml-1">
        {large ? 'Smaller' : 'Larger'}
      </button>
    </div>
  )
}
