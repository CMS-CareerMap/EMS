/**
 * Makes a file fit the company's upload limit before it is sent.
 *
 * A phone photo of an Aadhaar card is often 3–5 MB; the company accepts 2 MB.
 * Rather than refusing it, a photo that is too large is redrawn here — at most
 * 2000 pixels on its longer side, as a JPEG — which keeps it perfectly readable
 * at a few hundred KB. This happens in the browser, so the large original never
 * leaves the phone.
 *
 * A PDF cannot be made smaller in a browser. One over the limit gets a clear
 * message saying so, and what to do instead.
 */

const MB = 1024 * 1024
const MAX_SIDE = 2000
const IMAGE = /^image\/(jpeg|png|webp)$/

export function formatSize(bytes) {
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}

function jpgName(name) {
  const base = name.replace(/\.[^.]+$/, '') || 'photo'
  return `${base}.jpg`
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))
}

/**
 * Returns a File no larger than `maxMb`, or throws an Error whose message can
 * be shown as it is.
 */
export async function prepareUpload(file, maxMb) {
  const limit = maxMb * MB
  if (file.size <= limit) return file

  if (!IMAGE.test(file.type)) {
    // A photo in a form the browser cannot redraw — an iPhone's HEIC, or one
    // whose type the picker left blank.
    if (file.type.startsWith('image/') || /\.(heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
      throw new Error(
        `That photo is ${formatSize(file.size)}; the most this company accepts is ${maxMb} MB, and this kind of photo cannot be made smaller here. ` +
          'Save it as a JPG (most phones can, or take a screenshot of it) and upload that.',
      )
    }
    throw new Error(
      `That file is ${formatSize(file.size)}; the most this company accepts is ${maxMb} MB. ` +
        'Save the PDF smaller (most scanner apps have a "reduce size" option), or upload a photo of the page instead.',
    )
  }

  let bitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new Error('That photo could not be opened to make it smaller. Take it again, or save it as a JPG first.')
  }

  let scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height))
  for (let attempt = 0; attempt < 5; attempt++) {
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    // White behind a transparent PNG, rather than black.
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, width, height)
    context.drawImage(bitmap, 0, 0, width, height)

    for (const quality of [0.85, 0.75, 0.65, 0.55]) {
      const blob = await canvasBlob(canvas, quality)
      if (blob && blob.size <= limit) {
        bitmap.close?.()
        return new File([blob], jpgName(file.name), { type: 'image/jpeg', lastModified: Date.now() })
      }
    }
    scale *= 0.75
  }

  bitmap.close?.()
  throw new Error(`That photo is still over ${maxMb} MB after making it smaller. Take it again from a little further away.`)
}
