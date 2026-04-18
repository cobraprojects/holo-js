import { access, mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as securityExports from '../src'
import security, {
  clearRateLimit,
  configureSecurityRuntime,
  createFileRateLimitStore,
  createFileRateLimitStoreConfig,
  createMemoryRateLimitStore,
  createMemoryRateLimitStoreConfig,
  createRedisRateLimitStore,
  createRedisRateLimitStoreConfig,
  csrf,
  defaultRateLimitKey,
  defineRateLimiter,
  defineSecurityConfig,
  fileRateLimitDriverInternals,
  getSecurityRuntime,
  ip,
  limit,
  memoryRateLimitDriverInternals,
  protect,
  rateLimit,
  redisRateLimitDriverInternals,
  resetSecurityRuntime,
  SecurityCsrfError,
  SecurityRateLimitError,
  SecurityRuntimeNotConfiguredError,
  type SecurityRateLimitRedisDriverAdapter,
  type SecurityRateLimitStore,
} from '../src'
import { runRateLimitDriverContractSuite } from './support/driver-contract'

const tempDirs: string[] = []

function createMockRateLimitStore(now = new Date('2026-04-16T12:00:00.000Z')): SecurityRateLimitStore {
  const entries = new Map<string, { attempts: number, expiresAt: Date }>()

  return {
    async hit(key, options) {
      const existing = entries.get(key)
      if (existing && existing.expiresAt.getTime() <= now.getTime()) {
        entries.delete(key)
      }

      const entry = entries.get(key)
      if (!entry) {
        const created = {
          attempts: 1,
          expiresAt: new Date(now.getTime() + options.decaySeconds * 1000),
        }
        entries.set(key, created)

        return {
          limited: false,
          snapshot: {
            limiter: 'store',
            key,
            attempts: created.attempts,
            maxAttempts: options.maxAttempts,
            remainingAttempts: Math.max(0, options.maxAttempts - created.attempts),
            expiresAt: created.expiresAt,
          },
          retryAfterSeconds: options.decaySeconds,
        }
      }

      entry.attempts += 1
      return {
        limited: entry.attempts > options.maxAttempts,
        snapshot: {
          limiter: 'store',
          key,
          attempts: entry.attempts,
          maxAttempts: options.maxAttempts,
          remainingAttempts: Math.max(0, options.maxAttempts - entry.attempts),
          expiresAt: entry.expiresAt,
        },
        retryAfterSeconds: Math.max(0, Math.ceil((entry.expiresAt.getTime() - now.getTime()) / 1000)),
      }
    },
    async clear(key) {
      return entries.delete(key)
    },
    async clearByPrefix(prefix) {
      let cleared = 0

      for (const key of entries.keys()) {
        if (!key.startsWith(prefix)) {
          continue
        }

        entries.delete(key)
        cleared += 1
      }

      return cleared
    },
    async clearAll() {
      const size = entries.size
      entries.clear()
      return size
    },
  }
}

afterEach(() => {
  resetSecurityRuntime()
})

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('@holo-js/security package surface', () => {
  it('keeps redis as an optional peer for non-redis installs', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      peerDependencies?: Record<string, string>
      peerDependenciesMeta?: Record<string, { optional?: boolean }>
    }

    expect(packageJson.peerDependencies?.ioredis).toBe('^5.4.2')
    expect(packageJson.peerDependenciesMeta?.ioredis?.optional).toBe(true)
  })

  it('ships built artifacts for every published export target', async () => {
    const packageJson = JSON.parse(await readFile(
      new URL('../package.json', import.meta.url),
      'utf8',
    )) as {
      exports?: Record<string, string | {
        types?: string
        import?: string
        default?: string
      }>
    }

    const exportTargets = Object.values(packageJson.exports ?? {})
      .flatMap((entry) => {
        if (typeof entry === 'string') {
          return [entry]
        }

        return [
          entry.types,
          entry.import,
          entry.default,
        ].filter((value): value is string => typeof value === 'string')
      })

    await Promise.all(exportTargets.map(async (target) => {
      await expect(access(new URL(`..${target.slice(1)}`, import.meta.url))).resolves.toBeUndefined()
    }))
  })

  it('exports the package helpers and runtime seam', async () => {
    const limiter = limit.perMinute(5).by(({ request, values }) => {
      return `${ip(request, true)}:${String(values?.email ?? 'guest')}`
    })
    const config = defineSecurityConfig({
      csrf: {
        enabled: true,
      },
      rateLimit: {
        driver: 'file',
        limiters: {
          login: limiter,
        },
      },
    })

    expect(config.csrf?.enabled).toBe(true)
    expect(Object.isFrozen(config)).toBe(true)
    expect(createMemoryRateLimitStoreConfig()).toEqual({})
    expect(createFileRateLimitStoreConfig({ path: './tmp/rate-limits' })).toEqual({
      path: './tmp/rate-limits',
    })
    expect(createRedisRateLimitStoreConfig({ connection: 'cache', prefix: 'holo:' })).toEqual({
      connection: 'cache',
      prefix: 'holo:',
    })
    expect(defineRateLimiter(limiter)).toEqual(limiter)
    expect(() => defineRateLimiter({
      maxAttempts: 0,
      decaySeconds: 60,
    } as never)).toThrow('Rate limiter maxAttempts must be an integer greater than or equal to 1.')
    expect(() => defineRateLimiter({
      maxAttempts: 1,
      decaySeconds: '60',
      key: 'ip' as never,
    } as never)).toThrow('Rate limiter key resolvers must be functions.')
    expect(typeof security.configureSecurityRuntime).toBe('function')
    expect(typeof security.getSecurityRuntime).toBe('function')
    expect(typeof security.csrf.token).toBe('function')
    expect(typeof security.protect).toBe('function')
    expect(typeof security.rateLimit).toBe('function')
    expect(typeof security.clearRateLimit).toBe('function')
    expect(typeof createMemoryRateLimitStore).toBe('function')
    expect(typeof createFileRateLimitStore).toBe('function')
    expect(typeof createRedisRateLimitStore).toBe('function')
    expect(() => getSecurityRuntime()).toThrow(SecurityRuntimeNotConfiguredError)

    const store = createMockRateLimitStore()
    configureSecurityRuntime({
      config,
      rateLimitStore: store,
      csrfSigningKey: 'test-signing-key',
    })

    const request = new Request('https://app.test/form')
    const token = await csrf.token(request)
    expect(getSecurityRuntime().config.rateLimit.driver).toBe('file')
    expect(getSecurityRuntime().config.rateLimit.limiters.login?.maxAttempts).toBe(5)
    expect(getSecurityRuntime().rateLimitStore).toBe(store)
    expect(token.length).toBeGreaterThan(10)
    expect(new SecurityCsrfError().status).toBe(419)
    const rateLimitError = new SecurityRateLimitError(undefined, {
      retryAfterSeconds: 42,
      snapshot: {
        limiter: 'login',
        key: '203.0.113.7:ava@example.com',
        attempts: 6,
        maxAttempts: 5,
        remainingAttempts: 0,
        expiresAt: new Date('2026-04-16T12:01:00.000Z'),
      },
    })
    expect(rateLimitError.retryAfterSeconds).toBe(42)
    expect(rateLimitError.snapshot?.limiter).toBe('login')
    expect('normalizeSecurityConfig' in securityExports).toBe(false)
    expect('createSecurityRedisAdapter' in securityExports).toBe(false)
  })

  it('keeps the redis adapter on its dedicated subpath export', async () => {
    const redisAdapterModule = await import('../src/drivers/redis-adapter')

    expect('createSecurityRedisAdapter' in securityExports).toBe(false)
    expect(typeof redisAdapterModule.createSecurityRedisAdapter).toBe('function')
  })

  it('derives request ip and validates limiter builders', () => {
    const request = new Request('https://app.test/login', {
      headers: {
        'x-forwarded-for': '203.0.113.7, 203.0.113.8',
      },
    })

    expect(ip(request)).toBe('unknown')
    expect(ip(request, true)).toBe('203.0.113.7')
    expect(limit.perHour(10).define()).toEqual({
      maxAttempts: 10,
      decaySeconds: 3600,
    })
    expect(() => limit.perMinute(0)).toThrow('greater than or equal to 1')
  })

  it('normalizes numeric string limiter definitions before freezing them', () => {
    expect(defineRateLimiter({
      maxAttempts: '2',
      decaySeconds: '60',
    } as never)).toEqual({
      maxAttempts: 2,
      decaySeconds: 60,
    })
  })
})

