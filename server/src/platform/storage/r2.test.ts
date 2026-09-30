import { describe, it, expect } from 'vitest'
import { R2Storage, type S3Like } from './r2'

/**
 * The R2 driver against a stand-in for the S3 client: every call it makes, and
 * how it reads R2's answers. The real bucket is checked with
 * `npm run storage:check` once the company's keys exist.
 */

type Sent = { name: string; input: Record<string, unknown> }

function fakeClient(answer: (cmd: Sent) => unknown): { client: S3Like; sent: Sent[] } {
  const sent: Sent[] = []
  return {
    sent,
    client: {
      async send(command: object) {
        const c = command as { constructor: { name: string }; input: Record<string, unknown> }
        const call = { name: c.constructor.name, input: c.input }
        sent.push(call)
        const result = answer(call)
        if (result instanceof Error) throw result
        return result
      },
    },
  }
}

const config = { accountId: 'acc', accessKeyId: 'k', secretAccessKey: 's', bucket: 'hrms' }
const notFound = () => Object.assign(new Error('not found'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } })

describe('the R2 driver', () => {
  it('writes into the bucket with the type and length', async () => {
    const { client, sent } = fakeClient(() => ({}))
    await new R2Storage(config, client).put('org/1/a.pdf', Buffer.from('%PDF-1'), 'application/pdf')
    expect(sent[0]).toMatchObject({ name: 'PutObjectCommand', input: { Bucket: 'hrms', Key: 'org/1/a.pdf', ContentType: 'application/pdf', ContentLength: 6 } })
  })

  it('reads the bytes back', async () => {
    const { client } = fakeClient(() => ({ Body: { transformToByteArray: async () => new Uint8Array([1, 2, 3]) } }))
    expect(await new R2Storage(config, client).get('k')).toEqual(Buffer.from([1, 2, 3]))
  })

  it('treats deleting something already gone as done', async () => {
    const { client } = fakeClient(() => notFound())
    await expect(new R2Storage(config, client).delete('gone')).resolves.toBeUndefined()
  })

  it('says a missing object does not exist, and passes on any other failure', async () => {
    expect(await new R2Storage(config, fakeClient(() => notFound()).client).exists('x')).toBe(false)
    expect(await new R2Storage(config, fakeClient(() => ({})).client).exists('x')).toBe(true)
    const denied = Object.assign(new Error('denied'), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
    await expect(new R2Storage(config, fakeClient(() => denied).client).exists('x')).rejects.toThrow('denied')
  })

  it('lists every page of a prefix', async () => {
    const pages = [
      { Contents: [{ Key: 'org/1/a', LastModified: new Date('2026-09-01'), Size: 10 }], IsTruncated: true, NextContinuationToken: 't2' },
      { Contents: [{ Key: 'org/1/b', LastModified: new Date('2026-09-02'), Size: 20 }], IsTruncated: false },
    ]
    const { client, sent } = fakeClient(() => pages.shift())
    const listed = await new R2Storage(config, client).list('org/1/')
    expect(listed.map((o) => o.key)).toEqual(['org/1/a', 'org/1/b'])
    expect(sent[1]?.input).toMatchObject({ Prefix: 'org/1/', ContinuationToken: 't2' })
  })

  it('stops, rather than looping for ever, when a page says "more" but does not move on', async () => {
    const same = { Contents: [{ Key: 'org/1/a', LastModified: new Date('2026-09-01'), Size: 10 }], IsTruncated: true, NextContinuationToken: 't2' }
    const { client, sent } = fakeClient(() => same)
    await expect(new R2Storage(config, client).list('org/1/')).rejects.toThrow('did not advance')
    expect(sent.length).toBe(2)

    const { client: noToken } = fakeClient(() => ({ Contents: [], IsTruncated: true }))
    await expect(new R2Storage(config, noToken).list('org/1/')).rejects.toThrow('did not advance')
  })
})
