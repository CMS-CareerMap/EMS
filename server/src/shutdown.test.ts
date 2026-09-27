import { describe, it, expect, vi } from 'vitest'
import { shutdownGracefully, type ShutdownDeps } from './shutdown'

function deps(overrides: Partial<ShutdownDeps> = {}) {
  const order: string[] = []
  const d: ShutdownDeps = {
    closeServer: (done) => {
      order.push('server closed')
      done()
    },
    disconnect: async () => {
      order.push('database closed')
    },
    exit: (code) => {
      order.push(`exit ${code}`)
    },
    log: () => {},
    ...overrides,
  }
  return { d, order }
}

const settle = () => new Promise((resolve) => setImmediate(resolve))

describe('stopping the server', () => {
  it('finishes requests, then closes the database, then exits cleanly', async () => {
    const { d, order } = deps()
    shutdownGracefully('SIGTERM', d)
    await settle()

    expect(order).toEqual(['server closed', 'database closed', 'exit 0'])
  })

  it('still closes the database when the listener reports an error, and says so in the exit code', async () => {
    const { d, order } = deps({
      closeServer: (done) => {
        order.push('server closed')
        done(new Error('not running'))
      },
    })
    shutdownGracefully('SIGINT', d)
    await settle()

    expect(order).toEqual(['server closed', 'database closed', 'exit 1'])
  })

  it('exits with 1 when the database will not close', async () => {
    const log = vi.fn()
    const { d, order } = deps({ disconnect: async () => Promise.reject(new Error('socket hang up')), log })
    shutdownGracefully('SIGTERM', d)
    await settle()

    expect(order).toEqual(['server closed', 'exit 1'])
    expect(log).toHaveBeenCalledWith(expect.stringContaining('did not close cleanly'))
  })

  it('stops anyway when a request never finishes', async () => {
    vi.useFakeTimers()
    try {
      const { d, order } = deps({ closeServer: () => order.push('waiting for a request that never ends'), forceAfterMs: 500 })
      shutdownGracefully('SIGTERM', d)
      vi.advanceTimersByTime(500)

      expect(order).toEqual(['waiting for a request that never ends', 'exit 1'])
    } finally {
      vi.useRealTimers()
    }
  })
})