describe('@holo-js/security csrf', () => {
  it('fails fast when csrf signing is used without a configured key', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
    })

    await expect(csrf.token(new Request('https://app.test/register'))).rejects.toThrow(
      'CSRF signing key is not configured',
    )
  })

  it('reuses an existing csrf cookie token and builds field and cookie helpers', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })
    const signedToken = securityExports.csrfInternals.encodeCsrfToken('cookie-token')

    const request = new Request('https://app.test/register', {
      headers: {
        cookie: `XSRF-TOKEN=${signedToken}`,
      },
    })

    await expect(csrf.token(request)).resolves.toBe(signedToken)
    await expect(csrf.field(request)).resolves.toEqual({
      name: '_token',
      value: signedToken,
    })
    await expect(csrf.cookie(request)).resolves.toBe(`XSRF-TOKEN=${encodeURIComponent(signedToken)}; Path=/; SameSite=Lax; Secure`)
  })

  it('generates tokens when no cookie is present', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    const request = new Request('http://app.test/register')
    const token = await csrf.token(request)

    expect(token.length).toBeGreaterThan(10)
    await expect(csrf.field(request)).resolves.toEqual({
      name: '_token',
      value: token,
    })
    await expect(csrf.cookie(request, token)).resolves.toBe(`XSRF-TOKEN=${encodeURIComponent(token)}; Path=/; SameSite=Lax`)
  })

  it('verifies csrf tokens from headers and form fields', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })
    const headerToken = securityExports.csrfInternals.encodeCsrfToken('header-token')

    const headerRequest = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `XSRF-TOKEN=${headerToken}`,
        'X-CSRF-TOKEN': headerToken,
      },
    })
    await expect(csrf.verify(headerRequest)).resolves.toBeUndefined()

    const formData = new FormData()
    const formToken = securityExports.csrfInternals.encodeCsrfToken('form-token')
    formData.set('_token', formToken)
    formData.set('email', 'ava@example.com')

    const formRequest = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `XSRF-TOKEN=${formToken}`,
      },
      body: formData,
    })
    await expect(csrf.verify(formRequest)).resolves.toBeUndefined()
  })

  it('rejects missing or mismatched csrf tokens with 419', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=expected',
        'X-CSRF-TOKEN': 'wrong',
      },
    }))).rejects.toMatchObject({
      status: 419,
      name: 'SecurityCsrfError',
    })

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
    }))).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('rejects forged csrf tokens that only mirror the cookie value', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: 'XSRF-TOKEN=forged-token',
        'X-CSRF-TOKEN': 'forged-token',
      },
    }))).rejects.toBeInstanceOf(SecurityCsrfError)

    const token = await csrf.token(new Request('https://app.test/login', {
      headers: {
        cookie: 'XSRF-TOKEN=forged-token',
      },
    }))

    expect(token).not.toBe('forged-token')
  })

  it('rejects malformed signed tokens and skips invalid cookie fragments', () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    expect(securityExports.csrfInternals.parseCookieHeader('broken; XSRF-TOKEN=value')).toEqual({
      'XSRF-TOKEN': 'value',
    })
    expect(securityExports.csrfInternals.parseCookieHeader('tracking=%; XSRF-TOKEN=value')).toEqual({
      'XSRF-TOKEN': 'value',
    })
    expect(securityExports.csrfInternals.decodeCsrfToken('missing-separator')).toBeNull()
    expect(securityExports.csrfInternals.isValidSignedCsrfToken('nonce.short')).toBe(false)
  })

  it('bypasses csrf verification for safe methods and excluded paths', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
          except: ['/webhooks/*'],
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    await expect(csrf.verify(new Request('https://app.test/login', {
      method: 'GET',
    }))).resolves.toBeUndefined()

    await expect(csrf.verify(new Request('https://app.test/webhooks/stripe', {
      method: 'POST',
    }))).resolves.toBeUndefined()
  })

  it('honors configured header field and cookie overrides', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
          field: '_csrf',
          header: 'X-XSRF-TOKEN',
          cookie: 'csrf-token',
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })
    const customToken = securityExports.csrfInternals.encodeCsrfToken('custom-token')

    const request = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `csrf-token=${customToken}`,
        'X-XSRF-TOKEN': customToken,
      },
    })

    await expect(csrf.field(request)).resolves.toEqual({
      name: '_csrf',
      value: customToken,
    })
    await expect(csrf.verify(request)).resolves.toBeUndefined()
    await expect(csrf.cookie(request)).resolves.toBe(`csrf-token=${encodeURIComponent(customToken)}; Path=/; SameSite=Lax; Secure`)
  })

  it('protect uses route-level options against global defaults', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: false,
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    const unprotected = new Request('https://app.test/login', {
      method: 'POST',
    })
    await expect(protect(unprotected)).resolves.toBeUndefined()

    const forced = new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `XSRF-TOKEN=${securityExports.csrfInternals.encodeCsrfToken('forced-token')}`,
        'X-CSRF-TOKEN': securityExports.csrfInternals.encodeCsrfToken('forced-token'),
      },
    })
    await expect(protect(forced, { csrf: true })).resolves.toBeUndefined()

    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
      }),
    })

    const disabled = new Request('https://app.test/login', {
      method: 'POST',
    })
    await expect(protect(disabled, { csrf: false })).resolves.toBeUndefined()
  })

  it('lets route-level csrf opt-ins override excluded paths', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: false,
          except: ['/webhooks/*'],
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    await expect(protect(new Request('https://app.test/webhooks/stripe', {
      method: 'POST',
    }), {
      csrf: true,
    })).rejects.toBeInstanceOf(SecurityCsrfError)
  })

  it('still skips safe methods and default excluded paths in protect()', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
          except: ['/webhooks/*'],
        },
      }),
      csrfSigningKey: 'test-signing-key',
    })

    await expect(protect(new Request('https://app.test/webhooks/stripe', {
      method: 'POST',
    }))).resolves.toBeUndefined()

    await expect(protect(new Request('https://app.test/webhooks/stripe', {
      method: 'GET',
    }), {
      csrf: true,
    })).resolves.toBeUndefined()
  })

  it('protect applies throttle after csrf verification when configured', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        csrf: {
          enabled: true,
        },
        rateLimit: {
          limiters: {
            login: limit.perMinute(1).by(({ request }) => ip(request, true)),
          },
        },
      }),
      csrfSigningKey: 'test-signing-key',
      rateLimitStore: createMockRateLimitStore(),
    })
    const throttleToken = securityExports.csrfInternals.encodeCsrfToken('throttle-token')

    await expect(protect(new Request('https://app.test/login', {
      method: 'POST',
      headers: {
        cookie: `XSRF-TOKEN=${throttleToken}`,
        'X-CSRF-TOKEN': throttleToken,
        'x-forwarded-for': '203.0.113.10',
      },
    }), {
      throttle: 'login',
    })).resolves.toBeUndefined()
  })
})

