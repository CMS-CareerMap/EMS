import { useMonthlyHours } from '../../hooks/useAttendance'
import DataState from '../../components/DataState'
import { Avatar, Card } from '../../components/ui/bits'
import { formatHours, monthLabel } from '../../lib/attendance'

/**
 * Hours worked in the month, per person — the figure the client asked for
 * ("jitne ghante usne work kiya vo dikhe"), summed by the server from the stored
 * hours (Day 12), so it agrees with every day's row and with the payslip. The
 * people are whoever the caller's attendance reaches: themselves, their team,
 * or the company.
 */
export default function MonthTotals({ year, month }) {
  const totals = useMonthlyHours(year, month)
  const label = monthLabel(year, month)
  const head = 'px-4 py-2.5 text-right text-[11px] font-bold text-gray-500 uppercase tracking-wider whitespace-nowrap'
  const cell = 'px-4 py-2.5 text-right tabular-nums'

  return (
    <Card title={`Hours worked · ${label}`} subtitle="Expected is the shift’s hours for the days worked, half days counted as half." bodyClassName="pt-3">
      <DataState query={totals} compact isEmpty={(data) => !data.employees?.length}
        empty={<p className="px-4 pb-6 text-sm text-gray-400">No hours recorded this month yet.</p>}>
        {(data) => (
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-140" aria-label={`Hours worked in ${label}`}>
              <thead className="bg-gray-50 border-y border-gray-200">
                <tr>
                  <th className={`${head} text-left! pl-4`}>Employee</th>
                  <th className={head}>Hours</th>
                  <th className={head}>Expected</th>
                  <th className={head}>Present</th>
                  <th className={head}>Half</th>
                  <th className={head}>Absent</th>
                  <th className={head}>Leave</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.employees.map((e) => (
                  <tr key={e.employee_uuid}>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={e.full_name} size="sm" />
                        <div className="min-w-0">
                          <p className="font-semibold text-gray-900 whitespace-nowrap">{e.full_name}</p>
                          <p className="text-xs text-gray-400 font-mono">{e.employee_id}</p>
                        </div>
                      </div>
                    </td>
                    <td className={`${cell} font-bold text-gray-900 whitespace-nowrap`}>{formatHours(e.total_hours)}</td>
                    <td className={`${cell} text-gray-600 whitespace-nowrap`}>{formatHours(e.expected_hours)}</td>
                    <td className={`${cell} text-gray-700`}>{e.days_present}</td>
                    <td className={`${cell} text-gray-700`}>{e.days_half}</td>
                    <td className={`${cell} text-gray-700`}>{e.days_absent}</td>
                    <td className={`${cell} text-gray-700`}>{e.days_on_leave}</td>
                  </tr>
                ))}
              </tbody>
              {data.employees.length > 1 && (
                <tfoot className="border-t border-gray-200 bg-gray-50">
                  <tr>
                    <td className="px-4 py-2.5 text-[11px] font-bold text-gray-500 uppercase tracking-wider">Total</td>
                    <td className={`${cell} font-bold text-gray-900 whitespace-nowrap`}>{formatHours(data.grand_total_hours)}</td>
                    <td colSpan={5} />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        )}
      </DataState>
    </Card>
  )
}
