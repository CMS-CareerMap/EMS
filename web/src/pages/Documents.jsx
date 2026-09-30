import { useSearchParams } from 'react-router-dom'
import { FileText, FolderOpen, Users } from 'lucide-react'
import { useAuthStore } from '../stores/authStore'
import { useChecklist, useDocumentTypes } from '../hooks/useDocuments'
import CompanyDocuments from '../features/documents/CompanyDocuments'
import EmployeeDocuments from '../features/documents/EmployeeDocuments'
import Checklist from '../features/documents/Checklist'
import DataState from '../components/DataState'

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
    <div className="space-y-5">
      <div>
        <h2 className="text-2xl font-bold text-gray-900">Documents</h2>
        <p className="text-sm text-gray-500 mt-0.5">
          {reviews ? 'Company policies, and everybody’s documents to check' : 'Company policies, and the documents HR needs from you'}
        </p>
      </div>

      {tabs.length > 1 && (
        <div className="flex items-center gap-1 border-b border-gray-200 overflow-x-auto">
          {tabs.map((t) => (
            <button key={t.id} onClick={() => go(t.id)}
              className={`shrink-0 flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${current.id === t.id ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
              <t.icon className="w-4 h-4" /> {t.label}
            </button>
          ))}
        </div>
      )}

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
    </div>
  )
}

function MyDocuments({ types, limits, canUpload }) {
  const checklist = useChecklist(undefined)
  return (
    <DataState query={checklist}>
      {(data) => (
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Upload a clear photo or PDF of each document. HR checks it against the original; you are told when it is verified, or why it was not.
          </p>
          <Checklist data={data} types={types} limits={limits} reviewer={false} canUpload={canUpload} />
        </div>
      )}
    </DataState>
  )
}
