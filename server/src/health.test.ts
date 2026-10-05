import { describe, it, expect, vi, afterEach } from 'vitest'
import request from 'supertest'
import { createApp } from './app'
import { databaseAnswers } from './platform/db/health'

/**
 * /health is what Docker's health check and deploy/deploy.sh wait on, so it
 * must say "not healthy" when the database cannot be reached — not merely
 * whether the process is up.
 */
vi.mock('./platform/db/health', async (original) => ({
  ...(await original<typeof import('./platform/db/health')>()),
  databaseAnswers: vi.fn(),
}))

const answers = vi.mocked(databaseAnswers)

describe('/health', () => {
  afterEach(() => answers.mockReset())

  it('is ok when the database answers', async () => {
    answers.mockResolvedValue(true)
    const res = await request(createApp()).get('/health')
    expect(res.status).toBe(200)
    expect(res.body.data.status).toBe('ok')
  })

  it('is 503, in the error envelope, when it does not', async () => {
    answers.mockResolvedValue(false)
    const res = await request(createApp()).get('/health')
    expect(res.status).toBe(503)
    expect(res.body.error.code).toBe('DATABASE_UNAVAILABLE')
    expect(res.body.error.requestId).toEqual(expect.any(String))
  })
})

describe('databaseAnswers', () => {
  it('is true against the test database', async () => {
    const real = await vi.importActual<typeof import('./platform/db/health')>('./platform/db/health')
    expect(await real.databaseAnswers()).toBe(true)
  })
})
