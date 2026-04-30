import { defineSessionConfig, env } from '@holo-js/config'

const sessionSameSite = env('SESSION_SAME_SITE') === 'strict'
  ? 'strict'
  : env('SESSION_SAME_SITE') === 'none'
    ? 'none'
    : 'lax'

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
    secure: env('SESSION_SECURE', false),
    httpOnly: true,
    sameSite: sessionSameSite,
  },
  idleTimeout: env('SESSION_IDLE_TIMEOUT', 120),
  absoluteLifetime: env('SESSION_LIFETIME', 120),
  rememberMeLifetime: env('SESSION_REMEMBER_ME_LIFETIME', 43200),
})
