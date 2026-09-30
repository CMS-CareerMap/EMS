import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import request from 'supertest'
import { writeFile, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { createApp } from '../../app'
import { prisma } from '../../platform/db/prisma'
import { hashPassword } from '../../platform/auth/password'
import { env } from '../../config/env'

/**
 * Day 19: employee documents and the company's own — upload rules decided by
 * the file's bytes, nobody verifying their own, replacing without destroying,
 * files served only as attachments of an allow-listed type, and the notices
 * each step sends.
 */

const PREFIX = 'doctest'
const PASSWORD = 'CorrectHorseBattery1'
const app = createApp()
const day = (d: string) => new Date(`${d}T00:00:00Z`)

type Who = 'super_admin' | 'admin' | 'hr' | 'manager' | 'accounts' | 'esha' | 'ravi'
const ROLE: Record<Who, 'super_admin' | 'admin' | 'hr' | 'manager' | 'accounts' | 'employee'> = {
  super_admin: 'super_admin', admin: 'admin', hr: 'hr', manager: 'manager', accounts: 'accounts', esha: 'employee', ravi: 'employee',
}

let orgId = ''
const token = {} as Record<Who, string>
const userId = {} as Record<Who, string>
const employee = {} as Record<'esha' | 'ravi' | 'hema', string>
const type = {} as Record<'aadhaar' | 'pan' | 'resume', string>

const PDF = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n')
const PDF2 = Buffer.from('%PDF-1.4\n% a second, different file\n%%EOF\n')
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)])
const HTML = Buffer.from('<!DOCTYPE html><html><script>alert(document.cookie)</script></html>')
const BIG_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(1_600_000, 0x20)])

async function cleanup(): Promise<void> {
  const org = { organization: { name: { startsWith: PREFIX } } }
  await prisma.notification.deleteMany({ where: org })
  await prisma.notificationSetting.deleteMany({ where: org })
  await prisma.employeeDocument.deleteMany({ where: org })
  await prisma.documentType.deleteMany({ where: org })
  await prisma.companyDocument.deleteMany({ where: org })
  await prisma.auditLog.deleteMany({ where: org })
  await prisma.employee.deleteMany({ where: org })
  await prisma.membership.deleteMany({ where: org })
  await prisma.user.deleteMany({ where: { email: { startsWith: PREFIX } } })
  await prisma.organization.deleteMany({ where: { name: { startsWith: PREFIX } } })
}

const as = (who: Who) => `Bearer ${token[who]}`
const get = (who: Who, url: string) => request(app).get(url).set('Authorization', as(who))
const post = (who: Who, url: string, body: object = {}) => request(app).post(url).set('Authorization', as(who)).send(body)
const del = (who: Who, url: string) => request(app).delete(url).set('Authorization', as(who))

function upload(who: Who, file: { bytes: Buffer; name: string; type: string } | null, fields: Record<string, string>) {
  let req = request(app).post('/api/employee-documents').set('Authorization', as(who))
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v)
  if (file) req = req.attach('file', file.bytes, { filename: file.name, contentType: file.type })
  return req
}

const pdf = (name = 'aadhaar.pdf', bytes = PDF) => ({ bytes, name, type: 'application/pdf' })

const binary = (who: Who, url: string) =>
  get(who, url)
    .buffer(true)
    .parse((res, callback) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => callback(null, Buffer.concat(chunks)))
    })

const noticesOf = (who: Who, event: string) =>
  prisma.notification.findMany({ where: { organizationId: orgId, userId: userId[who], event }, orderBy: { createdAt: 'desc' } })

