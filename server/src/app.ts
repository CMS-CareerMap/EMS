import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import cookieParser from 'cookie-parser'

import { env } from './config/env'
import { requestContext } from './http/middleware/requestContext'
import { errorHandler, notFound } from './http/middleware/errorHandler'
import { authRouter } from './http/routes/auth.routes'
import { employeeRouter } from './http/routes/employee.routes'
import { userRouter } from './http/routes/user.routes'
import { settingsRouter } from './http/routes/settings.routes'
import { attendanceRouter } from './http/routes/attendance.routes'
import { leaveRouter } from './http/routes/leave.routes'
import { dashboardRouter } from './http/routes/dashboard.routes'
import { payrollRouter } from './http/routes/payroll.routes'
import { masterDataRouter } from './http/routes/masterData.routes'
import { holidaysRouter } from './http/routes/holidays.routes'

/**
 * Assembles the app but does not listen. main.ts owns the port, so tests can
 * import createApp() and drive it with supertest without binding a socket.
 */
export function createApp() {
  const app = express()

  app.disable('x-powered-by')

  // In production Nginx sits in front, so req.ip would otherwise be the proxy
  // itself — every visitor sharing one rate-limit bucket. '1' means trust
  // exactly one hop: our own Nginx, and nothing a client can forge beyond it.
  if (env.NODE_ENV === 'production') {
    app.set('trust proxy', 1)
  }

  app.use(helmet())
  app.use(cors({ origin: env.CORS_ORIGIN, credentials: true }))
  // 1 MB everywhere, except the CSV import — a 1 MB roster becomes larger
  // than 1 MB once it is a JSON string, because quotes and newlines are
  // escaped. That route parses its own body at 2 MB and enforces the real
  // limit on the DECODED csv, where the number means what the person
  // uploading thinks it means.
  const parseJson = express.json({ limit: '1mb' })
  app.use((req, res, next) =>
    req.path === '/api/employees/import' || req.path === '/api/attendance/import'
      ? next()
      : parseJson(req, res, next),
  )
  app.use(cookieParser())
  app.use(requestContext)

  app.get('/health', (_req, res) => {
    res.json({
      data: { status: 'ok', env: env.NODE_ENV },
      meta: { requestId: res.locals.requestId },
    })
  })

  app.use('/api/auth', authRouter)
  app.use('/api/employees', employeeRouter)
  app.use('/api/users', userRouter)
  app.use('/api/settings', settingsRouter)
  app.use('/api/attendance', attendanceRouter)
  app.use('/api/leave-requests', leaveRouter)
  app.use('/api/dashboard', dashboardRouter)
  app.use('/api/payroll', payrollRouter)
  app.use('/api/master-data', masterDataRouter)
  app.use('/api/holidays', holidaysRouter)

  // Express 5 uses path-to-regexp v8: a bare '*' throws at startup.
  app.use('/{*splat}', notFound)

  // Error middleware must be registered last.
  app.use(errorHandler)

  return app
}
