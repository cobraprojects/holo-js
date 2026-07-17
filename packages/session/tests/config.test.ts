import { describe, expect, it } from 'vitest'
import { composeRegisteredConfig } from '@holo-js/config/registry'
import { normalizeRedisConfig } from '@holo-js/kernel'
import {
  defineSessionConfig,
  holoSessionDefaults,
  normalizeSessionConfig,
} from '../src'

const redisConfig = normalizeRedisConfig({
  default: 'main',
  connections: {
    main: {
      url: 'redis://user:secret@redis.test:6380/4',
    },
    cluster: {
      clusters: [
        { host: 'redis-a.test', port: 6379 },
        { url: 'redis://redis-b.test:6380' },
      ],
    },
  },
})

describe('@holo-js/session config', () => {
  it('returns immutable defaults and defines config', () => {
    expect(normalizeSessionConfig()).toEqual(holoSessionDefaults)
    expect(Object.isFrozen(defineSessionConfig({ driver: 'file' }))).toBe(true)
  })

  it('normalizes file, database, and Redis stores with cookie options', () => {
    const normalized = normalizeSessionConfig({
      driver: ' redis ',
      stores: {
        file: { driver: 'file', path: ' ./sessions ' },
        database: { driver: 'database', connection: ' analytics ', table: ' user_sessions ' },
        redis: { driver: 'redis', prefix: ' session: ' },
        cluster: { driver: 'redis', connection: 'cluster' },
      },
      cookie: {
        name: ' app_session ',
        path: ' /admin ',
        domain: ' example.test ',
        secure: true,
        httpOnly: false,
        sameSite: 'none',
        partitioned: true,
        maxAge: '60',
      },
      idleTimeout: '15',
      absoluteLifetime: 30,
      rememberMeLifetime: '1440',
    }, redisConfig)

    expect(normalized).toMatchObject({
      driver: 'redis',
      stores: {
        file: { path: './sessions' },
        database: { connection: 'analytics', table: 'user_sessions' },
        redis: {
          connection: 'main',
          url: 'redis://user:secret@redis.test:6380/4',
          host: '127.0.0.1',
          port: 6379,
          username: undefined,
          password: undefined,
          db: 4,
          prefix: 'session:',
        },
        cluster: { connection: 'cluster', clusters: expect.any(Array) },
      },
      cookie: {
        name: 'app_session',
        path: '/admin',
        domain: 'example.test',
        secure: true,
        httpOnly: false,
        sameSite: 'none',
        partitioned: true,
        maxAge: 60,
      },
      idleTimeout: 15,
      absoluteLifetime: 30,
      rememberMeLifetime: 1440,
    })
  })

  it('uses store and cookie fallbacks', () => {
    expect(normalizeSessionConfig({
      stores: {
        custom: { driver: 'file' },
        database: { driver: 'database' },
      },
      cookie: {
        name: ' ',
        path: ' ',
        domain: ' ',
      },
    })).toMatchObject({
      driver: 'custom',
      stores: {
        custom: { path: './storage/framework/sessions' },
        database: { connection: 'default', table: 'sessions' },
      },
      cookie: {
        name: 'holo_session',
        path: '/',
        domain: undefined,
        secure: false,
        httpOnly: true,
        sameSite: 'lax',
        partitioned: false,
      },
    })
  })

  it('rejects malformed stores, lifetimes, and cookie security combinations', () => {
    expect(() => normalizeSessionConfig({ stores: { ' ': { driver: 'file' } } })).toThrow('store name')
    expect(() => normalizeSessionConfig({ stores: { unsupported: { driver: 'memory' as never } } })).toThrow('Unsupported session store')
    expect(() => normalizeSessionConfig({ driver: 'missing' })).toThrow('default session driver')
    expect(() => normalizeSessionConfig({ idleTimeout: ' ' })).toThrow('must be an integer')
    expect(() => normalizeSessionConfig({ idleTimeout: 1.5 })).toThrow('must be an integer')
    expect(() => normalizeSessionConfig({ idleTimeout: -1 })).toThrow('greater than or equal to 0')
    expect(() => normalizeSessionConfig({ cookie: { sameSite: 'invalid' as never } })).toThrow('cookie sameSite')
    expect(() => normalizeSessionConfig({ cookie: { sameSite: 'none' } })).toThrow('requires secure')
    expect(() => normalizeSessionConfig({ cookie: { partitioned: true } })).toThrow('partitioned cookies require secure')
  })

  it('rejects Redis stores without valid shared configuration', () => {
    expect(() => normalizeSessionConfig({
      stores: { redis: { driver: 'redis' } },
    })).toThrow('requires a top-level Redis default')
    expect(() => normalizeSessionConfig({
      stores: { redis: { driver: 'redis', connection: 'main' } },
    })).toThrow('without top-level Redis config')
    expect(() => normalizeSessionConfig({
      stores: { redis: { driver: 'redis', connection: 'missing' } },
    }, redisConfig)).toThrow('missing')
  })

  it('composes session config with present and absent Redis context', () => {
    const session = { stores: { redis: { driver: 'redis' as const } } }
    const composed = composeRegisteredConfig({ session, redis: {} }, { redis: redisConfig })
    const normalizedSession = composed.session as ReturnType<typeof normalizeSessionConfig> | undefined
    expect(normalizedSession?.stores.redis)
      .toMatchObject({ connection: 'main' })
    expect(() => composeRegisteredConfig({ session }, { redis: redisConfig }))
      .toThrow('requires a top-level Redis default')
  })
})