describe('@holo-js/security rate-limit drivers', () => {
  let memoryNow = new Date('2026-04-16T12:00:00.000Z')

  runRateLimitDriverContractSuite({
    label: 'memory',
    createStore() {
      return createMemoryRateLimitStore({
        now: () => memoryNow,
      })
    },
    advancePastExpiry() {
      memoryNow = new Date('2026-04-16T12:02:00.000Z')
    },
    cleanup() {
      memoryNow = new Date('2026-04-16T12:00:00.000Z')
    },
  })

  it('keeps memory buckets process-local to the store instance', async () => {
    const firstStore = createMemoryRateLimitStore({
      now: () => new Date('2026-04-16T12:00:00.000Z'),
    })
    const secondStore = createMemoryRateLimitStore({
      now: () => new Date('2026-04-16T12:00:00.000Z'),
    })

    await firstStore.hit('limiter:login|user:process-local', {
      maxAttempts: 2,
      decaySeconds: 60,
    })

    const isolated = await secondStore.hit('limiter:login|user:process-local', {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    expect(isolated.snapshot.attempts).toBe(1)
  })

  it('clones snapshot expiry dates, evicts oldest buckets, and closes the pruning timer', async () => {
    const now = new Date('2026-04-16T12:00:00.000Z')
    const store = createMemoryRateLimitStore({
      now: () => now,
      maxBuckets: 2,
      pruneIntervalMs: 10_000,
    })

    const first = await store.hit('limiter:login|user:first', {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    first.snapshot.expiresAt.setFullYear(2000)

    await store.hit('limiter:login|user:second', {
      maxAttempts: 2,
      decaySeconds: 60,
    })
    await store.hit('limiter:login|user:third', {
      maxAttempts: 2,
      decaySeconds: 60,
    })

    const recycled = await store.hit('limiter:login|user:first', {
      maxAttempts: 2,
      decaySeconds: 60,
    })

    expect(recycled.snapshot.attempts).toBe(1)
    expect(first.snapshot.expiresAt.getFullYear()).toBe(2000)
    await store.close?.()
  })

  it('does not evict active buckets from the default memory store', async () => {
    const store = createMemoryRateLimitStore()

    for (let index = 0; index <= 1000; index += 1) {
      await store.hit(`limiter:login|user:${index}`, {
        maxAttempts: 2,
        decaySeconds: 60,
      })
    }

    const repeated = await store.hit('limiter:login|user:0', {
      maxAttempts: 2,
      decaySeconds: 60,
    })

    expect(repeated.snapshot.attempts).toBe(2)
    await store.close?.()
  })

  it('prunes expired memory buckets on a timer', async () => {
    vi.useFakeTimers()

    try {
      let now = new Date('2026-04-16T12:00:00.000Z')
      const store = createMemoryRateLimitStore({
        now: () => now,
        maxBuckets: 4,
        pruneIntervalMs: 10,
      })

      await store.hit('limiter:login|user:pruned', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      now = new Date('2026-04-16T12:02:00.000Z')

      await vi.advanceTimersByTimeAsync(10)

      await expect(store.clear('limiter:login|user:pruned')).resolves.toBe(false)
      await store.close?.()
    } finally {
      vi.useRealTimers()
    }
  })

  describe('file rate-limit driver contract', () => {
    let harness:
      | {
          root: string
          setNow(value: Date): void
          createStore(): SecurityRateLimitStore
        }
      | undefined

    async function createHarness() {
      const root = await mkdtemp(join(tmpdir(), 'holo-security-file-'))
      tempDirs.push(root)
      let now = new Date('2026-04-16T12:00:00.000Z')

      return {
        root,
        setNow(value: Date) {
          now = value
        },
        createStore() {
          return createFileRateLimitStore(root, {
            now: () => now,
          })
        },
      }
    }

    runRateLimitDriverContractSuite({
      label: 'file',
      async createStore() {
        harness = await createHarness()
        return harness.createStore()
      },
      advancePastExpiry() {
        harness?.setNow(new Date('2026-04-16T12:02:00.000Z'))
      },
      supportsPersistence: true,
      recreateStore() {
        if (!harness) {
          throw new Error('file test harness is not initialized')
        }

        return harness.createStore()
      },
    })

    it('cleans up expired buckets while scanning and resets expired buckets on hit', async () => {
      const harness = await createHarness()
      const store = harness.createStore()

      await store.hit('limiter:login|user:expired', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      harness.setNow(new Date('2026-04-16T12:02:00.000Z'))

      const reset = await store.hit('limiter:login|user:expired', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      expect(reset.snapshot.attempts).toBe(1)

      await store.hit('limiter:login|user:scan-expired', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      harness.setNow(new Date('2026-04-16T12:04:00.000Z'))
      await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(0)
    })

    it('stores opaque file bucket metadata and still clears by prefix', async () => {
      const harness = await createHarness()
      const store = harness.createStore()
      const key = 'limiter:login|user:pii@example.com'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)

      await store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      const serialized = await readFile(bucketPath, 'utf8')
      expect(serialized).not.toContain('pii@example.com')
      expect(serialized).toContain('"namespace":"limiter:login|"')
      expect(serialized).toContain('"keyHash":"')
      expect(serialized).toContain('"prefixHashes":[')
      await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(1)
    })

    it('does not leak raw limiter keys when file bucket hashes collide', async () => {
      const harness = await createHarness()
      const store = harness.createStore()
      const key = 'limiter:login|user:pii@example.com'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)

      await mkdir(dirname(bucketPath), { recursive: true })
      await writeFile(bucketPath, JSON.stringify({
        namespace: 'limiter:login|',
        keyHash: 'different-hash',
        prefixHashes: ['different-prefix-hash'],
        attempts: 1,
        expiresAt: '2026-04-16T12:01:00.000Z',
      }), 'utf8')

      await expect(store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })).rejects.toThrow('bucket hash collision')
      await expect(store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })).rejects.not.toThrow('pii@example.com')
    })

    it('clears file buckets with prefixes narrower than the limiter namespace', async () => {
      const harness = await createHarness()
      const store = harness.createStore()

      await store.hit('limiter:login|user:alpha@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      await store.hit('limiter:login|user:beta@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      await expect(store.clearByPrefix('limiter:login|user:alpha')).resolves.toBe(1)

      const alpha = await store.hit('limiter:login|user:alpha@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })
      const beta = await store.hit('limiter:login|user:beta@example.com', {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      expect(alpha.snapshot.attempts).toBe(1)
      expect(beta.snapshot.attempts).toBe(2)
    })

    it('serializes concurrent hits on the same bucket so attempts are not lost', async () => {
      const harness = await createHarness()
      const store = harness.createStore()

      const [first, second] = await Promise.all([
        store.hit('limiter:login|user:concurrent', {
          maxAttempts: 3,
          decaySeconds: 60,
        }),
        store.hit('limiter:login|user:concurrent', {
          maxAttempts: 3,
          decaySeconds: 60,
        }),
      ])

      expect([first.snapshot.attempts, second.snapshot.attempts].sort((left, right) => left - right)).toEqual([1, 2])

      const persisted = await harness.createStore().hit('limiter:login|user:concurrent', {
        maxAttempts: 3,
        decaySeconds: 60,
      })

      expect(persisted.snapshot.attempts).toBe(3)
    })

    it('reclaims stale bucket locks before timing out', async () => {
      const harness = await createHarness()
      const staleStore = createFileRateLimitStore(harness.root, {
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        lockRetryDelayMs: 1,
        lockTimeoutMs: 20,
      })
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:stale-lock')
      const lockPath = fileRateLimitDriverInternals.getBucketLockPath(bucketPath)

      await mkdir(lockPath, { recursive: true })
      await utimes(lockPath, new Date('2026-04-16T11:59:00.000Z'), new Date('2026-04-16T11:59:00.000Z'))
      await expect(staleStore.hit('limiter:login|user:stale-lock', {
        maxAttempts: 2,
        decaySeconds: 60,
      })).resolves.toEqual(expect.objectContaining({
        limited: false,
        snapshot: expect.objectContaining({
          attempts: 1,
        }),
      }))
    })

    it('does not reclaim live bucket locks while another operation is still running', async () => {
      const harness = await createHarness()
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:live-lock')
      let releaseLock!: () => void

      const lockAcquired = new Promise<void>((resolve) => {
        releaseLock = resolve
      })

      const holdingLock = fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 20,
      }, async () => {
        await lockAcquired
      })

      const waitForAcquired = new Promise<void>((resolve) => {
        void fileRateLimitDriverInternals.withBucketLock(bucketPath, {
          retryDelayMs: 1,
          timeoutMs: 100,
        }, async () => {
          resolve()
        })
      })

      await fileRateLimitDriverInternals.sleep(5)
      await expect(fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 20,
      }, async () => 'reclaimed')).rejects.toThrow(`Timed out waiting for file rate-limit lock "${fileRateLimitDriverInternals.getBucketLockPath(bucketPath)}"`)

      releaseLock()
      await holdingLock
      await waitForAcquired
    })

    it('waits for active bucket locks before clearing all persisted buckets', async () => {
      const harness = await createHarness()
      const store = createFileRateLimitStore(harness.root, {
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        lockRetryDelayMs: 1,
        lockTimeoutMs: 100,
      })
      const key = 'limiter:login|user:clear-all-lock'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)
      let releaseLock!: () => void

      await store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      const lockHeld = new Promise<void>((resolve) => {
        releaseLock = resolve
      })

      const holdingLock = fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 100,
      }, async () => {
        await lockHeld
      })

      await fileRateLimitDriverInternals.sleep(5)

      let clearResolved = false
      const clearAll = store.clearAll().then((cleared) => {
        clearResolved = true
        return cleared
      })

      await fileRateLimitDriverInternals.sleep(10)
      expect(clearResolved).toBe(false)

      releaseLock()
      await holdingLock
      await expect(clearAll).resolves.toBe(1)
      await expect(store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })).resolves.toEqual(expect.objectContaining({
        snapshot: expect.objectContaining({
          attempts: 1,
        }),
      }))
    })

    async function withDisappearingLockedBucket(
      callback: (store: SecurityRateLimitStore, key: string) => Promise<void>,
    ): Promise<void> {
      const harness = await createHarness()
      const store = createFileRateLimitStore(harness.root, {
        now: () => new Date('2026-04-16T12:00:00.000Z'),
        lockRetryDelayMs: 1,
        lockTimeoutMs: 100,
      })
      const key = 'limiter:login|user:disappearing-lock'
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, key)
      let releaseLock!: () => void

      await store.hit(key, {
        maxAttempts: 2,
        decaySeconds: 60,
      })

      let requestDelete!: () => void
      const deleteRequested = new Promise<void>((resolve) => {
        requestDelete = resolve
      })
      const bucketDeleted = new Promise<void>((resolve) => {
        releaseLock = resolve
      })

      const holdingLock = fileRateLimitDriverInternals.withBucketLock(bucketPath, {
        retryDelayMs: 1,
        timeoutMs: 100,
      }, async () => {
        await deleteRequested
        await fileRateLimitDriverInternals.deleteBucket(bucketPath)
        releaseLock()
      })

      await fileRateLimitDriverInternals.sleep(5)
      const pendingClear = callback(store, key)
      await fileRateLimitDriverInternals.sleep(5)
      requestDelete()
      await bucketDeleted
      await pendingClear

      await holdingLock
    }

    it('skips buckets deleted before clearByPrefix acquires their lock', async () => {
      await withDisappearingLockedBucket(async (store) => {
        await expect(store.clearByPrefix('limiter:login|')).resolves.toBe(0)
      })
    })

    it('skips buckets deleted before clearAll acquires their lock', async () => {
      await withDisappearingLockedBucket(async (store) => {
        await expect(store.clearAll()).resolves.toBe(0)
      })
    })

    it('uses sharded per-bucket file paths and rejects malformed bucket files', async () => {
      const harness = await createHarness()
      const bucketPath = fileRateLimitDriverInternals.getBucketPath(harness.root, 'limiter:login|user:bad')

      expect(bucketPath.startsWith(harness.root)).toBe(true)
      expect(bucketPath.endsWith('.json')).toBe(true)

      await mkdir(join(harness.root, 'aa', 'bb'), { recursive: true })
      await writeFile(join(harness.root, 'aa', 'bb', 'broken.json'), '{bad json', 'utf8')
      await expect(fileRateLimitDriverInternals.readBucket(join(harness.root, 'aa', 'bb', 'broken.json'))).rejects.toThrow()
    })
  })

  describe('redis rate-limit driver contract', () => {
    let currentNow = new Date('2026-04-16T12:00:00.000Z')

    function createAdapter(now: Date): {
      adapter: SecurityRateLimitRedisDriverAdapter
      setNow(value: Date): void
    } {
      const buckets = new Map<string, { attempts: number, expiresAt: Date }>()
      let currentNow = now

      return {
        setNow(value) {
          currentNow = value
        },
        adapter: {
          async increment(key, options) {
            const existing = buckets.get(key)
            if (existing && existing.expiresAt.getTime() <= currentNow.getTime()) {
              buckets.delete(key)
            }

            const active = buckets.get(key)
            const bucket = active
              ? {
                  ...active,
                  attempts: active.attempts + 1,
                }
              : {
                  attempts: 1,
                  expiresAt: new Date(currentNow.getTime() + options.decaySeconds * 1000),
                }

            buckets.set(key, bucket)
            return {
              attempts: bucket.attempts,
              ttlSeconds: Math.max(0, Math.ceil((bucket.expiresAt.getTime() - currentNow.getTime()) / 1000)),
            }
          },
          async del(key) {
            const existed = buckets.delete(key)
            return existed ? 1 : 0
          },
          async clearByPrefix(prefix) {
            let cleared = 0

            for (const key of buckets.keys()) {
              if (!key.startsWith(prefix)) {
                continue
              }

              buckets.delete(key)
              cleared += 1
            }

            return cleared
          },
          async clearAll() {
            const cleared = buckets.size
            buckets.clear()
            return cleared
          },
        },
      }
    }

    let currentAdapter: ReturnType<typeof createAdapter> | undefined

    runRateLimitDriverContractSuite({
      label: 'redis',
      createStore() {
        currentAdapter = createAdapter(currentNow)
        return createRedisRateLimitStore(currentAdapter.adapter, {
          now: () => currentNow,
        })
      },
      advancePastExpiry() {
        currentNow = new Date('2026-04-16T12:02:00.000Z')
        currentAdapter?.setNow(currentNow)
      },
      cleanup() {
        currentNow = new Date('2026-04-16T12:00:00.000Z')
        currentAdapter = undefined
      },
    })

    it('validates malformed adapter results and falls back when clear helpers are unavailable', async () => {
      const storeWithoutClear = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: 1,
            ttlSeconds: 60,
          }
        },
        async del() {
          return 1
        },
      })

      await expect(storeWithoutClear.clearByPrefix('limiter:login|')).resolves.toBe(0)
      await expect(storeWithoutClear.clearAll()).resolves.toBe(0)

      const malformedStore = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: -1,
            ttlSeconds: -1,
          }
        },
        async del() {
          return -1
        },
        async clearByPrefix() {
          return -1
        },
        async clearAll() {
          return -1
        },
      })

      await expect(malformedStore.hit('limiter:login|user:1', {
        maxAttempts: 2,
        decaySeconds: 60,
      })).rejects.toThrow('attempts must be a non-negative integer')

      const malformedClearStore = createRedisRateLimitStore({
        async increment() {
          return {
            attempts: 1,
            ttlSeconds: 60,
          }
        },
        async del() {
          return -1
        },
        async clearByPrefix() {
          return -1
        },
        async clearAll() {
          return -1
        },
      })

      await expect(malformedClearStore.clear('limiter:login|user:1')).rejects.toThrow('del() result must be a non-negative integer')
      await expect(malformedClearStore.clearByPrefix('limiter:login|')).rejects.toThrow('clearByPrefix() result must be a non-negative integer')
      await expect(malformedClearStore.clearAll()).rejects.toThrow('clearAll() result must be a non-negative integer')
    })

    it('exposes the standalone contract suite-compatible driver behavior', () => {
      expect(typeof redisRateLimitDriverInternals.assertNonNegativeInteger).toBe('function')
      expect(typeof memoryRateLimitDriverInternals.isExpired).toBe('function')
    })
  })
})

