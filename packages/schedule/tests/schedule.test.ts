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

  it('accepts a question mark only as a whole day field and steps only over ranges, as Laravel does', async () => {
    const read = (expression: string) => listScheduledTasks(
      defineSchedule(schedule => schedule.call(() => {}).cron(expression)),
      { now: MIDNIGHT_UTC, timezone: 'UTC' },
    )

    for (const expression of ['? * * * *', '0 ? * * *', '0 0 * ? *', '0 0 ? * ?', '?/5 * * * *', '0 0 ?/2 * *', '0 0 * * ?,1', '5/10 * * * *']) {
      await expect(read(expression), expression).rejects.toThrow(CronExpressionError)
    }
    expect((await read('0 0 ? * 1'))[0]?.nextDueAt.toISOString()).toBe('2026-11-09T00:00:00.000Z')
    expect((await read('0 0 15 * ?'))[0]?.nextDueAt.toISOString()).toBe('2026-11-15T00:00:00.000Z')
  })

  it('rejects invalid expressions, times, and timezones when the scheduler reads the schedule', async () => {
    const read = (definition: ScheduleDefinition) => listScheduledTasks(definition, { now: MIDNIGHT_UTC, timezone: 'UTC' })

    await expect(read(defineSchedule(schedule => schedule.call(() => {}).cron('61 * * * *')))).rejects.toThrow(CronExpressionError)
    await expect(read(defineSchedule(schedule => schedule.call(() => {}).dailyAt('24:00')))).rejects.toThrow('Invalid time "24:00"')
    await expect(read(defineSchedule(schedule => schedule.call(() => {}).timezone('Mars/Olympus')))).rejects.toThrow('Invalid timezone')
  })
})

