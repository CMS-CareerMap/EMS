import { useEffect, useState } from 'react'
import { Download, Loader2, X, FileWarning } from 'lucide-react'
import { useEscape } from '../../hooks/useEscape'
import { useDownload } from '../../hooks/useDownload'

/**
 * A stored file, shown on the page.
 *
 * The file arrives through the same authenticated route as a download — as an
 * attachment of an allow-listed type — and is displayed from a blob the page
 * makes itself. Nothing is ever loaded from a public address, and the old
 * "OFFICIAL COPY" card the page drew when there was no file is gone: no file
 * means no picture.
 */
export default function PreviewDialog({ title, subtitle, loadBlob, download, contentType, onClose, children }) {
  useEscape(onClose)
  const [url, setUrl] = useState(null)
  const [failed, setFailed] = useState(false)
  const { busy, start } = useDownload()

  useEffect(() => {
    let revoked = false
    let objectUrl = null
    loadBlob()
      .then((blob) => {
        if (revoked) return
        objectUrl = URL.createObjectURL(blob)
        setUrl(objectUrl)
      })
      .catch((err) => {
        // The server's words when the stored file is missing or altered —
        // downloading it would fail the same way, so no "download it instead".
        if (!revoked) setFailed(err?.code === 'FILE_UNAVAILABLE' ? err.message : true)
      })
    return () => {
      revoked = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [loadBlob])

  const isPdf = contentType === 'application/pdf'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-4 overflow-y-auto" role="dialog" aria-modal="true" aria-label={title}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl my-8 overflow-hidden flex flex-col">
        <div className="flex items-center justify-between gap-3 px-6 py-4 border-b border-gray-100">
          <div className="min-w-0">
            <p className="text-base font-semibold text-gray-900 truncate">{title}</p>
            {subtitle && <p className="text-xs text-gray-500 truncate">{subtitle}</p>}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button onClick={() => start('file', download)} disabled={busy === 'file'}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-xs font-semibold hover:bg-gray-50 disabled:opacity-60">
              {busy === 'file' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />} Download
            </button>
            <button onClick={onClose} aria-label="Close" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400"><X className="w-4 h-4" /></button>
          </div>
        </div>

        <div className="bg-slate-100 flex items-center justify-center min-h-80 p-4">
          {failed ? (
            <div className="text-center text-sm text-gray-500 py-12">
              <FileWarning className="w-8 h-8 mx-auto text-gray-300" />
              <p className="mt-2 max-w-md mx-auto">{typeof failed === 'string' ? failed : 'The file could not be opened here. Download it instead.'}</p>
            </div>
          ) : !url ? (
            <Loader2 className="w-6 h-6 animate-spin text-gray-400" />
          ) : isPdf ? (
            <iframe src={url} title={title} className="w-full h-[65vh] rounded-lg bg-white border border-gray-200" />
          ) : (
            <img src={url} alt={title} className="max-h-[65vh] max-w-full object-contain rounded-lg bg-white shadow" />
          )}
        </div>

        {/* Children may depend on whether the file opened: nobody verifies what they could not see. */}
        {(() => {
          const footer = typeof children === 'function' ? children({ failed: Boolean(failed) }) : children
          return footer ? <div className="px-6 py-4 border-t border-gray-100">{footer}</div> : null
        })()}
      </div>
    </div>
  )
}
