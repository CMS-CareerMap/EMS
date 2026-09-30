import { describe, it, expect } from 'vitest'
import { checkUpload, detectKind, displayName, extensionOf, kindForContentType } from './fileRules'

const MB = 1024 * 1024
const bytes = (...b: number[]) => new Uint8Array([...b, ...new Array(32).fill(0)])
const PDF = bytes(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37)
const JPEG = bytes(0xff, 0xd8, 0xff, 0xe0)
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)
const WEBP = bytes(0x52, 0x49, 0x46, 0x46, 0x10, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50)
const HTML = new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>')

const upload = (fileName: string, declaredType: string, content: Uint8Array, size = content.length) =>
  checkUpload({ fileName, declaredType, bytes: content, size }, 2)

describe('what a file really is', () => {
  it('is read from its first bytes', () => {
    expect(detectKind(PDF)).toBe('pdf')
    expect(detectKind(JPEG)).toBe('jpeg')
    expect(detectKind(PNG)).toBe('png')
    expect(detectKind(WEBP)).toBe('webp')
    expect(detectKind(HTML)).toBeNull()
  })
})

describe('an upload', () => {
  it('is accepted when name, declared type and bytes agree', () => {
    expect(upload('aadhaar.pdf', 'application/pdf', PDF)).toEqual({ ok: true, kind: 'pdf', contentType: 'application/pdf', extension: 'pdf' })
    expect(upload('photo.JPEG', 'image/jpeg', JPEG)).toMatchObject({ ok: true, kind: 'jpeg', extension: 'jpg' })
  })

  it('refuses a web page renamed to look like a PDF — its bytes give it away', () => {
    expect(upload('cv.pdf', 'application/pdf', HTML)).toMatchObject({ ok: false, reason: 'type' })
  })

  it('refuses a real PNG whose name says PDF', () => {
    const verdict = upload('scan.pdf', 'application/pdf', PNG)
    expect(verdict).toMatchObject({ ok: false, reason: 'type' })
    expect(verdict.ok === false && verdict.message).toMatch(/\.png/)
  })

  it('refuses a file whose browser-declared type contradicts its bytes', () => {
    expect(upload('scan.png', 'text/html', PNG)).toMatchObject({ ok: false, reason: 'type' })
  })

  it('accepts a type the browser did not name', () => {
    expect(upload('scan.png', 'application/octet-stream', PNG)).toMatchObject({ ok: true, kind: 'png' })
    expect(upload('scan.png', '', PNG)).toMatchObject({ ok: true, kind: 'png' })
  })

  it('refuses an empty file, and one over the company cap, saying how big each is', () => {
    expect(upload('a.pdf', 'application/pdf', new Uint8Array(0), 0)).toMatchObject({ ok: false, reason: 'empty' })
    const big = upload('a.pdf', 'application/pdf', PDF, 3 * MB)
    expect(big).toMatchObject({ ok: false, reason: 'too_large' })
    expect(big.ok === false && big.message).toMatch(/3\.0 MB.*2 MB/)
  })

  it('tells a photo over the cap what a photo can do — not to "save the PDF smaller"', () => {
    const photo = upload('aadhaar.png', 'image/png', PNG, 7.5 * MB)
    expect(photo.ok === false && photo.message).toMatch(/^That photo is 7\.5 MB; the most this company accepts is 2 MB\. Take it again/)
    const scan = upload('a.pdf', 'application/pdf', PDF, 3 * MB)
    expect(scan.ok === false && scan.message).toMatch(/^That PDF is 3\.0 MB.*reduce size/)
  })

  it('never lets the cap go past the system ceiling, whatever the setting says', () => {
    const verdict = checkUpload({ fileName: 'a.pdf', declaredType: 'application/pdf', bytes: PDF, size: 11 * MB }, 50)
    expect(verdict).toMatchObject({ ok: false, reason: 'too_large' })
  })

  it('can be narrowed to fewer kinds', () => {
    expect(checkUpload({ fileName: 'a.png', declaredType: 'image/png', bytes: PNG, size: PNG.length }, 2, ['pdf'])).toMatchObject({ ok: false, reason: 'type' })
  })
})

describe('names', () => {
  it('lose folders and control characters, and are kept to a readable length', () => {
    expect(displayName('C:\\Users\\me\\Aadhaar card.pdf')).toBe('Aadhaar card.pdf')
    expect(displayName('../../etc/passwd')).toBe('passwd')
    expect(displayName('a\u0000b\u001f.pdf')).toBe('ab.pdf')
    expect(displayName('x'.repeat(300) + '.pdf').length).toBeLessThanOrEqual(120)
    expect(displayName('')).toBe('file')
  })

  it('give their extension, lower-cased', () => {
    expect(extensionOf('Scan.PDF')).toBe('pdf')
    expect(extensionOf('noextension')).toBe('')
    expect(extensionOf('.hidden')).toBe('')
  })
})

describe('serving', () => {
  it('uses the allow-list, and knows nothing outside it', () => {
    expect(kindForContentType('application/pdf')).toBe('pdf')
    expect(kindForContentType('text/html')).toBeNull()
  })
})
