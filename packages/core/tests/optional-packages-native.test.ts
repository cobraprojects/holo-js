import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { stagePublishedPackage } from '../../../tests/support/published-package'
import { version as holoVersion } from '../package.json'

const root = resolve(import.meta.dirname, '../../..')

type NativeBootScenario = {
  configName?: string
  installQueue?: boolean
  missingRedisAdapter?: 'security' | 'session'
  missingCacheAdapter?: 'redis' | 'database'
  cacheMode?: 'default' | 'memory'
  securityMode?: 'absent-auth' | 'reset-auth'
  failedBoot?: boolean
  authorization?: boolean
  authDelivery?: boolean
  socialPackage?: 'google-absent' | 'custom-absent' | 'custom-malformed' | 'custom'
  missingAuthorization?: boolean
  missingAuthProvider?: 'social' | 'workos' | 'clerk'
}

async function runNativeBoot({ configName, installQueue = false, missingRedisAdapter, missingCacheAdapter, cacheMode, securityMode, failedBoot, authorization, missingAuthProvider, missingAuthorization, authDelivery, socialPackage }: NativeBootScenario = {}): Promise<void> {
  const project = await mkdtemp(join(tmpdir(), 'holo-native-optional-'))
  onTestFinished(() => rm(project, { recursive: true, force: true }))
  await mkdir(join(project, 'config'), { recursive: true })
  await writeFile(join(project, 'package.json'), JSON.stringify({ type: 'module' }))
  for (const packageName of ['core', 'db-sqlite', ...configName === 'auth' ? ['session'] : [], ...installQueue ? ['queue'] : [], ...missingRedisAdapter ? [missingRedisAdapter] : [], ...cacheMode || missingCacheAdapter ? ['cache'] : [], ...securityMode ? ['security', ...securityMode === 'reset-auth' ? ['auth', 'session'] : []] : [], ...failedBoot ? ['mail'] : [], ...authorization !== undefined ? ['auth', 'session', ...authorization ? ['authorization'] : []] : [], ...missingAuthProvider ? ['auth', 'session'] : [], ...socialPackage ? ['auth', 'session', 'auth-social', ...socialPackage === 'custom' ? ['auth-social-google'] : []] : []]) {
    const source = join(root, 'packages', packageName)
    await stagePublishedPackage(source, join(project, 'node_modules/@holo-js', packageName), join(source, 'dist'))
  }
  await writeFile(join(project, 'config/app.ts'), "export default { name: 'Native optional packages', key: 'test-key' }")
  await writeFile(join(project, 'config/database.ts'), "export default { defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } }")
  if (configName) await writeFile(join(project, 'config', `${configName}.ts`), 'export default {}')
  if (missingRedisAdapter) {
    await rm(join(project, 'node_modules/@holo-js', missingRedisAdapter, 'dist/drivers/redis-adapter.mjs'))
    await writeFile(join(project, 'config/redis.ts'), "export default { default: 'default', connections: { default: { host: '127.0.0.1', port: 6379 } } }")
    await writeFile(join(project, 'config', `${missingRedisAdapter}.ts`), missingRedisAdapter === 'security'
      ? "export default { rateLimit: { driver: 'redis' } }"
      : "export default { driver: 'redis', stores: { redis: { driver: 'redis', connection: 'default' } } }")
  }
  if (cacheMode === 'memory') await writeFile(join(project, 'config/cache.ts'), "export default { default: 'memory', stores: { memory: { driver: 'memory' } } }")
  if (missingCacheAdapter) await writeFile(join(project, 'config/cache.ts'), `export default { default: '${missingCacheAdapter}', drivers: { ${missingCacheAdapter}: { driver: '${missingCacheAdapter}', connection: 'main' } } }`)
  if (securityMode) await writeFile(join(project, 'config/security.ts'), "export default { rateLimit: { driver: 'memory' } }")
  if (failedBoot) {
    const plugin = join(project, 'node_modules/holo-plugin-failed-boot')
    await mkdir(plugin, { recursive: true })
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name: 'holo-plugin-failed-boot', type: 'module', holo: { plugin: './plugin.mjs' } }))
    await writeFile(join(plugin, 'plugin.mjs'), "export default { id: 'failed-boot', contributes: { runtime: { boot: './boot.mjs' } } }")
    await writeFile(join(plugin, 'boot.mjs'), "export default function boot() { throw new Error('Native app boot failed') }")
    await writeFile(join(project, 'config/app.ts'), "export default { name: 'Native optional packages', key: 'test-key', plugins: ['holo-plugin-failed-boot'] }")
    await writeFile(join(project, 'config/mail.ts'), "export default { default: 'fake', from: { email: 'sender@example.com' } }")
  }
  if (authorization !== undefined || missingAuthProvider || socialPackage) {
    await mkdir(join(project, 'server/models'), { recursive: true })
    await writeFile(join(project, 'config/auth.ts'), "export default { defaults: { guard: 'web' }, guards: { web: { driver: 'session', provider: 'users' } }, providers: { users: { model: 'User' } } }")
    await writeFile(join(project, 'config/session.ts'), "export default { driver: 'file', stores: { file: { driver: 'file', path: './storage/sessions' } } }")
    await writeFile(join(project, 'server/models/User.ts'), "import { column, defineGeneratedTable, defineModel } from '@holo-js/db'; export default defineModel(defineGeneratedTable('users', { id: column.integer().primaryKey(), email: column.string() }), { timestamps: false, fillable: ['email'] })")
  }
  if (missingAuthProvider) {
    const providerConfig = missingAuthProvider === 'social'
      ? "social: { google: { clientId: 'client', encryptTokens: false } }"
      : missingAuthProvider === 'workos'
        ? "workos: { defaultProvider: { clientId: 'client' } }"
        : "clerk: { app: { publishableKey: 'pk_test' } }"
    await writeFile(join(project, 'config/auth.ts'), `export default { defaults: { guard: 'web' }, guards: { web: { driver: 'session', provider: 'users' } }, providers: { users: { model: 'User' } }, ${providerConfig} }`)
  }
  if (missingAuthorization) {
    await mkdir(join(project, 'server/abilities'), { recursive: true })
    const source = join(root, 'packages/authorization')
    await stagePublishedPackage(source, join(project, 'node_modules/@holo-js/authorization'), join(source, 'dist'))
    await writeFile(join(project, 'server/abilities/export.ts'), "import { defineAbility } from '@holo-js/authorization'; export default defineAbility('export', () => true)")
    await writeFile(join(project, 'package.json'), JSON.stringify({
      type: 'module',
      dependencies: Object.fromEntries(['core', 'kernel', 'db-sqlite', 'authorization'].map(name => [`@holo-js/${name}`, `^${holoVersion}`])),
    }))
    const prepared = spawnSync(process.execPath, [join(root, 'packages/cli/dist/bin/holo.mjs'), 'prepare'], { cwd: project, encoding: 'utf8', timeout: 15000 })
    expect(prepared.status, `${prepared.stdout}\n${prepared.stderr}`).toBe(0)
    await rm(join(project, 'node_modules/@holo-js/authorization'), { recursive: true, force: true })
  }
  if (socialPackage) {
    const custom = socialPackage !== 'google-absent'
    await writeFile(join(project, 'config/auth.ts'), `export default { defaults: { guard: 'web' }, guards: { web: { driver: 'session', provider: 'users' } }, providers: { users: { model: 'User' } }, social: { ${custom ? 'custom' : 'google'}: { ${custom ? "runtime: '@acme/holo-auth-social-custom'," : ''} clientId: 'native-client', redirectUri: 'https://app.test/oauth/callback', encryptTokens: false } } }`)
    if (socialPackage === 'custom' || socialPackage === 'custom-malformed') {
      const packageRoot = join(project, 'node_modules/@acme/holo-auth-social-custom')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: '@acme/holo-auth-social-custom', type: 'module', exports: './index.mjs' }))
      await writeFile(join(packageRoot, 'index.mjs'), socialPackage === 'custom' ? "export { default } from '@holo-js/auth-social-google'" : 'export const invalid = true')
    }
  }
  const expectedPackage = socialPackage && socialPackage !== 'custom' ? socialPackage === 'google-absent' ? '@holo-js/auth-social-google' : '@acme/holo-auth-social-custom' : missingAuthorization ? '@holo-js/authorization' : missingAuthProvider ? `@holo-js/auth-${missingAuthProvider}` : missingCacheAdapter ? `@holo-js/cache-${missingCacheAdapter === 'database' ? 'db' : 'redis'}` : missingRedisAdapter ? `@holo-js/${missingRedisAdapter}/drivers/redis-adapter` : configName ? `@holo-js/${configName}` : undefined
  const script = `
import assert from 'node:assert/strict'
import { createHolo, getHolo } from '@holo-js/core/runtime'
import { useConfig } from '@holo-js/config'
const runtime = await createHolo(process.cwd(), ${failedBoot ? "{ renderView: async () => '<p>Rendered</p>' }" : '{}'})
try {
  const missing = ${JSON.stringify(expectedPackage) ?? 'undefined'}
  if (${Boolean(failedBoot)}) {
    await assert.rejects(runtime.initialize(), /Native app boot failed/)
    const { previewMail } = await import('@holo-js/mail')
    await assert.rejects(previewMail({ from: 'sender@example.com', to: 'ava@example.com', subject: 'Renderer after rollback', render: { view: 'emails/welcome' } }), /renderView runtime binding/)
    assert.equal(runtime.manager.connection().isConnected(), false)
    assert.throws(() => getHolo(), /Holo runtime is not initialized/)
  } else if (missing) {
    await assert.rejects(runtime.initialize(), error => ${socialPackage === 'custom-malformed' ? "error.message.includes('did not export a runtime')" : missingAuthorization ? "error.message.includes('requires @holo-js/authorization')" : missingRedisAdapter ? "error.code === 'ERR_MODULE_NOT_FOUND' && error.message.includes(missing.replace('/drivers/', '/dist/drivers/'))" : "error.message.includes(missing + ' to be installed')"})
    assert.equal(runtime.manager.connection().isConnected(), false)
    assert.throws(() => getHolo(), /Holo runtime is not initialized/)
    assert.throws(() => useConfig('app'), /Holo config runtime is not configured/)
  } else {
    await runtime.initialize()
    assert.equal(runtime.initialized, true)
    assert.equal(runtime.manager.connection().isConnected(), true)
    assert.equal(useConfig('app').name, 'Native optional packages')
    if (!${installQueue}) {
      assert.equal(runtime.queue.config.default, 'sync')
      assert.equal(runtime.queue.config.failed.table, 'failed_jobs')
      assert.equal(runtime.queue.drivers.size, 0)
    }
    if (${socialPackage === 'custom'}) {
      const { redirect } = await import('@holo-js/auth-social')
      const response = await redirect('custom', new Request('https://app.test/oauth/start'))
      assert.equal(response.status, 302)
      const destination = new URL(response.headers.get('location'))
      assert.equal(destination.origin, 'https://accounts.google.com')
      assert.equal(destination.searchParams.get('client_id'), 'native-client')
      assert.equal(destination.searchParams.get('redirect_uri'), 'https://app.test/oauth/callback')
      assert.ok(destination.searchParams.get('state'))
      assert.ok(destination.searchParams.get('code_challenge'))
      assert.ok(response.headers.get('set-cookie').startsWith('holo_oauth_state_custom=' + destination.searchParams.get('state') + '.'))
      assert.match(response.headers.get('set-cookie'), /HttpOnly; SameSite=Lax; Max-Age=600; Secure/)
    }
    if (${authorization !== undefined}) {
      const { DB, createSchemaService } = await import('@holo-js/db')
      const { default: auth } = await import('@holo-js/auth')
      const schema = createSchemaService(DB.connection())
      await schema.createTable('users', table => { table.integer('id').primaryKey(); table.string('email') })
      await schema.createTable('auth_session_revocations', table => { table.string('provider'); table.string('user_id'); table.integer('generation').default(0); table.string('retained_session_id').nullable(); table.unique(['provider', 'user_id']) })
      await DB.table('users').insert({ id: 1, email: 'native@example.com' })
      const login = await runtime.runWithAuthRequestAccessors({}, () => auth.loginUsingId(1))
      assert.ok(login.sessionId)
      await runtime.runWithAuthRequestAccessors({ getCookie: name => name === 'holo_session' ? login.sessionId : undefined }, async () => {
        assert.equal(await auth.check(), true)
        assert.equal((await auth.user()).email, 'native@example.com')
        if (${Boolean(authDelivery)}) {
          await schema.createTable('email_verification_tokens', table => {
            table.string('id').primaryKey(); table.string('provider'); table.string('user_id'); table.string('email'); table.string('token_hash'); table.timestamp('expires_at'); table.timestamp('used_at').nullable(); table.timestamps()
          })
          const token = await runtime.auth.verification.create(await auth.user())
          assert.equal(token.email, 'native@example.com')
          assert.ok(token.plainTextToken)
          await assert.rejects(import('@holo-js/notifications'), { code: 'ERR_MODULE_NOT_FOUND' })
        }
        if (${Boolean(authorization)}) {
          const { default: permissions, defineAbility } = await import('@holo-js/authorization')
          defineAbility('native.export', ({ user }) => user?.email === 'native@example.com')
          assert.equal(await permissions.guard('web').ability('native.export').can({}), true)
          assert.throws(() => permissions.guard('missing'), /guard.*missing|missing.*guard/i)
          await auth.logout()
          assert.equal(await permissions.guard('web').ability('native.export').can({}), false)
        } else {
          await assert.rejects(import('@holo-js/authorization'), { code: 'ERR_MODULE_NOT_FOUND' })
          await auth.logout()
          assert.equal(await auth.check(), false)
        }
      })
    }
    if (${Boolean(securityMode)}) {
      if (${securityMode === 'reset-auth'}) {
        const { resetAuthRuntime } = await import('@holo-js/auth')
        resetAuthRuntime()
      }
      const { defaultRateLimitKey } = await import('@holo-js/security')
      const request = new Request('https://app.test/requests', { headers: { 'x-forwarded-for': '198.51.100.10' } })
      assert.equal(await defaultRateLimitKey(request), 'ip:198.51.100.10')
    }
    if (${Boolean(cacheMode)}) {
      const { default: cache, getCacheRuntime } = await import('@holo-js/cache')
      await cache.put('native-cache', { owner: 'framework' }, 60)
      assert.deepEqual(await cache.get('native-cache'), { owner: 'framework' })
      await runtime.shutdown()
      assert.throws(getCacheRuntime, /not configured/)
      const restarted = await createHolo(process.cwd())
      try {
        await restarted.initialize()
        assert.deepEqual(await cache.get('native-cache'), ${cacheMode === 'default' ? "{ owner: 'framework' }" : 'null'})
      } finally {
        await restarted.shutdown()
      }
    }
    if (${installQueue}) {
      const { defineJob, dispatch, registerQueueJob } = await import('@holo-js/queue')
      let handled = ''
      registerQueueJob(defineJob({ handle(payload) { handled = payload.title } }), { name: 'native-job' })
      await dispatch('native-job', { title: 'Published queue package' }).dispatch()
      assert.equal(handled, 'Published queue package')
    }
  }
} finally {
  await runtime.shutdown()
}
`
  await writeFile(join(project, 'verify.mjs'), script)
  const result = spawnSync(process.execPath, ['verify.mjs'], { cwd: project, encoding: 'utf8', timeout: 15000, env: { ...process.env, HOLO_SECURITY_TRUST_PROXY: 'true' } })
  if (authDelivery) expect(result.stderr).toContain('Email verification delivery is not configured')
  expect(result.error).toBeUndefined()
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0)
}

