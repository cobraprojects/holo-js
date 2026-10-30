import { ScheduledTask, type ScheduleCallback, type SchedulableJob } from './task'

const SCHEDULE_DEFINITION = Symbol.for('holo-js.schedule.definition')

export interface ScheduleDefinition {
  readonly [SCHEDULE_DEFINITION]: true
  readonly tasks: readonly ScheduledTask[]
}

function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let token: string | undefined
  let quote: '"' | "'" | undefined
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!
    if (quote === "'") {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (character === '\\' && index + 1 < command.length && (quote === undefined || '"\\'.includes(command[index + 1]!))) {
      index += 1
      token = (token ?? '') + command[index]
      continue
    }
    if (quote === '"') {
      if (character === quote) quote = undefined
      else token += character
      continue
    }
    if (/\s/.test(character)) {
      if (token !== undefined) tokens.push(token)
      token = undefined
      continue
    }
    token ??= ''
    if (character === '"' || character === "'") quote = character
    else token += character
  }
  if (quote) throw new Error(`[@holo-js/schedule] Scheduled command has an unterminated ${quote} quote: ${command}`)
  if (token !== undefined) tokens.push(token)
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

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof value === 'object' && value !== null && typeof (value as { then?: unknown }).then === 'function'
}

export function defineSchedule(define: (schedule: Schedule) => void): ScheduleDefinition {
  let tasks: readonly ScheduledTask[] | undefined
  return Object.freeze({
    [SCHEDULE_DEFINITION]: true as const,
    get tasks(): readonly ScheduledTask[] {
      if (!tasks) {
        const schedule = new Schedule()
        const result: unknown = define(schedule)
        if (isPromiseLike(result)) {
          Promise.resolve(result).catch(() => undefined)
          throw new Error('[@holo-js/schedule] defineSchedule() callbacks must define tasks synchronously.')
        }
        tasks = Object.freeze(schedule.tasks)
      }
      return tasks
    },
  })
}

export function isScheduleDefinition(value: unknown): value is ScheduleDefinition {
  return typeof value === 'object' && value !== null && (value as Partial<ScheduleDefinition>)[SCHEDULE_DEFINITION] === true
}
