import { defineMailConfig, env } from '@holo-js/config'

export default defineMailConfig({
  default: env('MAIL_MAILER', 'preview'),
  from: {
    email: env('MAIL_FROM_ADDRESS', 'hello@app.test'),
    name: env('MAIL_FROM_NAME', 'Holo App'),
  },
  preview: {
    allowedEnvironments: ['development'],
  },
  mailers: {
    preview: {
      driver: 'preview',
    },
    log: {
      driver: 'log',
    },
    fake: {
      driver: 'fake',
    },
    smtp: {
      driver: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: env('MAIL_PORT', 1025),
      secure: env('MAIL_SECURE', false),
    },
  },
})