it('boots a real SQLite app without unconfigured optional packages', () => runNativeBoot())

it('runs a native sync job without installing the database queue adapter', () => runNativeBoot({ installQueue: true }))

it.each(['queue', 'cache', 'notifications', 'mail', 'broadcast', 'security', 'auth', 'session'])(
  'fails closed and releases the real connection when configured %s is not installed',
  configName => runNativeBoot({ configName }),
)

it.each(['security', 'session'] as const)('fails closed when the installed %s package lacks its required Redis adapter',
  packageName => runNativeBoot({ missingRedisAdapter: packageName }),
)

it.each(['redis', 'database'] as const)('fails closed when configured %s caching lacks its installed adapter package',
  missingCacheAdapter => runNativeBoot({ missingCacheAdapter }),
)

it.each(['default', 'memory'] as const)('boots the real %s cache and clears its runtime binding on shutdown',
  cacheMode => runNativeBoot({ cacheMode }),
)

it.each(['absent-auth', 'reset-auth'] as const)('keeps real request rate-limit keys available with %s',
  securityMode => runNativeBoot({ securityMode }),
)

it('releases native rendering and database bindings after an app boot hook fails',
  () => runNativeBoot({ failedBoot: true }),
)

it.each([false, true])('persists native auth sessions and enforces permissions with authorization installed: %s',
  authorization => runNativeBoot({ authorization }),
)

it.each(['social', 'workos', 'clerk'] as const)('rejects native auth configuration when the %s provider package is absent',
  missingAuthProvider => runNativeBoot({ missingAuthProvider }),
)

it('rejects a native app with ability definitions when authorization is not installed',
  () => runNativeBoot({ missingAuthorization: true }),
)

it('creates a real verification token and reports missing delivery when notifications are absent',
  () => runNativeBoot({ authorization: false, authDelivery: true }),
)

it.each(['google-absent', 'custom-absent', 'custom-malformed', 'custom'] as const)('loads configured social runtimes through native package resolution: %s',
  socialPackage => runNativeBoot({ socialPackage }),
)