beforeAll(async () => {
  await cleanup()
  const org = await prisma.organization.create({ data: { name: `${PREFIX}-org`, timezone: 'Asia/Kolkata', maxUploadMb: 1 } })
  orgId = org.id

  for (const who of Object.keys(ROLE) as Who[]) {
    const email = `${PREFIX}-${who}@example.com`
    const user = await prisma.user.create({ data: { email, passwordHash: await hashPassword(PASSWORD) } })
    const m = await prisma.membership.create({ data: { userId: user.id, organizationId: orgId, role: ROLE[who], status: 'active' } })
    userId[who] = user.id
    if (who === 'esha' || who === 'ravi' || who === 'hr') {
      const e = await prisma.employee.create({
        data: { organizationId: orgId, employeeCode: `DT-${who.toUpperCase()}`, fullName: who === 'hr' ? 'Hema HR' : who === 'esha' ? 'Esha Iyer' : 'Ravi Rao', dateOfJoining: day('2025-01-01'), membershipId: m.id },
      })
      employee[who === 'hr' ? 'hema' : who] = e.id
    }
    const res = await request(app).post('/api/auth/login').send({ identifier: email, password: PASSWORD })
    token[who] = res.body.data.accessToken
  }

  for (const [code, label, required, order] of [['aadhaar', 'Aadhaar Card', true, 1], ['pan', 'PAN Card', true, 2], ['resume', 'Resume', false, 3]] as const) {
    type[code] = (await prisma.documentType.create({ data: { organizationId: orgId, code, label, required, displayOrder: order } })).id
  }
})

afterAll(async () => {
  await cleanup()
  await prisma.$disconnect()
})

describe('the checklist of types', () => {
  it('is read by anybody with documents, with what an upload may be', async () => {
    const res = await get('esha', '/api/document-types')
    expect(res.status).toBe(200)
    expect(res.body.data.map((t: { code: string }) => t.code)).toEqual(['aadhaar', 'pan', 'resume'])
    expect(res.body.meta).toMatchObject({ max_upload_mb: 1, accepted: ['PDF', 'JPG', 'PNG', 'WEBP'] })
  })

  it('is edited by HR — added, renamed, made required, archived and restored', async () => {
    const created = await post('hr', '/api/document-types', { label: 'Address Proof', required: false })
    expect(created.status).toBe(201)
    expect(created.body.data).toMatchObject({ code: 'address_proof', label: 'Address Proof', required: false })
    expect((await post('hr', '/api/document-types', { label: 'address proof' })).status).toBe(409)

    const id = created.body.data.id
    const changed = await request(app).patch(`/api/document-types/${id}`).set('Authorization', as('hr')).send({ label: 'Proof of Address', required: true })
    expect(changed.body.data).toMatchObject({ label: 'Proof of Address', required: true, code: 'address_proof' })

    await request(app).patch(`/api/document-types/${id}`).set('Authorization', as('hr')).send({ archived: true })
    expect((await get('esha', '/api/document-types')).body.data.map((t: { code: string }) => t.code)).not.toContain('address_proof')
    expect((await get('hr', '/api/document-types?includeArchived=true')).body.data.find((t: { id: string }) => t.id === id).archived).toBe(true)
    await request(app).patch(`/api/document-types/${id}`).set('Authorization', as('hr')).send({ archived: false })
    await request(app).patch(`/api/document-types/${id}`).set('Authorization', as('hr')).send({ archived: true })
  })

  it('is not edited by an employee', async () => {
    expect((await post('esha', '/api/document-types', { label: 'Mine' })).status).toBe(403)
  })
})

