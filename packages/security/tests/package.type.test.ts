import { describe, it } from 'vitest'
import {
  clearRateLimit,
  csrf,
  createFileRateLimitStore,
  createFileRateLimitStoreConfig,
  createMemoryRateLimitStore,
  defaultRateLimitKey,
  defineSecurityConfig,
  ip,
  limit,
  protect,
  rateLimit,
  createRedisRateLimitStore,
  type HoloSecurityConfig,
  type SecurityLimiterConfig,
  type SecurityRateLimitFileConfig,
  type SecurityRateLimitHitResult,
  type SecurityRateLimitRedisDriverAdapter,
  type SecurityRateLimitStore,
} from '../src'

describe('@holo-js/security typing', () => {
  it('preserves config and limiter inference without manual generics', () => {
    type Expect<TValue extends true> = TValue
    type Equal<TLeft, TRight>
      = (<TValue>() => TValue extends TLeft ? 1 : 2) extends (<TValue>() => TValue extends TRight ? 1 : 2)
        ? ((<TValue>() => TValue extends TRight ? 1 : 2) extends (<TValue>() => TValue extends TLeft ? 1 : 2) ? true : false)
        : false

    const login = limit.perMinute(5).by(({ request, values }) => {
      const derivedIp: string = ip(request, true)
      const email = values?.email
      void derivedIp
      return `${derivedIp}:${String(email ?? 'guest')}`
    })
    const register = limit.perMinute(3).by(async ({ request }) => {
      return await defaultRateLimitKey(request)
    })
    const config = defineSecurityConfig({
      csrf: {
        enabled: true,
      },
      rateLimit: {
        driver: 'file',
        file: createFileRateLimitStoreConfig({
          path: './storage/framework/rate-limits',
        }),
        limiters: {
          login,
          register,
        },
      },
    })

    type ConfigAssertion = Expect<Equal<typeof config, Readonly<{
      csrf: {
        enabled: true
      }
      rateLimit: {
        driver: 'file'
        file: Readonly<SecurityRateLimitFileConfig>
        limiters: {
          login: SecurityLimiterConfig
          register: SecurityLimiterConfig
        }
      }
    }>>>

    const exported: HoloSecurityConfig = config
    const tokenPromiseFactory: (request: Request) => Promise<string> = csrf.token
    const protectPromiseFactory: (request: Request, options?: { readonly csrf?: boolean, readonly throttle?: string }) => Promise<void> = protect
    const rateLimitPromiseFactory: (name: string, options: { readonly request?: Request, readonly key?: string, readonly values?: Readonly<Record<string, unknown>> }) => Promise<SecurityRateLimitHitResult> = rateLimit
    const clearRateLimitPromiseFactory: (options: { readonly limiter?: string, readonly key?: string, readonly all?: boolean }) => Promise<boolean | number> = clearRateLimit
    const memoryStoreFactory: () => SecurityRateLimitStore = () => createMemoryRateLimitStore()
    const fileStoreFactory: (root: string) => SecurityRateLimitStore = root => createFileRateLimitStore(root)
    const redisAdapter: SecurityRateLimitRedisDriverAdapter = {
      async increment() {
        return {
          attempts: 1,
          ttlSeconds: 60,
        }
      },
      async del() {
        return 1
      },
    }
    const redisStoreFactory: (adapter: SecurityRateLimitRedisDriverAdapter) => SecurityRateLimitStore = adapter => createRedisRateLimitStore(adapter)
    const store: SecurityRateLimitStore = {
      async hit(key, options) {
        return {
          limited: false,
          snapshot: {
            limiter: 'login',
            key,
            attempts: 1,
            maxAttempts: options.maxAttempts,
            remainingAttempts: options.maxAttempts - 1,
            expiresAt: new Date(),
          },
          retryAfterSeconds: options.decaySeconds,
        }
      },
      async clear() {
        return true
      },
      async clearByPrefix() {
        return 1
      },
      async clearAll() {
        return 1
      },
    }

    // @ts-expect-error Unsupported drivers must fail typing.
    defineSecurityConfig({ rateLimit: { driver: 'database' } })

    void exported
    void tokenPromiseFactory
    void protectPromiseFactory
    void rateLimitPromiseFactory
    void clearRateLimitPromiseFactory
    void memoryStoreFactory
    void fileStoreFactory
    void redisAdapter
    void redisStoreFactory
    void store
    void (0 as unknown as ConfigAssertion)
  })
})
