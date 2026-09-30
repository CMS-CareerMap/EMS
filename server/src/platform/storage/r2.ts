import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3'
import type { StorageService, StoredObject } from './index'

/**
 * Cloudflare R2 — where production keeps every file.
 *
 * R2 speaks the S3 API, so this is the ordinary AWS client pointed at R2's
 * endpoint. Downloads cost nothing on R2, which matters here: employees fetch
 * payslips and documents constantly, and on S3 every one of those is billed.
 *
 * The bucket is PRIVATE. Nothing is ever served from an R2 URL; every file goes
 * out through an authenticated API route that checks who is asking (§A12).
 */

export interface R2Config {
  accountId: string
  accessKeyId: string
  secretAccessKey: string
  bucket: string
  /** Defaults to the account's own endpoint; set it only for a jurisdiction-specific one. */
  endpoint?: string | undefined
}

/** The one method this needs from the client — narrowed so a test can stand in for it. */
export interface S3Like {
  send(command: object): Promise<unknown>
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404
}

export class R2Storage implements StorageService {
  private readonly client: S3Like
  private readonly bucket: string

  constructor(config: R2Config, client?: S3Like) {
    this.bucket = config.bucket
    this.client =
      client ??
      new S3Client({
        region: 'auto',
        endpoint: config.endpoint ?? `https://${config.accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      })
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }),
    )
  }

  async get(key: string): Promise<Buffer> {
    const result = (await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> }
    }
    if (!result.Body) throw new Error(`Storage returned no body for ${key}`)
    return Buffer.from(await result.Body.transformToByteArray())
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
    } catch (err) {
      // Deleting something already gone is success, as on disk.
      if (!isNotFound(err)) throw err
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return true
    } catch (err) {
      if (isNotFound(err)) return false
      throw err
    }
  }

  async list(prefix: string): Promise<StoredObject[]> {
    const out: StoredObject[] = []
    let token: string | undefined
    do {
      const page = (await this.client.send(
        new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }),
      )) as {
        Contents?: { Key?: string; LastModified?: Date; Size?: number }[]
        IsTruncated?: boolean
        NextContinuationToken?: string
      }
      for (const item of page.Contents ?? []) {
        if (item.Key) out.push({ key: item.Key, lastModified: item.LastModified ?? new Date(0), bytes: item.Size ?? 0 })
      }
      const next = page.IsTruncated ? page.NextContinuationToken : undefined
      // A page that says "more" but gives no new place to continue from would
      // loop for ever — and the nightly sweep with it. Stop, loudly.
      if (page.IsTruncated && (!next || next === token)) {
        throw new Error(`Listing ${prefix} did not advance: the storage returned no new continuation token`)
      }
      token = next
    } while (token)
    return out
  }
}
