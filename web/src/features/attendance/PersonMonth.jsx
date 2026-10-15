import { useState } from 'react'
import { UserX } from 'lucide-react'
import { useAuthStore } from '../../stores/authStore'
import DataState from '../../components/DataState'
import Tabs, { TabPanel } from '../../components/ui/Tabs'
import { Card, EmptyState } from '../../components/ui/bits'
import { openOf, payDayMaps, serverSkew } from '../../lib/attendance'
import MonthNav from './MonthNav'
import MonthCalendar from './MonthCalendar'
import MonthFigures from './MonthFigures'
import DayLog from './DayLog'
import PunchEvidenceDialog from './PunchEvidence'

/**
 * Somebody's month of attendance (client, 15 Oct 2026): the month so far, in
 * figures counted to today; their calendar, as they see it themselves; and
 * their days, a line a day. On the page a name on Attendance opens, and on
 * their profile's Attendance tab — for whoever's attendance reach takes them
 * in. Outside it the server answers 404, said here in plain words.
 *
 * `query`: usePersonMonth.
 */
export default function PersonMonth({ query, monthKey, onMonth, today }) {
  const [year, month] = monthKey.split('-').map(Number)
  const myId = useAuthStore((state) => state.profile?.id ?? null)
  const superAdmin = useAuthStore((state) => state.can('role:manage'))
  const [sub, setSub] = useState('calendar')
  const [evidenceOn, setEvidenceOn] = useState(null)

  // Not one whose attendance the caller sees: a fact about their reach, not a fault.
  if (query.error?.status === 404) {
    return (
      <Card>
        <EmptyState icon={UserX} title="Not yours to see">
          {query.error.message}
        </EmptyState>
      </Card>
    )
  }

  const d = query.data
  const { leaveOn, absentOn } = payDayMaps(d?.pay_days)
  const joinedOn = d?.person?.date_of_joining ?? null
  const leftOn = d?.person?.employed_until ?? null
  const day = d?.today ?? today
  // A day's punches, with the photos — never one's own, but for the Super Admin (the server's rule, Suspicious's).
  const seesEvidence = d && (superAdmin || d.person.id !== myId)
  const tabs = [
    { key: 'calendar', label: 'Calendar' },
    { key: 'log', label: 'Day by day' },
  ]

  return (
    <div className="space-y-4 sm:space-y-5">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 sm:gap-5 items-start">
        <div className="lg:col-span-1">
          <MonthFigures query={query} year={year} month={month} title="Month so far" />
        </div>
        <Card className="lg:col-span-2" bodyClassName="" title="Attendance" subtitle="Their days, holidays and weekly offs"
          action={<MonthNav value={monthKey} onChange={onMonth} />}>
          <div className="px-4 mt-1 border-b border-gray-100">
            <Tabs items={tabs} value={sub} onChange={setSub} label="Their month" panelId="person-month-panel" />
          </div>
          <TabPanel id="person-month-panel" tab={sub}>
            {sub === 'calendar' && (
              <div className="p-4">
                <MonthCalendar year={year} month={month} today={day} rows={d?.days ?? []} rowsQuery={query} calendarQuery={query} joinedOn={joinedOn}
                  leftOn={leftOn} openDay={d?.totals?.open_day ?? null} leaveOn={leaveOn} absentOn={absentOn} />
              </div>
            )}
            {sub === 'log' && (
              <DataState query={query} compact loading="Loading their days…">
                {(data) => (
                  <DayLog year={year} month={month} today={day} days={data.days} daysOff={data.days_off} leaveOn={leaveOn} absentOn={absentOn}
                    joinedOn={joinedOn} leftOn={leftOn} open={openOf(data)} skewMs={serverSkew(data)} label={`${data.person.full_name}’s days`} onEvidence={seesEvidence ? setEvidenceOn : null} />
                )}
              </DataState>
            )}
          </TabPanel>
        </Card>
      </div>
      {evidenceOn && d && (
        <PunchEvidenceDialog person={{ id: d.person.id, full_name: d.person.full_name }} date={evidenceOn} onClose={() => setEvidenceOn(null)} />
      )}
    </div>
  )
}