describe('uploading', () => {
  it('files an employee’s own document as waiting for a check, and tells HR — not the uploader', async () => {
    const res = await upload('esha', pdf(), { documentTypeId: type.aadhaar })
    expect(res.status).toBe(201)
    expect(res.body.data).toMatchObject({ status: 'pending', employee_id: employee.esha, content_type: 'application/pdf', file_name: 'aadhaar.pdf' })

    for (const who of ['hr', 'admin', 'super_admin'] as const) {
      const [notice] = await noticesOf(who, 'document.submitted')
      expect(notice).toMatchObject({ title: 'A document to check', link: `/documents?tab=employees&employee=${employee.esha}` })
      expect(notice?.message).toContain('Esha Iyer uploaded their Aadhaar Card')
    }
    expect(await noticesOf('esha', 'document.submitted')).toHaveLength(0)
    expect(await noticesOf('manager', 'document.submitted')).toHaveLength(0)

    const audit = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'document.uploaded', entityId: res.body.data.id } })
    expect(audit?.details).toMatchObject({ employeeId: employee.esha, type: 'aadhaar', verified: false })
  })

  it('refuses a web page renamed to .pdf, a PNG named .pdf, and a file over the company cap', async () => {
    const html = await upload('esha', { bytes: HTML, name: 'resume.pdf', type: 'application/pdf' }, { documentTypeId: type.resume })
    expect(html.status).toBe(400)
    expect(html.body.error.message).toMatch(/Only PDF, JPG, PNG, WEBP/)

    const png = await upload('esha', { bytes: PNG, name: 'resume.pdf', type: 'application/pdf' }, { documentTypeId: type.resume })
    expect(png.status).toBe(400)
    expect(png.body.error.message).toMatch(/\.png/)

    const big = await upload('esha', pdf('big.pdf', BIG_PDF), { documentTypeId: type.resume })
    expect(big.status).toBe(413)
    expect(big.body.error.message).toMatch(/1 MB/)

    const none = await upload('esha', null, { documentTypeId: type.resume })
    expect(none.status).toBe(400)
  })

  it('keeps a file name in Hindi or with accents exactly as it was', async () => {
    const res = await upload('esha', pdf('Résumé – मेरा बायोडाटा.pdf'), { documentTypeId: type.resume })
    expect(res.status).toBe(201)
    expect(res.body.data.file_name).toBe('Résumé – मेरा बायोडाटा.pdf')
  })

  it('answers a form cut short with a 400, not a server fault', async () => {
    const res = await request(app)
      .post('/api/employee-documents')
      .set('Authorization', `Bearer ${token.esha}`)
      .set('Content-Type', 'multipart/form-data; boundary=cutshort')
      .send('--cutshort\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 and then the connection dropp')
    expect(res.status).toBe(400)
    expect(res.body.error.message).toMatch(/incomplete/)
  })

  it('does not let an employee file a document for somebody else', async () => {
    const res = await upload('esha', pdf(), { documentTypeId: type.pan, employeeId: employee.ravi })
    expect(res.status).toBe(404)
  })

  it('refuses an archived type, and a manager who holds no document right', async () => {
    const archived = await prisma.documentType.findFirstOrThrow({ where: { organizationId: orgId, code: 'address_proof' } })
    expect((await upload('esha', pdf(), { documentTypeId: archived.id })).status).toBe(400)
    expect((await upload('manager', pdf(), { documentTypeId: type.pan })).status).toBe(403)
  })

  it('lets HR file somebody else’s document as checked — but never their own', async () => {
    const filed = await upload('hr', pdf('pan.pdf'), { documentTypeId: type.pan, employeeId: employee.ravi, markVerified: 'true' })
    expect(filed.status).toBe(201)
    expect(filed.body.data).toMatchObject({ status: 'verified', decided_by: null })
    const row = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: filed.body.data.id } })
    expect(row.decidedByUserId).toBe(userId.hr)

    const own = await upload('hr', pdf('pan.pdf'), { documentTypeId: type.pan, markVerified: 'true' })
    expect(own.status).toBe(403)
    expect(own.body.error.message).toMatch(/your own/)
  })
})

