import { useSearchParams } from 'react-router-dom'
import { useAuthStore } from '../stores/authStore'
import PageHeader from '../components/ui/PageHeader'
import { TabPanel } from '../components/ui/Tabs'
import RunsTab from '../features/payroll/RunsTab'
import SalaryStructures from '../features/payroll/SalaryStructures'
import MonthlyEntries from '../features/payroll/MonthlyEntries'
import TdsDirectives from '../features/payroll/TdsDirectives'
import BankAccounts from '../features/payroll/BankAccounts'
import BankFileFormat from '../features/payroll/BankFileFormat'
import ComponentsTab from '../features/payroll/ComponentsTab'
import LoansTab from '../features/payroll/LoansTab'

/**
 * Payroll.
 *
 * Every figure here is the server's — the page this replaced worked salaries
 * out in the browser and wrote them back as if they were a payroll. A tab is
 * drawn only for somebody allowed to use it: HR sees the Incentive screen and
 * nothing of anybody's pay.
 */

const TABS = [
  { id: 'runs', label: 'Payroll runs', permission: 'payroll:structure:read', Component: RunsTab },
  { id: 'salary', label: 'Salary structure', permission: 'payroll:structure:read', Component: SalaryStructures },
  { id: 'incentives', label: 'Incentives', permission: 'payroll:entry:manage', Component: MonthlyEntries },
  { id: 'tds', label: 'Income tax (TDS)', permission: 'payroll:structure:read', Component: TdsDirectives },
  { id: 'loans', label: 'Loans & advances', permission: 'payroll:structure:read', Component: LoansTab },
  { id: 'components', label: 'Components', permission: 'payroll:structure:read', Component: ComponentsTab },
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
    <>
      <PageHeader
        title="Payroll"
        subtitle={tabs.length === 1 && current.id === 'incentives'
          ? 'Amounts entered each month, paid with that month’s salary'
          : 'Salaries, monthly runs, payslips and the bank transfer file'}
        tabs={tabs.map((t) => ({ key: t.id, label: t.label }))}
        tab={current.id}
        onTab={(id) => setParams({ tab: id }, { replace: true })}
        panelId="payroll-panel"
      />
      <TabPanel id="payroll-panel" tab={tabs.length > 1 ? current.id : null}>
        <current.Component />
      </TabPanel>
    </>
  )
}
