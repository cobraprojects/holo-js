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
import { appendFileSync } from 'node:fs'
export default defineAppConfig({
  name: 'Schedule',
  key: 'base64:schedule',
  env: 'production',
  timezone: 'Africa/Cairo',
  exceptions: {
    report(error, { capability, operation }) {
      appendFileSync(${JSON.stringify(join(root, 'reports.log'))}, capability + ':' + operation + ':' + error.message + '\\n')
    },
  },
})
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

  it("reports failed tasks through the app's error reporter", { timeout: 60_000 }, async () => {
    const root = await createProject(`
import { defineSchedule } from '@holo-js/schedule'

export default defineSchedule((schedule) => {
  schedule.call(() => {
    throw new Error('closure failed')
  }).name('broken').everyMinute()
  schedule.call(() => false).name('refuses').everyMinute()
  schedule.call(() => {}).name('fine').everyMinute()
})
`)

    await runScheduleRunCommand(createIo(root), root)

    expect((await readFile(join(root, 'reports.log'), 'utf8')).split('\n').filter(Boolean)).toEqual([
      'schedule:task:closure failed',
      'schedule:task:Scheduled task [refuses] failed with exit code [1].',
    ])
  })

  it('reports that nothing is due when the app has no schedule', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-schedule-empty-'))
    temporaryDirectories.push(root)
    const io = createIo(root)

    await runScheduleRunCommand(io, root)

    expect(io.output()).toBe('[schedule] No scheduled commands are ready to run.\n')
  })
})

describe('schedule:run shutdown', () => {
  it('forwards a stop signal to the running command, waits for it, and starts no further tasks', { timeout: 30_000 }, async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-schedule-stop-'))
    temporaryDirectories.push(root)
    const { defineSchedule } = await import('@holo-js/schedule')
    const started = join(root, 'started')
    const stopped = join(root, 'stopped')
    const child = `
const { writeFileSync } = require('node:fs')
process.on('SIGTERM', () => { setTimeout(() => { writeFileSync(${JSON.stringify(stopped)}, 'SIGTERM'); process.exit(0) }, 200) })
writeFileSync(${JSON.stringify(started)}, 'yes')
setInterval(() => {}, 1000)
`
    const spawned: string[][] = []
    const sigtermListeners = process.listenerCount('SIGTERM')
    const io = createIo(root)

    const run = runScheduleRunCommand(io, root, {
      loadEnvironment: async () => ({
        schedule: defineSchedule((schedule) => {
          schedule.command('long').everyMinute()
          schedule.command('second').everyMinute()
        }),
        scheduleModule: await import('@holo-js/schedule'),
        timezone: 'UTC',
        cleanup: async () => {},
      }),
      spawnProcess: (command, args, options) => {
        spawned.push(args.slice(1))
        return spawn(command, ['-e', child], options)
      },
    })
    await expect.poll(() => readFile(started, 'utf8').catch(() => ''), { timeout: 10_000 }).toBe('yes')
    process.emit('SIGTERM', 'SIGTERM')
    await run

    expect(await readFile(stopped, 'utf8')).toBe('SIGTERM')
    expect(spawned).toEqual([['long']])
    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners)
  })
})

describe('schedule:run resources', () => {
  it('closes the app runtime when the CLI entrypoint fails to resolve or to clean up', async () => {
    const { defineSchedule } = await import('@holo-js/schedule')
    const cleanups: string[] = []
    const loadEnvironment = async () => ({
      schedule: defineSchedule(() => {}),
      scheduleModule: await import('@holo-js/schedule'),
      timezone: 'UTC',
      cleanup: async () => {
        cleanups.push('runtime')
      },
    })
    const io = createIo(tmpdir())

    await expect(runScheduleRunCommand(io, tmpdir(), {
      loadEnvironment,
      resolveCliEntrypoint: async () => {
        throw new Error('bundle failed')
      },
    })).rejects.toThrow('bundle failed')
    await expect(runScheduleRunCommand(io, tmpdir(), {
      loadEnvironment,
      resolveCliEntrypoint: async () => ({
        path: 'holo.mjs',
        async cleanup() {
          throw new Error('cleanup failed')
        },
      }),
    })).rejects.toThrow('cleanup failed')

    expect(cleanups).toEqual(['runtime', 'runtime'])
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

describe('schedule configuration', () => {
  it('defines tasks after the app configuration is loaded', { timeout: 60_000 }, async () => {
    const root = await createProject(`
import { config } from '@holo-js/config'
import { defineSchedule } from '@holo-js/schedule'

export default defineSchedule((schedule) => {
  schedule.command('privacy:maintain').dailyAt('03:00').timezone(config('app.timezone') === 'Africa/Cairo' ? 'Asia/Tokyo' : 'UTC')
})
`)
    const io = createIo(root)

    await runScheduleListCommand(io, root, { now: () => new Date('2026-11-02T10:02:00Z') })

    expect(io.output()).toBe('0 3 * * *  holo privacy:maintain  Next Due: 2026-11-02 20:00:00 Africa/Cairo\n')
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

  it('leaves no signal handlers behind when the CLI entrypoint fails to resolve', async () => {
    const sigtermListeners = process.listenerCount('SIGTERM')

    await expect(runScheduleWorkCommand(createIo(tmpdir()), tmpdir(), {
      resolveCliEntrypoint: async () => {
        throw new Error('bundle failed')
      },
    })).rejects.toThrow('bundle failed')

    expect(process.listenerCount('SIGTERM')).toBe(sigtermListeners)
  })

  it('keeps waiting for a running child that reports an error until it closes', async () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      signals: [] as NodeJS.Signals[],
      kill(signal: NodeJS.Signals) {
        child.signals.push(signal)
        return true
      },
    }) as FakeChild & { pid: number }
    let minutes = 0
    let finished = false

    const work = runScheduleWorkCommand(createIo(tmpdir()), tmpdir(), {
      resolveCliEntrypoint: async () => ({ path: 'holo.mjs', async cleanup() {} }),
      spawnProcess: () => child,
      async waitForNextMinute() {
        minutes += 1
        if (minutes === 2) {
          child.emit('error', new Error('kill EPERM'))
          process.emit('SIGTERM', 'SIGTERM')
        }
        await new Promise(resolvePromise => setImmediate(resolvePromise))
      },
    }).then(() => {
      finished = true
    })
    await new Promise(resolvePromise => setTimeout(resolvePromise, 50))

    expect(finished).toBe(false)
    expect(child.signals).toEqual(['SIGTERM'])
    child.emit('close', null)
    await work
    expect(finished).toBe(true)
  })

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
