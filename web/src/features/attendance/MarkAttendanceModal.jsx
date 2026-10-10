import { btn } from '../../components/ui/styles'
import { useState, useEffect } from 'react'
import { X, MapPin, Navigation, AlertTriangle, CheckCircle2, LocateFixed, Loader2, ShieldAlert, ShieldCheck } from 'lucide-react'
import { EscapeCloses } from '../../hooks/useEscape'
import { Avatar } from '../../components/ui/bits'

/**
 * What HR may record by hand. Late and WFH were here and are not statuses the
 * server has — choosing either was a guaranteed refusal. Working from home is
 * a request (Requests → Work from home); lateness is read from the check-in time.
 *
 * On-leave is deliberately absent too: leave marked here would never touch the
 * leave ledger, and the balance would stop matching the calendar.
 */
const STATUS_OPTIONS = [
  { value: 'present', label: 'Present', color: 'text-green-600' },
  { value: 'half_day', label: 'Half Day', color: 'text-purple-600' },
  { value: 'absent', label: 'Absent', color: 'text-red-600' },
]

export default function MarkAttendanceModal({ open, onClose, employee, onSave }) {
  // Who may open this modal at all is decided by the server: the save goes
  // through attendance:mark, which only super_admin and HR hold. The role list
  // that used to live here was a second copy of that rule, and a stale one —
  // it still named "finance", which is not a role in this system.

  const [status, setStatus] = useState('present')
  const [checkIn, setCheckIn] = useState('')
  const [checkOut, setCheckOut] = useState('')
  const [note, setNote] = useState('')

  // Geofence GPS location states


  const empId = employee?.id
  const empStatus = employee?.status
  const empCheckIn = employee?.check_in
  const empCheckOut = employee?.check_out
  const empNote = employee?.note

  useEffect(() => {
    if (open && empId) {
      const timer = setTimeout(() => {
        setStatus(empStatus ?? 'present')
        setCheckIn(empCheckIn ?? (new Date().toTimeString().slice(0, 5)))
        setCheckOut(empCheckOut ?? '')
        setNote(empNote ?? '')
      }, 0)
      return () => clearTimeout(timer)
    }
  }, [open, empId, empStatus, empCheckIn, empCheckOut, empNote])

  if (!open || !employee) return null



  function handleSubmit(e) {
    e.preventDefault()


    onSave({
      ...employee,
      status,
      check_in: checkIn,
      check_out: checkOut,
      note,
      // No coordinates. HR is not where the employee was, and writing HR's
      // location into the employee's row would be a plausible-looking lie in
      // the one place somebody would later go looking for the truth.
      source: 'manual',
    })
    onClose()
  }

  return (
    // Scrolls when taller than a phone's screen, rather than cutting off its buttons.
    <div className="fixed inset-0 z-50 flex items-start sm:items-center justify-center bg-gray-950/45 backdrop-blur-[2px] p-3 sm:p-4 overflow-y-auto"
      role="dialog" aria-modal="true" aria-label={`Attendance — ${employee.full_name}`}>
      <EscapeCloses onClose={onClose} />
      <div className="bg-white rounded-2xl shadow-[0_30px_70px_-20px_rgba(26,16,41,0.5)] w-full max-w-md overflow-hidden my-4">

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <Avatar name={employee.full_name} />
            <div>
              <p className="text-sm font-bold text-gray-900">{employee.full_name}</p>
              <p className="text-xs text-gray-500">{employee.department}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-5">

          {/* Status Selection */}
          <div className="space-y-2">
            <label className="text-sm font-medium text-gray-600">Attendance Status</label>
            <div className="grid grid-cols-3 gap-2">
              {STATUS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setStatus(opt.value)}
                  className={`px-3 py-2.5 rounded-lg border text-sm font-medium transition-all
                    ${status === opt.value
                      ? 'border-brand-500 bg-brand-50 text-brand-700 ring-1 ring-brand-500'
                      : 'border-gray-200 text-gray-600 hover:border-gray-300 hover:bg-gray-50'
                    }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Geofence Distance Verification Widget */}
          {/*
            The geofence used to live here, and it did not work.

            It read the office from localStorage, it recorded HR's OWN
            coordinates as the employee's check-in location, and it had a
            "Simulate GPS inside office" button next to it.

            It also asked the wrong question. This modal is HR recording
            somebody ELSE's day — where HR is standing says nothing about
            where that employee was. The geofence belongs on the employee's
            own punch, which is now checked on the server.

            Rows saved here are source = manual, which is the truth: a person
            entered them.
          */}

          {/* Times — only when not absent */}
          {status !== 'absent' && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-600">Check-in Time</label>
                <input type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm
                    focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-gray-900" />
              </div>
              <div className="space-y-1.5">
                <label className="text-sm font-medium text-gray-600">Check-out Time</label>
                <input type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm
                    focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent text-gray-900" />
              </div>
            </div>
          )}

          {/* Note */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-gray-600">Note <span className="text-gray-400 font-normal">(optional)</span></label>
            <textarea
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="e.g. Doctor appointment, client visit…"
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm resize-none
                focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent
                placeholder:text-gray-400 text-gray-900"
            />
          </div>

          {/* Actions */}
          <div className="flex flex-wrap justify-end gap-3 pt-1 border-t border-gray-100">
            <button type="button" onClick={onClose}
              className={btn.secondary}>
              Cancel
            </button>
            <button
              type="submit"
              className={btn.primary}
            >
              Save Attendance
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
