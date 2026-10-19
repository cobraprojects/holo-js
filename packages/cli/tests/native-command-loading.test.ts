import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { startRedisService } from '../../session/tests/support/redis'

const execute = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const cli = join(repoRoot, 'packages/cli/dist/bin/holo.mjs')

async function createProject() {
  const root = await mkdtemp(join(tmpdir(), 'holo-native-command-loading-'))
  const write = async (name: string, content: string) => {
    const path = join(root, name)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
  }
  await write('package.json', JSON.stringify({ type: 'module' }))
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(repoRoot, 'packages'), join(root, 'node_modules/@holo-js'))
  await write('config/app.ts', "import { defineAppConfig } from '@holo-js/config'; export default defineAppConfig({ name: 'Command Loading' })")
  await write('config/database.ts', "import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } })")
  return { root, write }
}

it.each(['configured', 'default'] as const)('executes a real CLI command with %s TypeScript aliases', async mode => {
  const { root, write } = await createProject()
  try {
    if (mode === 'configured') await write('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#shared/*': ['./shared/*'] } } }))
    await write('shared/answer.ts', 'export const answer: number = 42')
    await write('server/commands/verify.ts', `import { answer } from '${mode === 'configured' ? '#shared/answer' : '@/shared/answer'}'\nexport default { description: 'Verify an aliased command', async run() { console.log(JSON.stringify({ answer })) } }`)
    const { stdout } = await execute(process.execPath, [cli, 'verify'], { cwd: root })
    expect(JSON.parse(stdout.trim())).toEqual({ answer: 42 })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('reports a real compiler error and removes runtime bundles when a discovered model cannot load', async () => {
  const { root, write } = await createProject()
  try {
    await write('server/models/Good.ts', "import { column, defineGeneratedTable, defineModel } from '@holo-js/db'; export default defineModel(defineGeneratedTable('good', { id: column.integer().primaryKey() }))")
    await write('server/models/Bad.ts', "import { column, defineGeneratedTable, defineModel } from '@holo-js/db'; import { value } from '../../shared/broken'; export default defineModel(defineGeneratedTable('bad', { id: column.integer().primaryKey().default(value) }))")
    await write('shared/broken.ts', 'export const value = )')
    await expect(execute(process.execPath, [cli, 'prune'], { cwd: root })).rejects.toThrow(/Unexpected "\)"/)
    const bundles = await readdir(join(root, '.holo-js/runtime/cli')).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    expect(bundles).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('installs real security configuration once and reports an unchanged installation on repetition', async () => {
  const { root, write } = await createProject()
  try {
    const { version } = JSON.parse(await readFile(join(repoRoot, 'packages/security/package.json'), 'utf8')) as { version: string }
    await write('package.json', JSON.stringify({ type: 'module', dependencies: { '@holo-js/security': `^${version}` } }))
    const installed = await execute(process.execPath, [cli, 'install', 'security'], { cwd: root })
    expect(installed.stdout).toContain('Installed security support.')
    const repeated = await execute(process.execPath, [cli, 'install', 'security'], { cwd: root })
    expect(repeated.stdout).toContain('Security support is already installed.')
    const cleared = await execute(process.execPath, [cli, 'rate-limit:clear', '--all'], { cwd: root })
    expect(cleared.stdout).toContain('Cleared 0 rate-limit bucket(s).')
    await expect(execute(process.execPath, [cli, 'rate-limit:clear'], { cwd: root })).rejects.toThrow('requires --limiter')
    await write('config/security.ts', "import { defineSecurityConfig } from '@holo-js/security'; export default defineSecurityConfig({ rateLimit: { driver: 'memory' } })")
    await expect(execute(process.execPath, [cli, 'rate-limit:clear', '--all'], { cwd: root })).rejects.toThrow('memory rate-limit driver is process-local')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('starts and stops an actual database worker when the prepared app has no jobs', async () => {
  const { root, write } = await createProject()
  try {
    await write('config/queue.ts', "import { defineQueueConfig } from '@holo-js/queue'; export default defineQueueConfig({ default: 'database', failed: false, connections: { database: { driver: 'database', connection: 'main' } } })")
    await write('config/database.ts', "import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'postgres', url: 'postgres://127.0.0.1:1/unreachable' } } })")
    await expect(execute(process.execPath, [cli, 'queue:clear', 'database'], { cwd: root, timeout: 5000 })).rejects.toThrow(/ECONNREFUSED/)
    await write('config/database.ts', "import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: './queue.sqlite' } } })")
    await execute(process.execPath, [cli, 'queue:table'], { cwd: root })
    await execute(process.execPath, [cli, 'migrate'], { cwd: root })
    const worker = await execute(process.execPath, [cli, 'queue:work', 'database', '--stop-when-empty'], { cwd: root })
    expect(worker.stdout).toContain('[queue] Stopped (empty). processed=0 released=0 failed=0')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it.each(['file', 'redis'] as const)('clears selected persistent %s rate-limit buckets through the actual CLI without booting application models', async driver => {
  const { root, write } = await createProject()
  try {
    const service = driver === 'redis' ? await startRedisService() : undefined
    const redis = service?.clients[0]
    const port = service?.ports[0]
    if (redis) await redis.acl('SETUSER', 'native-cli', 'on', '>secret', '~*', '+@all')
    const securityConfig = `import { defineSecurityConfig } from '@holo-js/security'; export default defineSecurityConfig({ rateLimit: { driver: '${driver}', file: { path: './storage/rate-limits' }, ${redis ? "redis: { connection: 'default' }," : ''} limiters: { login: { maxAttempts: 3, decaySeconds: 600 } } } })`
    await write('config/security.ts', securityConfig)
    if (redis) {
      const redisConfig = `import { defineRedisConfig } from '@holo-js/kernel'; export default defineRedisConfig({ default: 'default', connections: { default: { host: '127.0.0.1', port: ${port}, username: 'native-cli', password: 'secret' } } })`
      await write('config/redis.ts', redisConfig.replace("password: 'secret'", "password: 'wrong-secret'"))
      await expect(execute(process.execPath, [cli, 'rate-limit:clear', '--all'], { cwd: root, timeout: 5000 })).rejects.toThrow(/WRONGPASS|Connection is closed/)
      expect(await redis.acl('LOG', 1)).toEqual([expect.arrayContaining(['reason', 'auth', 'username', 'native-cli'])])
      await write('config/redis.ts', redisConfig)
    }
    await write('server/models/Broken.ts', "throw new Error('Rate-limit maintenance must not load app models')")
    await write('hit.mjs', `
import { loadConfigDirectory } from '@holo-js/config'
import { configureSecurityRuntime, createRateLimitStoreFromConfig, rateLimit } from '@holo-js/security'
const { security } = await loadConfigDirectory(process.cwd())
const adapter = security.rateLimit.driver === 'redis' ? (await import('@holo-js/security/drivers/redis-adapter')).createSecurityRedisAdapter(security.rateLimit.redis) : undefined
try {
  await adapter?.connect()
  configureSecurityRuntime({ config: security, rateLimitStore: createRateLimitStoreFromConfig(security, { projectRoot: process.cwd(), ...(adapter ? { redisAdapter: adapter } : {}) }) })
  const result = await rateLimit('login', { key: process.argv[2] })
  console.log(JSON.stringify({ attempts: result.snapshot.attempts }))
} finally { await adapter?.close() }
`)
    const hit = async (key: string) => {
      const { stdout } = await execute(process.execPath, ['hit.mjs', key], { cwd: root })
      return JSON.parse(stdout.trim()) as { attempts: number }
    }
    expect(await hit('alice')).toEqual({ attempts: 1 })
    expect(await hit('alice')).toEqual({ attempts: 2 })
    expect(await hit('alice')).toEqual({ attempts: 3 })
    await expect(hit('alice')).rejects.toThrow('SecurityRateLimitError')
    expect(await hit('bob')).toEqual({ attempts: 1 })
    if (redis) {
      await redis.acl('SETUSER', 'native-cli', '-del')
      await expect(execute(process.execPath, [cli, 'rate-limit:clear', '--limiter', 'login', '--key', 'alice'], { cwd: root, timeout: 5000 })).rejects.toThrow('NOPERM')
      await expect.poll(async () => (await redis.client('LIST') as string).includes('user=native-cli')).toBe(false)
      await redis.acl('SETUSER', 'native-cli', '+del')
    }
    const selected = await execute(process.execPath, [cli, 'rate-limit:clear', '--limiter', 'login', '--key', 'alice'], { cwd: root })
    expect(selected.stdout).toContain('Cleared 1 rate-limit bucket(s).')
    expect(await hit('alice')).toEqual({ attempts: 1 })
    expect(await hit('bob')).toEqual({ attempts: 2 })
    const all = await execute(process.execPath, [cli, 'rate-limit:clear', '--all'], { cwd: root })
    expect(all.stdout).toContain('Cleared 2 rate-limit bucket(s).')
    expect(await hit('bob')).toEqual({ attempts: 1 })
    if (redis) await expect.poll(async () => (await redis.client('LIST') as string).includes('user=native-cli')).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('loads real cache plugins, rejects malformed exports, and clears only the requested persistent store', async () => {
  const service = await startRedisService()
  const port = service.ports[0]
  if (port === undefined) throw new Error('Expected an owned Redis port')
  const { root, write } = await createProject()
  try {
    await write('config/app.ts', "import { defineAppConfig } from '@holo-js/config'; export default defineAppConfig({ name: 'Cache Maintenance', plugins: ['holo-plugin-native-cache'] })")
    await write('config/cache.ts', "import { defineCacheConfig } from '@holo-js/cache'; export default defineCacheConfig({ default: 'file', drivers: { file: { driver: 'file', path: './storage/cache' }, native: { driver: 'native' } } })")
    await write('node_modules/holo-plugin-native-cache/package.json', JSON.stringify({ name: 'holo-plugin-native-cache', type: 'module', holo: { plugin: './plugin.mjs' } }))
    await write('node_modules/holo-plugin-native-cache/plugin.mjs', "export default { id: 'native-cache', contributes: { cache: { drivers: { native: { runtime: './driver.mjs' } } } } }")
    const driver = `import { createRedisCacheDriver } from '@holo-js/cache-redis'; export default { driver: 'native', create(config) { return Object.assign(createRedisCacheDriver({ name: config.name, prefix: config.prefix, connectionName: 'default', redis: { host: '127.0.0.1', port: ${port}, db: 0 } }), { driver: 'native' }) } }`
    await write('node_modules/holo-plugin-native-cache/driver.mjs', driver)
    await write('cache.mjs', `
import { loadConfigDirectory } from '@holo-js/config'
import cache, { configureCacheRuntime, loadCachePluginDrivers, resetCacheRuntime } from '@holo-js/cache'
const config = await loadConfigDirectory(process.cwd())
configureCacheRuntime({ config: config.cache, databaseConfig: config.database, redisConfig: config.redis })
try {
  await loadCachePluginDrivers(process.cwd(), config.app.plugins)
  if (process.argv[2] === 'seed') {
    await cache.driver('file').put('entry', 'file entry', 600)
    await cache.driver('native').put('entry', 'plugin entry', 600)
  }
  console.log(JSON.stringify({ file: await cache.driver('file').get('entry'), native: await cache.driver('native').get('entry') }))
} finally { resetCacheRuntime() }
`)
    const read = async (mode = 'read') => {
      const { stdout } = await execute(process.execPath, ['cache.mjs', mode], { cwd: root, timeout: 5000 })
      return JSON.parse(stdout.trim()) as { file: string | null, native: string | null }
    }
    expect(await read('seed')).toEqual({ file: 'file entry', native: 'plugin entry' })
    await write('node_modules/holo-plugin-native-cache/driver.mjs', 'export default {}')
    await expect(execute(process.execPath, [cli, 'cache:clear', '--driver', 'native'], { cwd: root, timeout: 5000 })).rejects.toThrow('matching CacheDriverContract')
    await execute(process.execPath, [cli, 'cache:clear', '--driver', 'file'], { cwd: root, timeout: 5000 })
    await write('node_modules/holo-plugin-native-cache/driver.mjs', driver)
    expect(await read()).toEqual({ file: null, native: 'plugin entry' })
    await execute(process.execPath, [cli, 'cache:clear', '--driver', 'native'], { cwd: root, timeout: 5000 })
    expect(await read()).toEqual({ file: null, native: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('generates and applies native database cache migrations that support persistent values and locks', async () => {
  const { root, write } = await createProject()
  try {
    await write('config/database.ts', "import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: './cache.sqlite' } } })")
    await write('config/cache.ts', "import { defineCacheConfig } from '@holo-js/cache'; export default defineCacheConfig({ default: 'database', drivers: { database: { driver: 'database', connection: 'main', table: 'native_entries', lockTable: 'native_locks' } } })")
    await execute(process.execPath, [cli, 'cache:table'], { cwd: root })
    await execute(process.execPath, [cli, 'migrate'], { cwd: root })
    await write('cache.mjs', `
import { createHolo } from '@holo-js/core/runtime'
import cache from '@holo-js/cache'
const runtime = await createHolo(process.cwd())
try {
  await runtime.initialize()
  await cache.put('entry', { title: 'Native migration' }, 600)
  const count = await cache.lock('counter', 10).block(2, () => cache.increment('count'))
  console.log(JSON.stringify({ entry: await cache.get('entry'), count }))
} finally { await runtime.shutdown() }
`)
    for (const count of [1, 2]) {
      const { stdout } = await execute(process.execPath, ['cache.mjs'], { cwd: root, timeout: 5000 })
      expect(JSON.parse(stdout.trim())).toEqual({ entry: { title: 'Native migration' }, count })
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 15000)

it('decodes URL-encoded local storage names through the actual CLI once', async () => {
  const { root, write } = await createProject()
  try {
    await write('config/storage.ts', "import { defineStorageConfig } from '@holo-js/storage'; export default defineStorageConfig({ defaultDisk: 'local', disks: { local: { driver: 'local', root: './storage/app' }, media: { driver: 's3', bucket: 'media', region: 'us-east-1' } } })")
    await write('storage/app/May%20report.csv', 'report')
    await write('storage/app/nested%20folder/caf%C3%A9%20%E2%98%95.txt', 'coffee')
    await write('storage/app/nested%20folder/notes.txt$', '{"owner":"ops"}')
    await write('storage/app/Q1%20plan.pdf$', '{"owner":"finance"}')
    await write('storage/app/plain.txt', 'plain')
    await write('storage/app/Already literal.txt', 'literal')
    await write('storage/app/100%2520off.txt', 'ambiguous')
    await write('storage/app/price%24', 'reserved')
    await write('storage/app/dup%20name.txt', 'encoded')
    await write('storage/app/dup name.txt', 'literal')
    await write('storage/app/dup%20name.txt$', '{"owner":"encoded"}')
    await write('outside/secret%20file.txt', 'outside')
    await symlink(join(root, 'outside'), join(root, 'storage/app/escape'))

    const first = await execute(process.execPath, [cli, 'storage:decode-names', '--disk=local'], { cwd: root })
    expect(first.stdout).toContain('[storage] Renamed "May%20report.csv" to "May report.csv".')
    expect(first.stdout).toContain('[storage] Renamed "nested%20folder" to "nested folder".')
    expect(first.stdout).toContain('[storage] Renamed "nested folder/caf%C3%A9%20%E2%98%95.txt" to "nested folder/café ☕.txt".')
    expect(first.stdout).toContain('[storage] Skipped "100%2520off.txt": the decoded name still looks URL-encoded, so rename it by hand.')
    expect(first.stdout).toContain('[storage] Skipped "price%24": local file names ending in "$" are reserved for metadata.')
    expect(first.stdout).toContain('[storage] Skipped "dup%20name.txt": "dup name.txt" already exists.')
    expect(first.stdout).toContain('[storage] Skipped "dup%20name.txt$": its file was skipped.')
    expect(first.stdout).toContain('[storage] Renamed "Q1%20plan.pdf$" to "Q1 plan.pdf$".')
    expect(first.stdout).toContain('[storage] Renamed 4 names on disk "local".')
    expect((await readdir(join(root, 'storage/app'))).sort()).toEqual([
      '100%2520off.txt', 'Already literal.txt', 'May report.csv', 'Q1 plan.pdf$', 'dup name.txt', 'dup%20name.txt', 'dup%20name.txt$', 'escape', 'nested folder', 'plain.txt', 'price%24',
    ])
    expect((await readdir(join(root, 'storage/app/nested folder'))).sort()).toEqual(['café ☕.txt', 'notes.txt$'])
    await expect(readFile(join(root, 'storage/app/nested folder/café ☕.txt'), 'utf8')).resolves.toBe('coffee')
    await expect(readdir(join(root, 'outside'))).resolves.toEqual(['secret%20file.txt'])

    const second = await execute(process.execPath, [cli, 'storage:decode-names', '--disk=local'], { cwd: root })
    expect(second.stdout).not.toContain('Renamed "')
    expect(second.stdout).toContain('[storage] Renamed 0 names on disk "local".')

    await expect(execute(process.execPath, [cli, 'storage:decode-names', '--disk=media'], { cwd: root })).rejects.toThrow('only renames files on local disks')
    await expect(execute(process.execPath, [cli, 'storage:decode-names', '--disk=missing'], { cwd: root })).rejects.toThrow('Disk "missing" is not configured')
    await expect(execute(process.execPath, [cli, 'storage:decode-names'], { cwd: root })).rejects.toThrow('requires --disk')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