describe('reading', () => {
  it('gives a person their own checklist, and HR anybody’s — nobody else', async () => {
    const mine = await get('esha', '/api/employee-documents')
    expect(mine.status).toBe(200)
    expect(mine.body.data.own).toBe(true)
    const aadhaar = mine.body.data.items.find((i: { type: { code: string } }) => i.type.code === 'aadhaar')
    expect(aadhaar.current).toMatchObject({ status: 'pending', uploaded_by: 'Esha Iyer' })
    expect(mine.body.data.items.find((i: { type: { code: string } }) => i.type.code === 'pan').current).toBeNull()

    expect((await get('esha', `/api/employee-documents?employeeId=${employee.ravi}`)).status).toBe(404)
    const hr = await get('hr', `/api/employee-documents?employeeId=${employee.esha}`)
    expect(hr.status).toBe(200)
    expect(hr.body.data.own).toBe(false)
    expect((await get('manager', '/api/employee-documents')).status).toBe(403)
  })

  it('serves the file as an attachment of an allow-listed type, and records who took it', async () => {
    const doc = await prisma.employeeDocument.findFirstOrThrow({ where: { organizationId: orgId, employeeId: employee.esha, documentTypeId: type.aadhaar } })
    const res = await binary('esha', `/api/employee-documents/${doc.id}/file`)
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toBe('application/pdf')
    expect(res.headers['content-disposition']).toBe('attachment; filename="DT-ESHA-aadhaar.pdf"')
    expect(res.headers['x-content-type-options']).toBe('nosniff')
    expect(res.headers['cache-control']).toBe('private, no-store')
    expect(Buffer.compare(res.body as Buffer, PDF)).toBe(0)

    const event = await prisma.auditLog.findFirst({ where: { organizationId: orgId, action: 'document.downloaded', entityId: doc.id } })
    expect(event?.details).toMatchObject({ employeeId: employee.esha, own: true })

    expect((await get('ravi', `/api/employee-documents/${doc.id}/file`)).status).toBe(404)
    expect((await get('hr', `/api/employee-documents/${doc.id}/file`)).status).toBe(200)
  })

  it('refuses a file that was changed in storage — and says so in words, not "Something went wrong"', async () => {
    const res = await upload('esha', pdf('resume.pdf', PDF2), { documentTypeId: type.resume })
    const row = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: res.body.data.id } })
    await writeFile(join(env.STORAGE_PATH, row.storageKey), Buffer.from('%PDF-1.4 tampered'))
    const answer = await get('esha', `/api/employee-documents/${row.id}/file`)
    expect(answer.status).toBe(500)
    expect(answer.body.error).toMatchObject({ code: 'FILE_UNAVAILABLE' })
    expect(answer.body.error.message).toMatch(/missing or has been altered/)
    // No storage key or id is handed to the browser.
    expect(JSON.stringify(answer.body)).not.toContain(row.storageKey)
    // And it is on the record: who tried to open which file, and when.
    expect(await prisma.auditLog.count({ where: { organizationId: orgId, action: 'file.unreadable', entityId: row.id } })).toBe(1)
  })

  it('answers the same way for a file that is gone from storage — and will not let it be verified', async () => {
    const res = await upload('esha', pdf('resume.pdf', PDF2), { documentTypeId: type.resume })
    const row = await prisma.employeeDocument.findUniqueOrThrow({ where: { id: res.body.data.id } })
    await unlink(join(env.STORAGE_PATH, row.storageKey))
    const answer = await get('hr', `/api/employee-documents/${row.id}/file`)
    expect(answer.status).toBe(500)
    expect(answer.body.error.code).toBe('FILE_UNAVAILABLE')

    // Nobody can have compared it with the original.
    const verify = await post('hr', `/api/employee-documents/${row.id}/decision`, { decision: 'verified' })
    expect(verify.status).toBe(409)
    expect(verify.body.error.message).toMatch(/cannot be verified\. Reject it and ask for it to be uploaded again/)
    expect((await prisma.employeeDocument.findUniqueOrThrow({ where: { id: row.id } })).status).toBe('pending')
    // Rejecting it, to have it sent again, still works.
    const reject = await post('hr', `/api/employee-documents/${row.id}/decision`, { decision: 'rejected', remarks: 'The file is missing — please upload it again' })
    expect(reject.status).toBe(200)
  })
})

