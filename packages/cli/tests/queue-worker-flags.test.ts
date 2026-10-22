import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import { buildQueueWorkArgs } from '../src/queue'
import { parseBackoffFlag } from '../src/parsing'
import type { IoStreams } from '../src/cli-types'

const execute = promisify(execFile)
const repoRoot = resolve(import.meta.dirname, '../../..')
const builtCli = join(repoRoot, 'packages/cli/dist/bin/holo.mjs')

function createIo(projectRoot: string): IoStreams {
  return {
    cwd: projectRoot,
    stdin: new PassThrough() as never,
    stdout: new PassThrough() as never,
    stderr: new PassThrough() as never,
  }
}

async function createAlwaysFailingQueueProject(root: string): Promise<string> {
  const attemptLog = join(root, 'attempts.log')
  const write = async (name: string, content: string) => {
    await mkdir(dirname(join(root, name)), { recursive: true })
    await writeFile(join(root, name), content)
  }
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(join(repoRoot, 'packages'), join(root, 'node_modules/@holo-js'))
  await write('package.json', JSON.stringify({ type: 'module' }))
  await write('config/app.mjs', "import { defineAppConfig } from '@holo-js/config'; export default defineAppConfig({ name: 'Queue Worker Flags' })")
  await write('config/database.mjs', `import { defineDatabaseConfig } from '@holo-js/db'; export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ${JSON.stringify(join(root, 'queue.sqlite'))} } } })`)
  await write('config/queue.mjs', "import { defineQueueConfig } from '@holo-js/queue'; export default defineQueueConfig({ default: 'database', failed: false, connections: { database: { driver: 'database', connection: 'main' } } })")
  await write('server/jobs/AlwaysFails.mjs', `
import { appendFile } from 'node:fs/promises'
import { defineJob } from '@holo-js/queue'
export default defineJob({
  async handle() {
    await appendFile(${JSON.stringify(attemptLog)}, Date.now() + '\\n')
    throw new Error('AlwaysFails always fails')
  },
})
`)
  await write('dispatch.mjs', `
import { createHolo } from '@holo-js/core/runtime'
const runtime = await createHolo(process.cwd())
await runtime.initialize()
try {
  const { default: AlwaysFails } = await import('./server/jobs/AlwaysFails.mjs')
  await AlwaysFails.dispatch({})
} finally {
  await runtime.shutdown()
}
`)
  return attemptLog
}

describe('queue:work --backoff', () => {
  it('parses one retry delay or a comma-separated list of retry delays', () => {
    expect(parseBackoffFlag({ backoff: '5' })).toBe(5)
    expect(parseBackoffFlag({ backoff: '5, 10,30' })).toEqual([5, 10, 30])
    expect(parseBackoffFlag({})).toBeUndefined()
  })

  it('rejects a --backoff flag with no operand instead of treating it as absent', () => {
    expect(() => parseBackoffFlag({ backoff: true }))
      .toThrow('Flag "--backoff" requires a value.')
    expect(() => parseBackoffFlag({ backoff: [] }))
      .toThrow('Flag "--backoff" requires a value.')
    expect(parseBackoffFlag({})).toBeUndefined()
  })

  it('rejects a retry delay that is not a non-negative integer', () => {
    expect(() => parseBackoffFlag({ backoff: '5,x' }))
      .toThrow('Flag "--backoff" must be a non-negative integer or a comma-separated list of them.')
    expect(() => parseBackoffFlag({ backoff: '-1' }))
      .toThrow('Flag "--backoff" must be a non-negative integer or a comma-separated list of them.')
  })

  it('forwards the backoff list to queue:listen worker processes', () => {
    expect(buildQueueWorkArgs({ tries: '2', backoff: '5,10' })).toEqual(['queue:work', '--tries', '2', '--backoff', '5,10'])
  })

  it('retries a failing job for exactly --tries attempts, spaced by --backoff, on a real database queue', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-queue-worker-flags-'))
    try {
      const attemptLog = await createAlwaysFailingQueueProject(root)
      await execute(process.execPath, [builtCli, 'queue:table'], { cwd: root })
      await execute(process.execPath, [builtCli, 'migrate'], { cwd: root })
      await execute(process.execPath, ['dispatch.mjs'], { cwd: root })

      await expect(runCli([
        'queue:work', '--tries', '3', '--backoff', '1', '--sleep', '0', '--max-jobs', '10', '--max-time', '5',
      ], createIo(root))).resolves.toBe(0)

      const attemptTimes = (await readFile(attemptLog, 'utf8')).trim().split('\n').map(Number)
      const retryDelays = attemptTimes.slice(1).map((attemptTime, index) => attemptTime - attemptTimes[index]!)
      expect(attemptTimes).toHaveLength(3)
      for (const retryDelay of retryDelays) {
        expect(retryDelay).toBeGreaterThanOrEqual(1000)
        expect(retryDelay).toBeLessThan(2000)
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
