import { useEffect, useRef, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import Dialog from '../../components/Dialog'
import { btn } from '../../components/ui/styles'

/**
 * The selfie with a punch (client, 11 Oct 2026), when the company asks for
 * one: the front camera, live — never a photo from the gallery — made small
 * here (about 480 px, a JPEG of ~50 KB) before it is sent. Shown to HR and the
 * person's manager on the day, and deleted after the company's days for
 * keeping it.
 *
 * `onTaken(dataUrl)` or `onCancel()`; the camera is let go either way.
 */
const WIDTH = 480

export default function SelfieDialog({ onTaken, onCancel }) {
  const video = useRef(null)
  const stream = useRef(null)
  const [ready, setReady] = useState(false)
  const [problem, setProblem] = useState('')

  useEffect(() => {
    let gone = false
    async function open() {
      try {
        if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot use the camera.')
        const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false })
        if (gone) {
          media.getTracks().forEach((t) => t.stop())
          return
        }
        stream.current = media
        video.current.srcObject = media
        await video.current.play()
        setReady(true)
      } catch (err) {
        setProblem(err?.name === 'NotAllowedError'
          ? 'Camera access was blocked. Allow it for this site in your browser’s settings, then try again.'
          : err?.message || 'The camera could not be opened.')
      }
    }
    open()
    return () => {
      gone = true
      stream.current?.getTracks().forEach((t) => t.stop())
    }
  }, [])

  function take() {
    const v = video.current
    const scale = WIDTH / (v.videoWidth || WIDTH)
    const canvas = document.createElement('canvas')
    canvas.width = WIDTH
    canvas.height = Math.round((v.videoHeight || WIDTH) * scale)
    canvas.getContext('2d').drawImage(v, 0, 0, canvas.width, canvas.height)
    stream.current?.getTracks().forEach((t) => t.stop())
    onTaken(canvas.toDataURL('image/jpeg', 0.7))
  }

  return (
    <Dialog title="Your photo" onClose={onCancel}>
      <div className="space-y-3">
        <p className="text-sm text-gray-600">The company asks for a photo with every punch. Look at the camera, then take it.</p>
        <div className="relative bg-gray-900 rounded-xl overflow-hidden aspect-[4/3] flex items-center justify-center">
          {/* Mirrored, as a selfie camera shows; the photo itself is not. */}
          <video ref={video} playsInline muted className="w-full h-full object-cover -scale-x-100" aria-label="Camera" />
          {!ready && !problem && <Loader2 className="w-6 h-6 text-white animate-spin absolute" aria-hidden="true" />}
        </div>
        {problem && <p role="alert" className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{problem}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className={btn.secondary}>Cancel</button>
          <button type="button" onClick={take} disabled={!ready} className={btn.primary}>
            <Camera className="w-4 h-4" aria-hidden="true" />Take photo
          </button>
        </div>
      </div>
    </Dialog>
  )
}