describe('deciding', () => {
  it('lets HR verify an employee’s document once, and tells the employee', async () => {
    const doc = await prisma.employeeDocument.findFirstOrThrow({ where: { organizationId: orgId, employeeId: employee.esha, documentTypeId: type.aadhaar, supersededAt: null } })
    const res = await post('hr', `/api/employee-documents/${doc.id}/decision`, { decision: 'verified' })
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('verified')
    const [notice] = await noticesOf('esha', 'document.decided')
    expect(notice).toMatchObject({ title: 'Document verified', message: 'Your Aadhaar Card was verified.', link: '/documents?tab=mine' })

    expect((await post('admin', `/api/employee-documents/${doc.id}/decision`, { decision: 'rejected', remarks: 'late' })).status).toBe(409)
  })

  it('needs a reason to reject, and passes the reason on', async () => {
    const res = await upload('ravi', pdf('aadhaar.pdf'), { documentTypeId: type.aadhaar })
    const id = res.body.data.id
    expect((await post('hr', `/api/employee-documents/${id}/decision`, { decision: 'rejected' })).status).toBe(400)
    const rejected = await post('hr', `/api/employee-documents/${id}/decision`, { decision: 'rejected', remarks: 'Photo is blurred' })
    expect(rejected.body.data).toMatchObject({ status: 'rejected', remarks: 'Photo is blurred' })
    const [notice] = await noticesOf('ravi', 'document.decided')
    expect(notice?.message).toBe('Your Aadhaar Card was rejected: Photo is blurred. Upload a corrected copy.')
  })

  it('never lets anybody decide their own document — somebody else must', async () => {
    const own = await upload('hr', pdf('aadhaar.pdf'), { documentTypeId: type.aadhaar })
    expect(own.status).toBe(201)
    const refused = await post('hr', `/api/employee-documents/${own.body.data.id}/decision`, { decision: 'verified' })
    expect(refused.status).toBe(403)
    expect((await post('admin', `/api/employee-documents/${own.body.data.id}/decision`, { decision: 'verified' })).status).toBe(200)
  })

  it('is not an employee’s to do', async () => {
    const doc = await prisma.employeeDocument.findFirstOrThrow({ where: { organizationId: orgId, employeeId: employee.esha, documentTypeId: type.resume, supersededAt: null } })
    expect((await post('esha', `/api/employee-documents/${doc.id}/decision`, { decision: 'verified' })).status).toBe(403)
  })
})

describe('replacing and removing', () => {
  it('replaces the current file with a new upload, keeping the old one readable', async () => {
    const res = await upload('esha', pdf('aadhaar-new.pdf', PDF2), { documentTypeId: type.aadhaar })
    expect(res.body.data.status).toBe('pending')
    const list = await get('esha', '/api/employee-documents')
    const item = list.body.data.items.find((i: { type: { code: string } }) => i.type.code === 'aadhaar')
    expect(item.current).toMatchObject({ id: res.body.data.id, file_name: 'aadhaar-new.pdf', status: 'pending' })
    expect(item.earlier).toHaveLength(1)
    expect(item.earlier[0]).toMatchObject({ status: 'verified', file_name: 'aadhaar.pdf' })
    expect(item.earlier[0].replaced_at).not.toBeNull()
    expect((await binary('esha', `/api/employee-documents/${item.earlier[0].id}/file`)).status).toBe(200)
  })

  it('lets an employee withdraw an unchecked upload — and the one it replaced is current again', async () => {
    const before = (await get('esha', '/api/employee-documents')).body.data.items.find((i: { type: { code: string } }) => i.type.code === 'aadhaar')
    const current = before.current
    const replaced = before.earlier[0]
    expect((await del('esha', `/api/employee-documents/${current.id}`)).status).toBe(200)
    const after = (await get('esha', '/api/employee-documents')).body.data.items.find((i: { type: { code: string } }) => i.type.code === 'aadhaar')
    // A second copy sent by mistake does not cost her the verified one.
    expect(after.current).toMatchObject({ id: replaced.id, status: 'verified', replaced_at: null })
    expect(after.earlier).toHaveLength(0)
    const event = await prisma.auditLog.findFirstOrThrow({ where: { organizationId: orgId, action: 'document.removed', entityId: current.id } })
    expect(event.details).toMatchObject({ restored: replaced.id })

    const verified = await prisma.employeeDocument.findFirstOrThrow({ where: { organizationId: orgId, employeeId: employee.ravi, documentTypeId: type.pan, removedAt: null } })
    expect((await del('ravi', `/api/employee-documents/${verified.id}`)).status).toBe(409)
    expect((await del('hr', `/api/employee-documents/${verified.id}`)).status).toBe(200)
  })
})

