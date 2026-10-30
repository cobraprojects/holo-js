import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { configureCacheRuntime, resetCacheRuntime } from '@holo-js/cache'
import {
  configureQueueRuntime,
  defineJob,
  registerQueueJob,
  resetQueueRegistry,
  resetQueueRuntime,
} from '@holo-js/queue'
import {
  CronExpressionError,
  defineSchedule,
  listScheduledTasks,
  runDueScheduledTasks,
  type ScheduleDefinition,
  type ScheduleRunOptions,
} from '../src'

const MIDNIGHT_UTC = new Date('2026-11-02T00:00:00Z')

function runAt(definition: ScheduleDefinition, now: Date, overrides: Partial<ScheduleRunOptions> = {}) {
  return runDueScheduledTasks(definition, {
    now,
    timezone: 'UTC',
    runCommand: async () => 0,
    ...overrides,
  })
}

async function expressions(definition: ScheduleDefinition): Promise<string[]> {
  const tasks = await listScheduledTasks(definition, { now: MIDNIGHT_UTC, timezone: 'UTC' })
  return tasks.map(task => task.expression)
}

function deferred(): { promise: Promise<void>, resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

beforeEach(() => {
  configureCacheRuntime({ config: { default: 'memory', drivers: { memory: { driver: 'memory' } } } })
})

afterEach(() => {
  resetCacheRuntime()
})

describe('frequencies', () => {
  it('produces Laravel cron expressions', async () => {
    const definition = defineSchedule((schedule) => {
      schedule.command('a').everyMinute()
      schedule.command('b').everyFiveMinutes()
      schedule.command('c').hourly()
      schedule.command('d').hourlyAt([5, 35])
      schedule.command('e').everyOddHour(10)
      schedule.command('f').daily()
      schedule.command('g').dailyAt('13:30')
      schedule.command('h').twiceDaily(1, 13)
      schedule.command('i').weekdays().hourly()
      schedule.command('j').weekly()
      schedule.command('k').weeklyOn(1, '8:00')
      schedule.command('l').monthly()
      schedule.command('m').monthlyOn(4, '15:00')
      schedule.command('n').twiceMonthly(1, 16, '13:00')
      schedule.command('o').quarterly()
      schedule.command('p').yearlyOn(6, 1, '17:00')
      schedule.command('q').weekends().at('9')
      schedule.command('r').cron('15 2 * * 1-5')
    })

    expect(await expressions(definition)).toEqual([
      '* * * * *',
      '*/5 * * * *',
      '0 * * * *',
      '5,35 * * * *',
      '10 1-23/2 * * *',
      '0 0 * * *',
      '30 13 * * *',
      '0 1,13 * * *',
      '0 * * * 1-5',
      '0 0 * * 0',
      '0 8 * * 1',
      '0 0 1 * *',
      '0 15 4 * *',
      '0 13 1,16 * *',
      '0 0 1 1-12/3 *',
      '0 17 1 6 *',
      '0 9 * * 6,0',
      '15 2 * * 1-5',
    ])
  })

  it('combines frequency methods with cron macros', async () => {
    const definition = defineSchedule((schedule) => {
      schedule.command('a').cron('@daily').weekdays()
      schedule.command('b').cron('@hourly').hourlyAt(15)
    })

    expect(await expressions(definition)).toEqual(['0 0 * * 1-5', '15 * * * *'])
  })

  it('rejects invalid expressions, times, and timezones when the scheduler reads the schedule', async () => {
    const read = (definition: ScheduleDefinition) => listScheduledTasks(definition, { now: MIDNIGHT_UTC, timezone: 'UTC' })

    await expect(read(defineSchedule(schedule => schedule.call(() => {}).cron('61 * * * *')))).rejects.toThrow(CronExpressionError)
    await expect(read(defineSchedule(schedule => schedule.call(() => {}).dailyAt('24:00')))).rejects.toThrow('Invalid time "24:00"')
    await expect(read(defineSchedule(schedule => schedule.call(() => {}).timezone('Mars/Olympus')))).rejects.toThrow('Invalid timezone')
  })
})

describe('next due dates', () => {
  it('resolves the next run in the task timezone, including across daylight saving changes', async () => {
    const definition = defineSchedule((schedule) => {
      schedule.call(() => {}).daily().timezone('America/New_York')
      schedule.call(() => {}).dailyAt('02:30').timezone('America/New_York')
      schedule.call(() => {}).everyFifteenMinutes()
    })

    const tasks = await listScheduledTasks(definition, { now: new Date('2026-03-07T12:00:00Z'), timezone: 'UTC' })

    expect(tasks.map(task => task.nextDueAt.toISOString())).toEqual([
      '2026-03-08T05:00:00.000Z',
      '2026-03-09T06:30:00.000Z',
      '2026-03-07T12:15:00.000Z',
    ])
    expect(tasks.map(task => task.timezone)).toEqual(['America/New_York', 'America/New_York', 'UTC'])
  })

  it('does not skip a day when the timezone jumps two hours', async () => {
    const definition = defineSchedule(schedule => schedule.call(() => {}).cron('0 0 30 3 *').timezone('Antarctica/Troll'))

    const [task] = await listScheduledTasks(definition, { now: new Date('2026-03-28T23:59:00Z'), timezone: 'UTC' })

    expect(task?.nextDueAt.toISOString()).toBe('2026-03-29T22:00:00.000Z')
  })

  it('matches either restricted day field, as cron does', async () => {
    const definition = defineSchedule(schedule => schedule.call(() => {}).cron('0 0 13 * 5'))

    const [task] = await listScheduledTasks(definition, { now: new Date('2026-11-01T00:00:00Z'), timezone: 'UTC' })

    expect(task?.nextDueAt.toISOString()).toBe('2026-11-06T00:00:00.000Z')
  })

  it("supports Laravel's last-day, nearest-weekday, and nth-weekday syntax", async () => {
    const cases = [
      ['0 0 L * *', '2026-02-10T00:00:00Z', '2026-02-28T00:00:00.000Z'],
      ['0 0 15W * *', '2026-08-01T00:00:00Z', '2026-08-14T00:00:00.000Z'],
      ['0 0 1W * *', '2026-07-31T12:00:00Z', '2026-08-03T00:00:00.000Z'],
      ['0 0 * * 5L', '2026-10-01T00:00:00Z', '2026-10-30T00:00:00.000Z'],
      ['0 0 * * 1#2', '2026-11-01T00:00:00Z', '2026-11-09T00:00:00.000Z'],
      ['0 0 * * MON#1', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00.000Z'],
    ] as const

    for (const [expression, now, expected] of cases) {
      const definition = defineSchedule(schedule => schedule.call(() => {}).cron(expression))
      const [task] = await listScheduledTasks(definition, { now: new Date(now), timezone: 'UTC' })
      expect([expression, task?.nextDueAt.toISOString()]).toEqual([expression, expected])
    }
  })

  it('reports an expression that never matches', async () => {
    const definition = defineSchedule(schedule => schedule.call(() => {}).cron('0 0 30 2 *'))

    await expect(listScheduledTasks(definition, { now: MIDNIGHT_UTC, timezone: 'UTC' })).rejects.toThrow(CronExpressionError)
  })
})

describe('running due tasks', () => {
  it('runs only the tasks due in the current minute of their timezone', async () => {
    const ran: string[] = []
    const definition = defineSchedule((schedule) => {
      schedule.call(() => ran.push('utc-midnight')).daily()
      schedule.call(() => ran.push('cairo-midnight')).daily().timezone('Africa/Cairo')
      schedule.call(() => ran.push('hourly')).hourly()
      schedule.call(() => ran.push('five-past')).hourlyAt(5)
    })

    await runAt(definition, new Date('2026-11-02T00:00:42Z'))
    await runAt(definition, new Date('2026-11-01T22:00:00Z'))

    expect(ran).toEqual(['utc-midnight', 'hourly', 'cairo-midnight', 'hourly'])
  })

  it('uses the default timezone for tasks without their own', async () => {
    const ran: string[] = []
    const definition = defineSchedule(schedule => schedule.call(() => ran.push('daily')).daily())

    await runAt(definition, MIDNIGHT_UTC, { timezone: 'Asia/Tokyo' })
    await runAt(definition, new Date('2026-11-01T15:00:00Z'), { timezone: 'Asia/Tokyo' })

    expect(ran).toEqual(['daily'])
  })

  it('runs commands through the runner and fails them on a non-zero exit code', async () => {
    const commands: string[][] = []
    const definition = defineSchedule((schedule) => {
      schedule.command('privacy:maintain --chunk "100 rows"').daily()
      schedule.command('reports:send').daily()
    })

    const reports = await runAt(definition, MIDNIGHT_UTC, {
      async runCommand(argv) {
        commands.push([...argv])
        return argv[0] === 'reports:send' ? 3 : 0
      },
    })

    expect(commands).toEqual([['privacy:maintain', '--chunk', '100 rows'], ['reports:send']])
    expect(reports.map(report => [report.summary, report.outcome, report.error?.message])).toEqual([
      ['holo privacy:maintain --chunk "100 rows"', 'ran', undefined],
      ['holo reports:send', 'failed', 'Scheduled command [holo reports:send] failed with exit code [3].'],
    ])
  })

  it('splits command arguments like a shell word list without running a shell', async () => {
    const commands: string[][] = []
    const definition = defineSchedule((schedule) => {
      schedule.command(`backup:run --label="nightly backup" --note='it''s fine' a\\ b "say \\"hi\\"" $HOME;rm`).daily()
    })

    await runAt(definition, MIDNIGHT_UTC, {
      async runCommand(argv) {
        commands.push([...argv])
        return 0
      },
    })

    expect(commands).toEqual([['backup:run', '--label=nightly backup', '--note=its fine', 'a b', 'say "hi"', '$HOME;rm']])
  })

  it('reports a failing task and still runs the tasks after it', async () => {
    const ran: string[] = []
    const finished: string[] = []
    const definition = defineSchedule((schedule) => {
      schedule.call(() => {
        throw new Error('boom')
      }).name('broken').everyMinute()
      schedule.call(() => ran.push('after')).everyMinute()
    })

    const reports = await runAt(definition, MIDNIGHT_UTC, { onTaskFinished: report => finished.push(report.outcome) })

    expect(reports[0]).toMatchObject({ summary: 'broken', outcome: 'failed', error: new Error('boom') })
    expect(ran).toEqual(['after'])
    expect(finished).toEqual(['failed', 'ran'])
  })
  it('fails a function that returns false, as Laravel does', async () => {
    const definition = defineSchedule((schedule) => {
      schedule.call(() => false).name('refuses').everyMinute()
      schedule.call(() => 0).name('returns-zero').everyMinute()
    })

    const reports = await runAt(definition, MIDNIGHT_UTC)

    expect(reports.map(report => [report.summary, report.outcome, report.error?.message])).toEqual([
      ['refuses', 'failed', 'Scheduled task [refuses] failed with exit code [1].'],
      ['returns-zero', 'ran', undefined],
    ])
  })
})

describe('withoutOverlapping', () => {
  it('skips a run while the previous run is in progress and runs again once it ends', async () => {
    const gate = deferred()
    let runs = 0
    const definition = defineSchedule(schedule => schedule.call(async () => {
      runs += 1
      await gate.promise
    }).everyMinute().withoutOverlapping())

    const first = runAt(definition, MIDNIGHT_UTC)
    await expect.poll(() => runs).toBe(1)
    const overlapping = await runAt(definition, new Date('2026-11-02T00:01:00Z'))
    gate.resolve()
    await first
    const next = await runAt(definition, new Date('2026-11-02T00:02:00Z'))

    expect(overlapping.map(report => report.outcome)).toEqual(['skipped-overlapping'])
    expect(next.map(report => report.outcome)).toEqual(['ran'])
    expect(runs).toBe(2)
  })

  it('releases the lock when the task fails', async () => {
    let runs = 0
    const definition = defineSchedule(schedule => schedule.call(() => {
      runs += 1
      throw new Error('boom')
    }).everyMinute().withoutOverlapping())

    await runAt(definition, MIDNIGHT_UTC)
    await runAt(definition, new Date('2026-11-02T00:01:00Z'))

    expect(runs).toBe(2)
  })

  it('locks unnamed closures independently of each other', async () => {
    const gate = deferred()
    const ran: string[] = []
    const definition = defineSchedule((schedule) => {
      schedule.call(async () => {
        ran.push('slow')
        await gate.promise
      }).everyMinute().withoutOverlapping()
      schedule.call(() => ran.push('fast')).everyMinute().withoutOverlapping()
    })
    const fastOnly = defineSchedule(schedule => schedule.call(() => ran.push('fast')).everyMinute().withoutOverlapping())

    const first = runAt(definition, MIDNIGHT_UTC)
    await expect.poll(() => ran).toEqual(['slow'])
    await runAt(fastOnly, MIDNIGHT_UTC)
    gate.resolve()
    await first

    expect(ran).toEqual(['slow', 'fast', 'fast'])
  })
})

describe('onOneServer', () => {
  it('lets one run take a task for a given minute', async () => {
    let runs = 0
    const serverOne = defineSchedule(schedule => schedule.command('privacy:maintain').everyMinute().onOneServer())
    const serverTwo = defineSchedule(schedule => schedule.command('privacy:maintain').everyMinute().onOneServer())
    const runCommand = async () => {
      runs += 1
      return 0
    }

    const first = await runAt(serverOne, MIDNIGHT_UTC, { runCommand })
    const second = await runAt(serverTwo, new Date('2026-11-02T00:00:30Z'), { runCommand })
    const nextMinute = await runAt(serverTwo, new Date('2026-11-02T00:01:00Z'), { runCommand })

    expect([first, second, nextMinute].map(reports => reports[0]?.outcome)).toEqual(['ran', 'skipped-other-server', 'ran'])
    expect(second[0]?.summary).toBe('holo privacy:maintain')
    expect(runs).toBe(2)
  })
})

describe('jobs', () => {
  beforeEach(() => {
    configureQueueRuntime({ config: { default: 'sync', connections: { sync: { driver: 'sync' } } } })
  })

  afterEach(() => {
    resetQueueRegistry()
    resetQueueRuntime()
  })

  it('dispatches the job with its payload and names the task after the job', async () => {
    const handled: number[] = []
    const SendDigest = defineJob<{ userId: number }>({
      handle(payload) {
        handled.push(payload.userId)
      },
    })
    registerQueueJob(SendDigest, { name: 'reports.send-digest' })
    const definition = defineSchedule(schedule => schedule.job(SendDigest, { userId: 7 }).everyFiveMinutes())

    const reports = await runAt(definition, MIDNIGHT_UTC)

    expect(handled).toEqual([7])
    expect(reports.map(report => [report.summary, report.outcome])).toEqual([['reports.send-digest', 'ran']])
  })
})
