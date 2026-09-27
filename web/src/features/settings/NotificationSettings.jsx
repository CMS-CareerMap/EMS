import { Bell, Info } from 'lucide-react'
import { Section } from './ui'

/**
 * The Notifications tab — honest about what exists.
 *
 * The version this replaces drew an Email and an In-App switch for eleven
 * events and a Save button. Nothing stored the switches, nothing sent an email
 * and nothing raised an in-app notice, so every setting on it was a promise the
 * system did not keep. Notifications are built on Day 19: a real table, sent to
 * people chosen by role, shown in the bell. Their settings belong with them.
 *
 * Until then this says what will be sent and to whom — nothing to save, so
 * nothing that looks saved and is not.
 */

const PLANNED = [
  {
    title: 'Leave',
    items: [
      { event: 'A leave request is submitted', to: 'Whoever approves it — the reporting manager, or HR' },
      { event: 'A request is approved or rejected', to: 'The employee who asked' },
      { event: 'A request is withdrawn', to: 'Whoever was asked to approve it' },
    ],
  },
  {
    title: 'Payroll',
    items: [
      { event: 'A payslip is ready', to: 'The employee it belongs to' },
    ],
  },
  {
    title: 'Documents',
    items: [
      { event: 'A document is uploaded for verification', to: 'HR' },
      { event: 'A document is verified', to: 'The employee who uploaded it' },
    ],
  },
]

export default function NotificationSettings() {
  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3 p-4 rounded-xl bg-amber-50 border border-amber-200">
        <Info className="w-4 h-4 text-amber-600 mt-0.5 shrink-0" />
        <div className="text-sm text-amber-900 space-y-1">
          <p className="font-semibold">Notifications are not being sent yet.</p>
          <p>
            They arrive with the notifications module, in the bell at the top of every page. This tab will then say who is told about what,
            and what can be turned off. Nothing here can be changed until something is actually sent — a switch that controls nothing would only look like a setting.
          </p>
          <p>
            No email is sent by this system. Invitation and password links are shown to the person who creates them, to hand over directly.
          </p>
        </div>
      </div>

      {PLANNED.map((group) => (
        <Section key={group.title} title={group.title}>
          <div className="divide-y divide-gray-100">
            {group.items.map((item) => (
              <div key={item.event} className="flex items-start gap-3 py-3">
                <Bell className="w-4 h-4 text-gray-300 mt-0.5 shrink-0" />
                <div className="flex-1">
                  <p className="text-sm font-medium text-gray-800">{item.event}</p>
                  <p className="text-xs text-gray-500 mt-0.5">Tells: {item.to}</p>
                </div>
                <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-gray-100 text-gray-500 shrink-0">Planned</span>
              </div>
            ))}
          </div>
        </Section>
      ))}
    </div>
  )
}