describe('compliance', () => {
  it('counts each person’s required documents, and lists what waits to be checked', async () => {
    // Ravi: Aadhaar rejected, PAN removed → 1 rejected, 1 missing.
    await upload('esha', pdf('pan.pdf'), { documentTypeId: type.pan })
    // And a fresh résumé — optional — waiting too.
    await upload('esha', pdf('resume-again.pdf', PDF2), { documentTypeId: type.resume })
    const res = await get('hr', '/api/employee-documents/compliance')
    expect(res.status).toBe(200)
    expect(res.body.data.required_types.map((t: { code: string }) => t.code)).toEqual(['aadhaar', 'pan'])
    const ravi = res.body.data.employees.find((e: { employee_id: string }) => e.employee_id === employee.ravi)
    expect(ravi).toMatchObject({ required: 2, verified: 0, pending: 0, rejected: 1, missing: 1 })
    const esha = res.body.data.employees.find((e: { employee_id: string }) => e.employee_id === employee.esha)
    // Her Aadhaar is verified again (the mistaken second copy was withdrawn); her PAN waits.
    expect(esha).toMatchObject({ required: 2, verified: 1, pending: 1, rejected: 0, missing: 0 })
    // Waiting counts every type — her optional résumé as well as the PAN.
    expect(esha.waiting_count).toBe(2)
    expect(res.body.data.waiting.some((d: { type: { code: string }; employee_id: string }) => d.type.code === 'pan' && d.employee_id === employee.esha)).toBe(true)

    expect((await get('esha', '/api/employee-documents/compliance')).status).toBe(403)
  })
})

describe('the company’s documents', () => {
  let id = ''

  it('are published by HR and announced to everybody else', async () => {
    const res = await request(app)
      .post('/api/company-documents')
      .set('Authorization', as('hr'))
      .field('title', 'Leave Policy 2026')
      .field('category', 'policy')
      .attach('file', PDF, { filename: 'leave-policy.pdf', contentType: 'application/pdf' })
    expect(res.status).toBe(201)
    id = res.body.data.id
    expect(res.body.data).toMatchObject({ title: 'Leave Policy 2026', category: 'policy' })

    for (const who of ['esha', 'manager', 'accounts', 'super_admin'] as const) {
      const [notice] = await noticesOf(who, 'company_document.published')
      expect(notice?.message).toBe('Leave Policy 2026 has been published.')
      // The company tab — an employee's Documents page opens on their own files.
      expect(notice?.link).toBe('/documents?tab=company')
    }
    expect(await noticesOf('hr', 'company_document.published')).toHaveLength(0)
  })

  it('are read by every role — a manager and Accounts included', async () => {
    for (const who of ['manager', 'accounts', 'esha'] as const) {
      const list = await get(who, '/api/company-documents')
      expect(list.status).toBe(200)
      expect(list.body.data.map((d: { id: string }) => d.id)).toContain(id)
      const file = await binary(who, `/api/company-documents/${id}/file`)
      expect(file.status).toBe(200)
      expect(file.headers['content-disposition']).toBe('attachment; filename="leave-policy-2026.pdf"')
    }
  })

  it('are not published or removed by an employee or a manager', async () => {
    for (const who of ['esha', 'manager'] as const) {
      const res = await request(app).post('/api/company-documents').set('Authorization', as(who)).field('title', 'Mine').attach('file', PDF, { filename: 'x.pdf', contentType: 'application/pdf' })
      expect(res.status).toBe(403)
      expect((await del(who, `/api/company-documents/${id}`)).status).toBe(403)
    }
  })

  it('are withdrawn by HR', async () => {
    expect((await del('hr', `/api/company-documents/${id}`)).status).toBe(200)
    expect((await get('esha', '/api/company-documents')).body.data.map((d: { id: string }) => d.id)).not.toContain(id)
    expect((await get('esha', `/api/company-documents/${id}/file`)).status).toBe(404)
  })
})
