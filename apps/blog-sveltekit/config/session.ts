import { defineSessionConfig, env } from '@holo-js/config'

const configuredSessionSameSite = env('SESSION_SAME_SITE')
const sessionSameSite = configuredSessionSameSite === 'strict'
  || configuredSessionSameSite === 'lax'
  || configuredSessionSameSite === 'none'
  ? configuredSessionSameSite
  : 'lax'
const sessionSecure = sessionSameSite === 'none'
  ? true
  : env('SESSION_SECURE', false)

export default defineSessionConfig({
  driver: env('SESSION_DRIVER', 'file'),
  stores: {
    database: {
      driver: 'database',
      connection: env('SESSION_CONNECTION', 'main'),
      table: 'sessions',
    },
    file: {
      driver: 'file',
      path: './storage/framework/sessions',
    },
  },
  cookie: {
    name: env('SESSION_COOKIE', 'holo_session'),
    path: env('SESSION_PATH', '/'),
    domain: env('SESSION_DOMAIN'),
    secure: sessionSecure,
    httpOnly: true,
    sameSite: sessionSameSite,
  },
  idleTimeout: env('SESSION_IDLE_TIMEOUT', 120),
  absoluteLifetime: env('SESSION_LIFETIME', 120),
  rememberMeLifetime: env('SESSION_REMEMBER_ME_LIFETIME', 43200),
})
