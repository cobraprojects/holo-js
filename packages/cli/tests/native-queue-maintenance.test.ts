import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { redisQueueDriverFactory } from '../../queue-redis/src'
import { startRedisService } from '../../session/tests/support/redis'

const execute = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')

it.each(['builtin', 'plugin'] as const)('clears only the selected real Redis queue through the %s driver without booting unrelated application modules', async mode => {
  const service = await startRedisService()
  const port = service.ports[0]
  if (port === undefined) throw new Error('Expected an owned Redis port')
  const root = await mkdtemp(join(tmpdir(), 'holo-native-queue-maintenance-'))
  const drivers = ['emails', 'reports'].map(queue => redisQueueDriverFactory.create({
    name: 'redis', driver: 'redis', connection: 'default', queue, retryAfter: 30, blockFor: 0,
    redis: { host: '127.0.0.1', port, db: 0 },
  }, { async execute() { throw new Error('Maintenance does not execute jobs') } }))
  try {
    await mkdir(join(root, 'config'), { recursive: true })
    await mkdir(join(root, 'server/jobs'), { recursive: true })
    await mkdir(join(root, 'node_modules'), { recursive: true })
    await symlink(join(repoRoot, 'packages'), join(root, 'node_modules/@holo-js'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
    await writeFile(join(root, 'config/app.mjs'), `import { defineAppConfig } from '@holo-js/config'; export default defineAppConfig({ name: 'Queue Maintenance', plugins: ${mode === 'plugin' ? "['holo-plugin-native-queue']" : '[]'} })`)
    await writeFile(join(root, 'config/database.mjs'), "import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'postgres', url: 'postgres://127.0.0.1:1/unreachable' } } })")
    await writeFile(join(root, 'server/jobs/Broken.ts'), 'throw new Error("Unrelated job module must not load during maintenance")')
    await writeFile(join(root, 'config/queue.mjs'), `import { defineQueueConfig } from '@holo-js/queue'; export default defineQueueConfig({ default: 'redis', failed: false, connections: { redis: { driver: '${mode === 'plugin' ? 'native' : 'redis'}', queue: 'emails', connection: 'default', retryAfter: 30, blockFor: 0 } } })`)
    await writeFile(join(root, 'config/redis.mjs'), `import { defineRedisConfig } from '@holo-js/kernel'; export default defineRedisConfig({ default: 'default', connections: { default: { host: '127.0.0.1', port: ${port}, db: 0 } } })`)
    const pluginRoot = join(root, 'node_modules/holo-plugin-native-queue')
    const nativeDriver = `import { redisQueueDriverFactory } from '@holo-js/queue-redis'; export default { driver: 'native', create(connection, context) { return redisQueueDriverFactory.create({ ...connection, driver: 'redis', redis: { host: '127.0.0.1', port: ${port}, db: 0 } }, context) } }`
    if (mode === 'plugin') {
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({ name: 'holo-plugin-native-queue', type: 'module', holo: { plugin: './plugin.mjs' } }))
      await writeFile(join(pluginRoot, 'plugin.mjs'), "export default { id: 'native-queue', contributes: { queue: { drivers: { native: { runtime: './driver.mjs' } } } } }")
      await writeFile(join(pluginRoot, 'driver.mjs'), 'export default {}')
      await expect(execute(process.execPath, [join(repoRoot, 'packages/cli/dist/bin/holo.mjs'), 'queue:clear', 'redis'], { cwd: root, timeout: 5000 })).rejects.toThrow('matching QueueDriverFactory')
      await writeFile(join(pluginRoot, 'driver.mjs'), nativeDriver)
    }
    await Promise.all(drivers.map(async (driver, index) => driver.dispatch({
      id: randomUUID(), name: 'send', connection: 'redis', queue: index === 0 ? 'emails' : 'reports',
      payload: { message: 'queued' }, attempts: 0, maxAttempts: 3, createdAt: Date.now(),
    })))
    const cleared = await execute(process.execPath, [join(repoRoot, 'packages/cli/dist/bin/holo.mjs'), 'queue:clear', 'redis', '--queue', 'emails'], { cwd: root })
    expect(cleared.stdout).toContain('Cleared 1 pending job(s).')
    const emails = drivers[0]
    const reports = drivers[1]
    if (!emails || !reports) throw new Error('Expected both queue drivers')
    expect(await emails.reserve({ timeout: 0 })).toBeNull()
    const untouched = await reports.reserve({ timeout: 0 })
    expect(untouched?.envelope.payload).toEqual({ message: 'queued' })
    if (!untouched) throw new Error('Expected the unrelated queue job')
    await reports.release(untouched, { delaySeconds: 0 })
    const repeated = await execute(process.execPath, [join(repoRoot, 'packages/cli/dist/bin/holo.mjs'), 'queue:clear', 'redis', '--queue', 'emails'], { cwd: root })
    expect(repeated.stdout).toContain('Cleared 0 pending job(s).')
    const remaining = await execute(process.execPath, [join(repoRoot, 'packages/cli/dist/bin/holo.mjs'), 'queue:clear', 'redis', '--queue', 'reports'], { cwd: root })
    expect(remaining.stdout).toContain('Cleared 1 pending job(s).')
    expect(await reports.reserve({ timeout: 0 })).toBeNull()
  } finally {
    await Promise.all(drivers.map(driver => driver.close()))
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
