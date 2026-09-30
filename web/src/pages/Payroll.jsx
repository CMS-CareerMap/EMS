import { useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import RunsTab from '../features/payroll/RunsTab'
import SalaryStructures from '../features/payroll/SalaryStructures'
import MonthlyEntries from '../features/payroll/MonthlyEntries'
import TdsDirectives from '../features/payroll/TdsDirectives'
import BankAccounts from '../features/payroll/BankAccounts'
import BankFileFormat from '../features/payroll/BankFileFormat'

/**
 * Payroll.
 *
 * The page this replaces worked every figure out in the browser — salaries
 * estimated from CTC by fixed percentages, payslips "Generated" that nobody had
 * generated, a GSTIN and PF account number made up from the PAN — and wrote
 * the result to the old hosted database as if it were a payroll. Every figure here is now the
 * server's, and a tab is drawn only for somebody allowed to use it: HR sees
 * the Incentive screen and nothing of anybody's pay.
 */

const TABS = [
  { id: 'runs', label: 'Payroll runs', permission: 'payroll:structure:read', Component: RunsTab },
  { id: 'salary', label: 'Salary structure', permission: 'payroll:structure:read', Component: SalaryStructures },
  { id: 'incentives', label: 'Incentives', permission: 'payroll:entry:manage', Component: MonthlyEntries },
  { id: 'tds', label: 'Income tax (TDS)', permission: 'payroll:structure:read', Component: TdsDirectives },
  { id: 'bank', label: 'Bank accounts', permission: 'employee:bank:read', Component: BankAccounts },
  { id: 'bank-format', label: 'Bank file format', permission: 'payroll:structure:read', Component: BankFileFormat },
]

export default function Payroll() {
  const can = useAuthStore((s) => s.can)
  const tabs = TABS.filter((t) => can(t.permission))
  const [params, setParams] = useSearchParams()
  const current = tabs.find((t) => t.id === params.get('tab')) ?? tabs[0]

  if (!current) return null

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Payroll</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          {tabs.length === 1 && current.id === 'incentives'
            ? 'Amounts entered each month, paid with that month’s salary'
            : 'Salaries, monthly runs, payslips and the bank transfer file'}
        </p>
      </div>

      {tabs.length > 1 && (
        <div className="flex items-center gap-1 border-b border-gray-200 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => setParams({ tab: t.id }, { replace: true })}
              className={`shrink-0 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors -mb-px
                ${current.id === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}`}>
              {t.label}
            </button>
          ))}
        </div>
      )}

      <current.Component />
    </div>
  )
}
