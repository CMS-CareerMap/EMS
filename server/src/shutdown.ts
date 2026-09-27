/**
 * Stopping the server without cutting anything off.
 *
 *   1. Stop accepting connections; let requests already running finish.
 *   2. Close the database pool. Left open, it is connections the database keeps
 *      holding for a process that no longer exists, until it gives up on them.
 *   3. Exit — 0 if all of that happened, 1 if it had to be forced.
 *
 * Its own function, with everything it touches passed in, so it can be tested:
 * Windows has no SIGTERM to send a test process.
 */

export interface ShutdownDeps {
  closeServer: (done: (err?: Error) => void) => void
  disconnect: () => Promise<void>
  exit: (code: number) => void
  log: (message: string) => void
  /** Past this, exit anyway: a request that never ends must not keep the old process alive. */
  forceAfterMs?: number
}

export function shutdownGracefully(signal: string, deps: ShutdownDeps): void {
  deps.log(`${signal} received — finishing requests in flight, then stopping`)

  const force = setTimeout(() => {
    deps.log('Requests still open after the grace period; stopping anyway')
    deps.exit(1)
  }, deps.forceAfterMs ?? 10_000)
  force.unref()

  deps.closeServer((err) => {
    deps
      .disconnect()
      .then(
        () => {
          clearTimeout(force)
          deps.exit(err ? 1 : 0)
        },
        (disconnectError: unknown) => {
          clearTimeout(force)
          deps.log(`The database did not close cleanly: ${String(disconnectError)}`)
          deps.exit(1)
        },
      )
  })
}
