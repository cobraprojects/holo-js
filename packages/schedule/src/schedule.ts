import { ScheduledTask, type ScheduleCallback, type SchedulableJob } from './task'

const SCHEDULE_DEFINITION = Symbol.for('holo-js.schedule.definition')

export interface ScheduleDefinition {
  readonly [SCHEDULE_DEFINITION]: true
  readonly tasks: readonly ScheduledTask[]
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '')
  }
  return tokens
}

export class Schedule {
  readonly #tasks: ScheduledTask[] = []

  command(command: string): ScheduledTask {
    const argv = tokenizeCommand(command)
    if (argv.length === 0) throw new Error('[@holo-js/schedule] Scheduled commands must name a command.')
    return this.add(new ScheduledTask({ kind: 'command', command: command.trim(), argv }))
  }

  job<TPayload>(job: SchedulableJob<TPayload>, payload: NoInfer<TPayload>): ScheduledTask {
    return this.add(new ScheduledTask({ kind: 'job', job, dispatch: () => job.dispatch(payload) }))
  }

  call(callback: ScheduleCallback): ScheduledTask {
    return this.add(new ScheduledTask({ kind: 'call', callback }))
  }

  get tasks(): readonly ScheduledTask[] {
    return [...this.#tasks]
  }

  private add(task: ScheduledTask): ScheduledTask {
    this.#tasks.push(task)
    return task
  }
}

export function defineSchedule(define: (schedule: Schedule) => void): ScheduleDefinition {
  const schedule = new Schedule()
  define(schedule)
  return Object.freeze({ [SCHEDULE_DEFINITION]: true as const, tasks: Object.freeze(schedule.tasks) })
}

export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return typeof value === 'object' && value !== null && (value as Partial<ScheduleDefinition>)[SCHEDULE_DEFINITION] === true
}