describe('@holo-js/security rate limiting', () => {
  it('derives limiter keys from the request context', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(({ request, values }) => {
              return `${ip(request, true)}:${String(values?.email ?? 'guest')}`
            }),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const result = await rateLimit('login', {
      request: new Request('https://app.test/login', {
        headers: {
          'x-forwarded-for': '203.0.113.7',
        },
      }),
      values: {
        email: 'ava@example.com',
      },
    })

    expect(result).toEqual({
      limited: false,
      snapshot: {
        limiter: 'login',
        key: '203.0.113.7:ava@example.com',
        attempts: 1,
        maxAttempts: 2,
        remainingAttempts: 1,
        expiresAt: new Date('2026-04-16T12:01:00.000Z'),
      },
      retryAfterSeconds: 60,
    })
  })

  it('supports direct key usage without a request', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perHour(3).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const result = await rateLimit('invites', {
      key: 'team:42:user:7',
    })

    expect(result.snapshot).toMatchObject({
      limiter: 'invites',
      key: 'team:42:user:7',
      attempts: 1,
      maxAttempts: 3,
      remainingAttempts: 2,
    })
    expect(result.retryAfterSeconds).toBe(3600)
  })

  it('uses the default guest request key when no limiter resolver is configured', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perHour(3).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const result = await rateLimit('invites', {
      request: new Request('https://app.test/invites', {
        headers: {
          'x-forwarded-for': '203.0.113.11',
        },
      }),
    })

    expect(result.snapshot).toMatchObject({
      limiter: 'invites',
      key: 'ip:unknown',
      attempts: 1,
      maxAttempts: 3,
      remainingAttempts: 2,
    })
  })

  it('opts into trusted proxy headers for the default request key only when explicitly enabled', async () => {
    const original = process.env.HOLO_SECURITY_TRUST_PROXY
    process.env.HOLO_SECURITY_TRUST_PROXY = 'true'

    try {
      configureSecurityRuntime({
        config: defineSecurityConfig({
          rateLimit: {
            limiters: {
              invites: limit.perHour(3).define(),
            },
          },
        }),
        rateLimitStore: createMockRateLimitStore(),
      })

      const result = await rateLimit('invites', {
        request: new Request('https://app.test/invites', {
          headers: {
            'x-forwarded-for': '203.0.113.11',
          },
        }),
      })

      expect(result.snapshot.key).toBe('ip:203.0.113.11')
    } finally {
      if (typeof original === 'undefined') {
        delete process.env.HOLO_SECURITY_TRUST_PROXY
      } else {
        process.env.HOLO_SECURITY_TRUST_PROXY = original
      }
    }
  })

  it('prefers the configured runtime default key resolver for authenticated requests', async () => {
    const defaultKeyResolver = vi.fn(async () => 'user:42')

    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perHour(3).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
      defaultKeyResolver,
    })

    const request = new Request('https://app.test/invites')
    const result = await rateLimit('invites', { request })

    expect(result.snapshot.key).toBe('user:42')
    expect(defaultKeyResolver).toHaveBeenCalledWith(request)
  })

  it('supports async limiter key resolvers that compose with the default helper', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(async ({ request, values }) => {
              const email = String(values?.email ?? 'guest').toLowerCase()
              return `${await defaultRateLimitKey(request)}:email:${email}`
            }),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
      defaultKeyResolver: async () => 'user:7',
    })

    const result = await rateLimit('login', {
      request: new Request('https://app.test/login'),
      values: {
        email: 'Ava@Example.com',
      },
    })

    expect(result.snapshot.key).toBe('user:7:email:ava@example.com')
  })

  it('throws stable rate-limit metadata after the bucket exceeds its limit', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(({ request }) => ip(request, true)),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    const request = new Request('https://app.test/login', {
      headers: {
        'x-forwarded-for': '203.0.113.9',
      },
    })

    await rateLimit('login', { request })
    await rateLimit('login', { request })

    await expect(rateLimit('login', { request })).rejects.toMatchObject({
      status: 429,
      retryAfterSeconds: 60,
      snapshot: {
        limiter: 'login',
        key: '203.0.113.9',
        attempts: 3,
        maxAttempts: 2,
        remainingAttempts: 0,
      },
    })
  })

  it('clears exact keys, namespaces, and all buckets', async () => {
    const store = createMockRateLimitStore()

    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(3).define(),
            invites: limit.perMinute(3).define(),
          },
        },
      }),
      rateLimitStore: store,
    })

    await rateLimit('login', { key: 'team:42:user:1' })
    await rateLimit('login', { key: 'team:42:user:2' })
    await rateLimit('invites', { key: 'team:42:user:3' })

    await expect(clearRateLimit({
      limiter: 'login',
      key: 'team:42:user:1',
    })).resolves.toBe(true)

    await expect(clearRateLimit({
      limiter: 'login',
    })).resolves.toBe(1)

    await expect(clearRateLimit({
      all: true,
    })).resolves.toBe(1)
    await expect(clearRateLimit({
      all: true,
      limiter: 'login',
    })).rejects.toThrow('must use either { all: true } or a scoped limiter/key pair, not both')
  })

  it('rejects invalid limiter usage and missing runtime store wiring', async () => {
    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            login: limit.perMinute(2).by(() => ''),
          },
        },
      }),
    })

    await expect(rateLimit('login', {
      request: new Request('https://app.test/login'),
    })).rejects.toThrow('Rate limiter "login" must resolve a non-empty string key.')

    await expect(clearRateLimit({
      limiter: 'login',
    })).rejects.toThrow('Rate-limit store is not configured yet.')

    configureSecurityRuntime({
      config: defineSecurityConfig({
        rateLimit: {
          limiters: {
            invites: limit.perMinute(2).define(),
          },
        },
      }),
      rateLimitStore: createMockRateLimitStore(),
    })

    await expect(rateLimit('missing', {
      key: 'abc',
    })).rejects.toThrow('Rate limiter "missing" is not defined')

    await expect(rateLimit('invites', {})).rejects.toThrow('requires either an explicit key or a request for the default key resolver')

    await expect(clearRateLimit({
      key: 'abc',
    })).rejects.toThrow('requires a limiter name unless { all: true } is used')
  })
})
