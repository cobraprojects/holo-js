import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { runScheduleListCommand, runScheduleRunCommand, runScheduleWorkCommand } from '../src/schedule'
import type { IoStreams, SpawnProcessLike } from '../src/cli-types'

const temporaryDirectories: string[] = []
const sourceCliEntrypoint = resolve(import.meta.dirname, '../src/bin/holo.ts')

function createIo(cwd: string): IoStreams & { readonly output: () => string, readonly errors: () => string } {
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  let output = ''
  let errors = ''
  stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  stderr.on('data', (chunk: Buffer) => {
    errors += chunk.toString()
  })
  return {
    cwd,
    stdin: process.stdin,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    output: () => output,
    errors: () => errors,
  }
}

async function createProject(schedule: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-schedule-'))
  temporaryDirectories.push(root)
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../..'), join(root, 'node_modules/@holo-js'), 'dir')
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'server/jobs'), { recursive: true })
  await mkdir(join(root, 'server/commands'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from '@holo-js/config'
export default defineAppConfig({ name: 'Schedule', key: 'base64:schedule', env: 'production', timezone: 'Africa/Cairo' })
`)
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from '@holo-js/db'
export default defineDatabaseConfig({ defaultConnection: 'main', connections: { main: { driver: 'sqlite', url: ':memory:' } } })
`)
  await writeFile(join(root, 'config/queue.ts'), `
import { defineQueueConfig } from '@holo-js/queue'
export default defineQueueConfig({ default: 'sync', failed: false, connections: { sync: { driver: 'sync' } } })
`)
  await writeFile(join(root, 'config/cache.ts'), `
import { defineCacheConfig } from '@holo-js/cache'
export default defineCacheConfig({ default: 'memory', drivers: { memory: { driver: 'memory' } } })
`)
  const log = JSON.stringify(join(root, 'ran.log'))
  await writeFile(join(root, 'server/jobs/send-digest.ts'), `
const LOG = ${log}
import { appendFile } from 'node:fs/promises'
import { defineJob } from '@holo-js/queue'
export default defineJob<{ userId: number }>({
  async handle(payload) {
    await appendFile(LOG, 'job:' + payload.userId + '\\n')
  },
})
`)
  await writeFile(join(root, 'server/commands/marker.ts'), `
const LOG = ${log}
import { appendFile } from 'node:fs/promises'
import { defineCommand } from '@holo-js/cli'
export default defineCommand({
  description: 'Write a marker.',
  async run(context) {
    await appendFile(LOG, 'command:' + context.args.join(',') + '\\n')
  },
})
`)
  await writeFile(join(root, 'server/schedule.ts'), schedule.replaceAll('LOG', JSON.stringify(join(root, 'ran.log'))))
  return root
}

async function readLog(root: string): Promise<string[]> {
  const contents = await readFile(join(root, 'ran.log'), 'utf8').catch(() => '')
  return contents.split('\n').filter(Boolean).sort()
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('schedule:run', () => {
  it('runs due commands, jobs, and closures declared in server/schedule.ts', { timeout: 60_000 }, async () => {
    const root = await createProject(`
import { appendFile } from 'node:fs/promises'
import { defineSchedule } from '@holo-js/schedule'
import SendDigest from './jobs/send-digest'

export default defineSchedule((schedule) => {
  schedule.command('marker first').everyMinute().withoutOverlapping().onOneServer()
  schedule.job(SendDigest, { userId: 7 }).everyMinute()
  schedule.call(async () => {
    await appendFile(LOG, 'call\\n')
  }).everyMinute().withoutOverlapping()
  schedule.call(async () => {
    throw new Error('closure failed')
  }).name('broken').everyMinute()
  schedule.call(async () => {
    await appendFile(LOG, 'not-due\\n')
  }).yearlyOn(2, 29)
})
`)
    const io = createIo(root)

    await runScheduleRunCommand(io, root, {
      spawnProcess: (command, args, options) => spawn(command, ['--import', import.meta.resolve('tsx'), sourceCliEntrypoint, ...args.slice(1)], options),
    })

    expect(await readLog(root)).toEqual(['call', 'command:first', 'job:7'])
    expect(io.output()).toContain('[schedule] Running [holo marker first] DONE')
    expect(io.output()).toContain('[schedule] Running [send-digest] DONE')
    expect(io.output()).toContain('[schedule] Running [Closure] DONE')
    expect(io.output()).toContain('[schedule] Running [broken] FAIL')
    expect(io.errors()).toContain('closure failed')
  })

  it('reports that nothing is due when the app has no schedule', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-schedule-empty-'))
    temporaryDirectories.push(root)
    const io = createIo(root)

    await runScheduleRunCommand(io, root)

    expect(io.output()).toBe('[schedule] No scheduled commands are ready to run.\n')
  })
})

describe('schedule:list', () => {
  it('lists each task with its next due time in the app timezone', { timeout: 60_000 }, async () => {
    const root = await createProject(`
import { defineSchedule } from '@holo-js/schedule'
import SendDigest from './jobs/send-digest'

export default defineSchedule((schedule) => {
  schedule.command('privacy:maintain').daily()
  schedule.job(SendDigest, { userId: 7 }).everyFiveMinutes()
  schedule.call(() => {}).hourly().timezone('UTC')
})
`)
    const io = createIo(root)

    await runScheduleListCommand(io, root, { now: () => new Date('2026-11-02T10:02:00Z') })

    expect(io.output().split('\n').filter(Boolean)).toEqual([
      '0 0 * * *    holo privacy:maintain  Next Due: 2026-11-03 00:00:00 Africa/Cairo',
      '*/5 * * * *  send-digest            Next Due: 2026-11-02 12:05:00 Africa/Cairo',
      '0 * * * *    Closure                Next Due: 2026-11-02 13:00:00 Africa/Cairo',
    ])
  })
})

describe('schedule:work', () => {
  type FakeChild = SpawnProcessLike & EventEmitter & { readonly signals: NodeJS.Signals[] }

  function fakeChild(): FakeChild {
    const child = new EventEmitter() as FakeChild
    Object.assign(child, {
      signals: [] as NodeJS.Signals[],
      kill(signal: NodeJS.Signals) {
        child.signals.push(signal)
        setImmediate(() => child.emit('close', null))
        return true
      },
    })
    return child
  }

  it('starts schedule:run each minute, forwards stop signals, and waits for running children', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-schedule-work-'))
    temporaryDirectories.push(root)
    const io = createIo(root)
    const children: FakeChild[] = []
    let minutes = 0
    const sigtermListeners = process.listenerCount('SIGTERM')

    await runScheduleWorkCommand(io, root, {
      spawnProcess(_command, args) {
        expect(args.at(-1)).toBe('schedule:run')
        const output = new PassThrough()
        const child = Object.assign(fakeChild(), { stdout: output })
        children.push(child)
        output.write('[schedule] Running [Closure] DONE\n')
        return child
      },
      async waitForNextMinute() {
        minutes += 1
        if (minutes === 3) process.emit('SIGTERM', 'SIGTERM')
        await new Promise(resolvePromise => setImmediate(resolvePromise))
      },
    })

    expect(children).toHaveLength(2)
    expect(children.map(child => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']])
    expect(io.output()).toContain('[schedule] Running [Closure] DONE')
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners)
  })
})
