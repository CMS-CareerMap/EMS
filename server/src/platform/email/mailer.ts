import nodemailer, { type Transporter } from 'nodemailer'
import { env } from '../../config/env'

/**
 * Sending email (client §45) through the company's own mail account, set in
 * the server's environment. Off until SMTP_HOST and SMTP_FROM are set: then
 * nothing is queued, nothing is sent, and the app's bell carries every notice
 * as before.
 */

export function emailReady(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM)
}

/** Who the mail says it is from — shown in Settings, never the password. */
export function emailFrom(): string | null {
  return emailReady() ? (env.SMTP_FROM ?? null) : null
}

let transport: Transporter | null = null

function transporter(): Transporter {
  transport ??= nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS ?? '' } } : {}),
    // A mail server that does not answer delays the queue, never the app.
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 30_000,
  })
  return transport
}

export async function sendMail(message: { to: string; subject: string; text: string }): Promise<void> {
  await transporter().sendMail({ from: env.SMTP_FROM, to: message.to, subject: message.subject, text: message.text })
}

/** A full link into the app for a notice's path ("/requests?tab=decide"). */
export function appLink(path: string | null | undefined): string {
  const base = env.APP_URL ?? env.CORS_ORIGIN
  return path ? new URL(path, base).toString() : base
}
