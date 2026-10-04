import { Bell, Info, Lock, Mail } from 'lucide-react'
import { toast } from 'sonner'
import { Section, Toggle } from './ui'
import { useAuthStore } from '../../stores/authStore'
import { useEmailStatus, useNotificationSettings, useSaveNotificationSettings } from '../../hooks/useNotifications'
import DataState from '../../components/DataState'

/**
 * The Notifications tab: every notice the system sends, whom it tells, a
 * switch for each one the company may turn off — and whether it is also
 * emailed (client §45), once the server has a mail account to send from.
 *
 * The list comes from the server's own catalogue — the same list the code
 * sends from — so this screen cannot promise a notice that is never sent. A
 * security notice (a password change) is always sent and has no switch.
 */
export default function NotificationSettings() {
  const canEdit = useAuthStore((s) => s.can('settings:update'))
  const settings = useNotificationSettings()
  const save = useSaveNotificationSettings()
  const email = useEmailStatus()
  const ready = email.data?.ready === true

  async function flip(event, enabled) {
    const ok = await save.mutateAsync([{ event: event.event, enabled }]).then(() => true, () => false)
    if (ok) toast.success(`${event.label}: ${enabled ? 'will be sent' : 'no longer sent'}`)
  }

  async function flipEmail(event, on) {
    const ok = await save.mutateAsync([{ event: event.event, enabled: event.enabled, email: on }]).then(() => true, () => false)
    if (ok) toast.success(`${event.label}: ${on ? 'emailed too' : 'in the app only'}`)
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 rounded-xl bg-blue-50 border border-blue-200">
        <Info className="w-4 h-4 text-blue-600 mt-0.5 shrink-0" />
        <div className="text-sm text-blue-900 space-y-1">
          <p>Notices appear in the bell at the top of every page, for the people listed against each one. Nobody can send one from a browser — the system writes them as things happen.</p>
          {email.isSuccess && (ready ? (
            <p>Each is also emailed, from <span className="font-semibold">{email.data.from}</span>, to the sign-in email of whoever it tells — unless its email switch is off.</p>
          ) : (
            <p>Email is not set up yet, so notices stay in the app. Once the server is given a mail account (SMTP), each notice whose email switch is on is also emailed.</p>
          ))}
        </div>
      </div>

      <DataState query={settings} empty="This system sends no notices yet.">
        {(events) => [...new Set(events.map((e) => e.group))].map((group) => (
        <Section key={group} title={group}>
          <div className="divide-y divide-gray-100">
            {events.filter((e) => e.group === group).map((e) => (
              <div key={e.event} className="flex items-start gap-3 py-3">
                <Bell className="w-4 h-4 text-gray-300 mt-0.5 shrink-0" />
                {/* On a phone the switches sit under the words, not beside them. */}
                <div className="flex-1 min-w-0 flex flex-col sm:flex-row sm:items-start gap-2 sm:gap-4">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800">{e.label}</p>
                  <p className="text-xs text-gray-500 mt-0.5">Tells: {e.tells}</p>
                </div>
                <div className="flex items-center gap-4 shrink-0">
                  <label className="flex items-center gap-1.5 text-xs text-gray-500" title={ready ? 'Also by email' : 'Email is not set up yet'}>
                    <Mail className="w-3.5 h-3.5" /> Email
                    <Toggle checked={e.email && e.enabled} onChange={(v) => flipEmail(e, v)} disabled={!canEdit || save.isPending || !e.enabled} label={`Email — ${e.label} — ${e.email ? 'on' : 'off'}`} />
                  </label>
                  {e.optional ? (
                    <span className="flex items-center gap-1.5 text-xs text-gray-500">In app
                    <Toggle checked={e.enabled} onChange={(v) => flip(e, v)} disabled={!canEdit || save.isPending} label={`${e.label} — ${e.enabled ? 'on' : 'off'}`} />
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500">
                      <Lock className="w-3 h-3" /> Always sent
                    </span>
                  )}
                </div>
                </div>
              </div>
            ))}
          </div>
        </Section>
        ))}
      </DataState>
    </div>
  )
}
