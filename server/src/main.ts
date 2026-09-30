import { createApp } from './app'
import { env } from './config/env'
import { disconnect } from './platform/db/prisma'
import { shutdownGracefully } from './shutdown'

const host = env.HOST ?? (env.NODE_ENV === 'production' ? '127.0.0.1' : '0.0.0.0')

const server = createApp().listen(env.PORT, host, () => {
  console.log(`  EMS server  http://${host === '0.0.0.0' ? 'localhost' : host}:${env.PORT}  [${env.NODE_ENV}]`)
})

function stop(signal: string) {
  shutdownGracefully(signal, {
    closeServer: (done) => server.close(done),
    disconnect,
    exit: (code) => process.exit(code),
    log: (message) => console.log(`\n  ${message}`),
  })
}

process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGTERM', () => stop('SIGTERM'))
