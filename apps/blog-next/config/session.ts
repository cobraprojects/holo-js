import { defineSessionConfig, env } from '@holo-js/config'

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
    secure: env<boolean>('SESSION_SECURE', false),
    httpOnly: true,
    sameSite: env<'lax' | 'strict' | 'none'>('SESSION_SAME_SITE', 'lax'),
  },
  idleTimeout: env('SESSION_IDLE_TIMEOUT', 120),
  absoluteLifetime: env('SESSION_LIFETIME', 120),
  rememberMeLifetime: env('SESSION_REMEMBER_ME_LIFETIME', 43200),
})