describe('definitions', () => {
  it('rejects an asynchronous schedule definition instead of losing its tasks', async () => {
    const definition = defineSchedule(async (schedule) => {
      await Promise.resolve()
      schedule.call(() => {}).daily()
    })

    await expect(listScheduledTasks(definition, { now: MIDNIGHT_UTC, timezone: 'UTC' }))
      .rejects.toThrow('[@holo-js/schedule] defineSchedule() callbacks must define tasks synchronously.')
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
      ['0 9 31W * *', '2026-10-31T23:00:00Z', '2026-11-01T09:00:00.000Z'],
      ['0 9 LW * *', '2026-11-01T00:00:00Z', '2026-11-02T09:00:00.000Z'],
      ['0 9 LW * *', '2026-11-03T00:00:00Z', '2026-12-30T09:00:00.000Z'],
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

  it('finds a leap day across a century that skips one', async () => {
    const definition = defineSchedule(schedule => schedule.call(() => {}).yearlyOn(2, 29))

    const [task] = await listScheduledTasks(definition, { now: new Date('2096-03-01T00:00:00Z'), timezone: 'UTC' })

    expect(task?.nextDueAt.toISOString()).toBe('2104-02-29T00:00:00.000Z')
  })

  it('reads Sunday in day-of-week ranges the way Laravel does', async () => {
    const saturdayMorning = new Date('2026-11-07T10:00:00Z')
    const sundayMorning = new Date('2026-11-08T10:00:00Z')
    const cases = [
      ['0 9 * * FRI-SUN', saturdayMorning, '2026-11-13T09:00:00.000Z'],
      ['0 9 * * FRI-SUN', sundayMorning, '2026-11-13T09:00:00.000Z'],
      ['0 9 * * MON-SUN', saturdayMorning, '2026-11-09T09:00:00.000Z'],
      ['0 9 * * SAT-SUN', saturdayMorning, '2026-11-14T09:00:00.000Z'],
      ['0 9 * * 5-0', saturdayMorning, '2026-11-08T09:00:00.000Z'],
      ['0 9 * * 5-0', sundayMorning, '2026-11-13T09:00:00.000Z'],
      ['0 9 * * 5-7', saturdayMorning, '2026-11-08T09:00:00.000Z'],
      ['0 9 * * 7-5', saturdayMorning, '2026-11-08T09:00:00.000Z'],
      ['0 9 * * 7-5', new Date('2026-11-06T10:00:00Z'), '2026-11-08T09:00:00.000Z'],
      ['0 9 * * 0-2', saturdayMorning, '2026-11-08T09:00:00.000Z'],
      ['0 9 * * SUN', saturdayMorning, '2026-11-08T09:00:00.000Z'],
      ['0 9 * * 7', saturdayMorning, '2026-11-08T09:00:00.000Z'],
    ] as const

    for (const [expression, now, expected] of cases) {
      const definition = defineSchedule(schedule => schedule.call(() => {}).cron(expression))
      const [task] = await listScheduledTasks(definition, { now, timezone: 'UTC' })
      expect([expression, now.toISOString(), task?.nextDueAt.toISOString()]).toEqual([expression, now.toISOString(), expected])
    }
    await expect(listScheduledTasks(
      defineSchedule(schedule => schedule.call(() => {}).cron('0 9 * * SUN-SUN')),
      { now: saturdayMorning, timezone: 'UTC' },
    )).rejects.toThrow(CronExpressionError)
  })

  it('wraps steps larger than the field the way Laravel does', async () => {
    const cases = [
      ['*/61 * * * *', '2026-11-02T00:00:00Z', '2026-11-02T00:01:00.000Z'],
      ['0 0 */40 * *', '2026-11-02T00:00:00Z', '2026-11-10T00:00:00.000Z'],
      ['10-20/30 * * * *', '2026-11-02T00:00:00Z', '2026-11-02T00:10:00.000Z'],
    ] as const

    for (const [expression, now, expected] of cases) {
      const definition = defineSchedule(schedule => schedule.call(() => {}).cron(expression))
      const [task] = await listScheduledTasks(definition, { now: new Date(now), timezone: 'UTC' })
      expect([expression, task?.nextDueAt.toISOString()]).toEqual([expression, expected])
    }
  })

  it('reads names in stepped ranges as Laravel does, which matches only their numeric prefix', async () => {
    const cases = [
      ['0 9 * * MON-FRI/2', '2026-11-01T10:00:00Z', '2026-11-08T09:00:00.000Z'],
      ['0 9 * * SUN-SAT/2', '2026-11-01T10:00:00Z', '2026-11-08T09:00:00.000Z'],
      ['0 9 * * 1-5/2', '2026-11-01T10:00:00Z', '2026-11-02T09:00:00.000Z'],
    ] as const

    for (const [expression, now, expected] of cases) {
      const definition = defineSchedule(schedule => schedule.call(() => {}).cron(expression))
      const [task] = await listScheduledTasks(definition, { now: new Date(now), timezone: 'UTC' })
      expect([expression, task?.nextDueAt.toISOString()]).toEqual([expression, expected])
    }
    await expect(listScheduledTasks(
      defineSchedule(schedule => schedule.call(() => {}).cron('0 9 * JAN-JUN/2 *')),
      { now: MIDNIGHT_UTC, timezone: 'UTC' },
    )).rejects.toThrow(CronExpressionError)
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

  it('applies POSIX double-quote escapes and line continuations', async () => {
    const commands: string[][] = []
    const command = 'billing:charge --label="cost \\$10" "tick \\`" "keep \\x" a\\\nb "c\\\nd"'
    const definition = defineSchedule(schedule => schedule.command(command).daily())

    await runAt(definition, MIDNIGHT_UTC, {
      async runCommand(argv) {
        commands.push([...argv])
        return 0
      },
    })

    expect(commands).toEqual([['billing:charge', '--label=cost $10', 'tick `', 'keep \\x', 'ab', 'cd']])
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

describe('stopping', () => {
  it('starts no task once the stop signal fires, even while a lock is being acquired', async () => {
    const ran: string[] = []
    const definition = defineSchedule((schedule) => {
      schedule.call(() => ran.push('locked')).name('locked').everyMinute().withoutOverlapping()
      schedule.call(() => ran.push('next')).everyMinute()
    })
    const stop = new AbortController()

    const run = runAt(definition, MIDNIGHT_UTC, { signal: stop.signal })
    stop.abort()
    const reports = await run
    const later = await runAt(definition, new Date('2026-11-02T00:01:00Z'))

    expect(ran).toEqual(['locked', 'next'])
    expect(reports).toEqual([])
    expect(later.map(report => report.outcome)).toEqual(['ran', 'ran'])
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
  it('runs every entry sharing a mutex on the server that won it, and none on another server', async () => {
    const ran: string[] = []
    const define = (server: string) => defineSchedule((schedule) => {
      schedule.call(() => ran.push(`${server}:first`)).name('digest').everyMinute().onOneServer()
      schedule.call(() => ran.push(`${server}:second`)).name('digest').everyMinute().onOneServer()
    })

    const winner = await runAt(define('one'), MIDNIGHT_UTC)
    const loser = await runAt(define('two'), MIDNIGHT_UTC)

    expect(ran).toEqual(['one:first', 'one:second'])
    expect(winner.map(report => report.outcome)).toEqual(['ran', 'ran'])
    expect(loser.map(report => report.outcome)).toEqual(['skipped-other-server', 'skipped-other-server'])
  })
  it('leaves the minute to another server when this one skips an overlapping run', async () => {
    const gate = deferred()
    const ran: string[] = []
    const define = (server: string) => defineSchedule(schedule => schedule.call(async () => {
      ran.push(server)
      if (server === 'one') await gate.promise
    }).name('sync').everyMinute().withoutOverlapping().onOneServer())

    const first = runAt(define('one'), MIDNIGHT_UTC)
    await expect.poll(() => ran).toEqual(['one'])
    const skipped = await runAt(define('two'), new Date('2026-11-02T00:01:00Z'))
    gate.resolve()
    await first
    const later = await runAt(define('three'), new Date('2026-11-02T00:01:30Z'))

    expect(skipped.map(report => report.outcome)).toEqual(['skipped-overlapping'])
    expect(later.map(report => report.outcome)).toEqual(['ran'])
    expect(ran).toEqual(['one', 'three'])
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
