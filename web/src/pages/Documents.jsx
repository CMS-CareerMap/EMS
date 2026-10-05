import { useSearchParams } from 'react-router-dom'
import { FileText, FolderOpen, Users } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useChecklist, useDocumentTypes } from '../hooks/useDocuments'
import CompanyDocuments from '../features/documents/CompanyDocuments'
import EmployeeDocuments from '../features/documents/EmployeeDocuments'
import Checklist from '../features/documents/Checklist'
import DataState from '../components/DataState'
import PageHeader from '../components/ui/PageHeader'
import { TabPanel } from '../components/ui/Tabs'

/**
 * Documents.
 *
 *   Company documents  everybody — the handbook and policies (§5: "All")
 *   My documents       anybody with an employee record who files documents
 *   Employee documents HR and Admin — everybody's, to check and act on
 *
 * The page this replaces talked to the old backend from inside the component,
 * white-screened for an administrator with no employee record, and showed a
 * list of company documents that existed nowhere.
 */
export default function Documents() {
  const can = useAuthStore((s) => s.can)
  const hasEmployee = useAuthStore((s) => Boolean(s.profile))
  const [params, setParams] = useSearchParams()

  const reviews = can('document:verify')
  const tabs = [
    { id: 'company', label: 'Company documents', icon: FileText, show: can('document:company:read') },
    { id: 'mine', label: 'My documents', icon: FolderOpen, show: can('document:read') && hasEmployee },
    { id: 'employees', label: 'Employee documents', icon: Users, show: reviews },
  ].filter((t) => t.show)

  const requested = params.get('tab')
  const fallback = tabs.find((t) => t.id === 'mine') ?? tabs[0]
  const current = tabs.find((t) => t.id === requested) ?? fallback
  const typesQuery = useDocumentTypes({ enabled: can('document:read') })

  const go = (tab, extra = {}) => setParams({ tab, ...extra }, { replace: true })

  if (!current) return null

  return (
    <>
      <PageHeader
        title="Documents"
        subtitle={reviews
          ? 'Company policies, and everybody’s documents to check'
          : tabs.some((t) => t.id === 'mine') ? 'Company policies, and the documents HR needs from you' : 'Company policies and handbook'}
        tabs={tabs.map((t) => ({ key: t.id, label: t.label, icon: t.icon }))}
        tab={current.id}
        onTab={(id) => go(id)}
        panelId="documents-panel"
      />

      <TabPanel id="documents-panel" tab={tabs.length > 1 ? current.id : null}>
      {current.id === 'company' && <CompanyDocuments />}
      {/* The checklist and the upload limit come first: a file is checked against them before it is sent. */}
      {current.id !== 'company' && (
        <DataState query={typesQuery}>
          {(limits) => current.id === 'mine' ? (
            <MyDocuments types={limits.types} limits={limits} canUpload={can('document:upload')} />
          ) : (
            <EmployeeDocuments types={limits.types} limits={limits} selected={params.get('employee')} onSelect={(id) => go('employees', { employee: id })} />
          )}
        </DataState>
      )}
      </TabPanel>
    </>
  )
}

function MyDocuments({ types, limits, canUpload }) {
  const checklist = useChecklist(undefined)
  return (
    <DataState query={checklist}>
      {(data) => (
        <div className="space-y-4">
          <div className="rounded-xl bg-logo-soft p-4">
            <p className="text-sm font-bold text-gray-900">Upload a clear photo or PDF of each document.</p>
            <p className="text-xs text-gray-600 mt-0.5">HR checks it against the original; you are told when it is verified, or why it was not.</p>
          </div>
          <Checklist data={data} types={types} limits={limits} reviewer={false} canUpload={canUpload} />
        </div>
      )}
    </DataState>
  )
}
