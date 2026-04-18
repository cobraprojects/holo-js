import { describe, it } from 'vitest'
import {
  createConfigAccessors,
  defineAuthConfig,
  defineBroadcastConfig,
  defineConfig,
  defineMailConfig,
  defineNotificationsConfig,
  defineQueueConfig,
  defineSecurityConfig,
  defineSessionConfig,
  type DotPath,
  type HoloAppEnv,
  type HoloConfigRegistry,
} from '../src'

declare module '../src/types' {
  interface HoloConfigRegistry {
    services: {
      mailgun: {
        secret: string
      }
    }
  }
}

describe('@holo-js/config typing', () => {
  it('preserves inference for file-level and string-path access', () => {
    const services = defineConfig({
      mailgun: {
        secret: 'secret',
      },
    })
    const queue = defineQueueConfig({
      default: 'sync',
      connections: {
        sync: {
          driver: 'sync',
        },
      },
    })
    const broadcast = defineBroadcastConfig({
      default: 'null',
      connections: {
        null: {
          driver: 'null',
        },
      },
    })
    const notifications = defineNotificationsConfig({
      table: 'notifications',
      queue: {
        connection: 'redis',
        queue: 'notifications',
        afterCommit: true,
      },
    })
    const mail = defineMailConfig({
      default: 'preview',
      mailers: {
        preview: {
          driver: 'preview',
          path: '.holo-js/runtime/mail-preview',
        },
      },
    })
    const session = defineSessionConfig({
      driver: 'database',
      cookie: {
        path: '/',
      },
    })
    const security = defineSecurityConfig({
      csrf: {
        enabled: true,
      },
      rateLimit: {
        driver: 'memory',
      },
    })
    const auth = defineAuthConfig({
      guards: {
        web: {
          driver: 'session',
          provider: 'users',
        },
      },
      providers: {
        users: {
          model: 'User',
          identifiers: ['email', 'phone'],
        },
      },
      social: {
        google: {
          runtime: '@holo-js/auth-social-google',
          clientId: 'google-client',
          redirectUri: 'https://app.test/auth/google/callback',
          scopes: ['openid', 'email'],
          guard: 'web',
          encryptTokens: true,
        },
      },
      workos: {
        dashboard: {
          clientId: 'workos-client',
          sessionCookie: 'workos-session',
          guard: 'web',
        },
      },
      clerk: {
        admin: {
          publishableKey: 'pk_test',
          sessionCookie: '__session',
          guard: 'web',
        },
      },
    })
    const accessors = createConfigAccessors({
      app: {} as HoloConfigRegistry['app'],
      database: {} as HoloConfigRegistry['database'],
      storage: {} as HoloConfigRegistry['storage'],
      queue: queue as unknown as HoloConfigRegistry['queue'],
      broadcast: broadcast as unknown as HoloConfigRegistry['broadcast'],
      mail: mail as unknown as HoloConfigRegistry['mail'],
      notifications: notifications as unknown as HoloConfigRegistry['notifications'],
      media: {} as HoloConfigRegistry['media'],
      session: session as unknown as HoloConfigRegistry['session'],
      security: security as unknown as HoloConfigRegistry['security'],
      auth: auth as unknown as HoloConfigRegistry['auth'],
      services,
    })

    const loadedServices: {
      mailgun: {
        secret: string
      }
    } = accessors.useConfig('services')
    const nestedSecret: string = accessors.useConfig('services.mailgun.secret')
    const secret: string = accessors.config('services.mailgun.secret')
    const sessionDriver: string = accessors.useConfig('session.driver')
    const csrfField: string = accessors.useConfig('security.csrf.field')
    const authDefaultGuard: string = accessors.useConfig('auth.defaults.guard')
    const socialRedirectUri = accessors.useConfig('auth.social.google.redirectUri') as string | undefined
    const workosSessionCookie = accessors.useConfig('auth.workos.dashboard.sessionCookie') as string | undefined
    const clerkSessionCookie = accessors.useConfig('auth.clerk.admin.sessionCookie') as string | undefined
    const nestedPath: DotPath<{
      app: HoloConfigRegistry['app']
      database: HoloConfigRegistry['database']
      storage: HoloConfigRegistry['storage']
      queue: HoloConfigRegistry['queue']
      broadcast: HoloConfigRegistry['broadcast']
      mail: HoloConfigRegistry['mail']
      notifications: HoloConfigRegistry['notifications']
      media: HoloConfigRegistry['media']
      session: HoloConfigRegistry['session']
      security: HoloConfigRegistry['security']
      auth: HoloConfigRegistry['auth']
      services: typeof services
    }> = 'services.mailgun.secret'
    const queueDefault: string = accessors.useConfig('queue.default')
    const broadcastDefault: string = accessors.useConfig('broadcast.default')
    const mailDefault: string = accessors.useConfig('mail.default')
    const notificationsTable: string = accessors.useConfig('notifications.table')
    const testEnv: HoloAppEnv = 'test'

    // @ts-expect-error Arrays should be treated as terminal values for dot-path autocomplete.
    const arrayMethodPath: DotPath<HoloConfigRegistry['app']> = 'models.length'

    void loadedServices
    void nestedSecret
    void secret
    void sessionDriver
    void csrfField
    void authDefaultGuard
    void socialRedirectUri
    void workosSessionCookie
    void clerkSessionCookie
    void nestedPath
    void queueDefault
    void broadcastDefault
    void mailDefault
    void notificationsTable
    void testEnv
    void arrayMethodPath
  })
})
