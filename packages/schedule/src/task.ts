import { assertTimezone, parseCronExpression } from './cron'

export type ScheduleCallback = () => unknown

export interface SchedulableJob<TPayload> {
  dispatch(payload: TPayload): PromiseLike<unknown>
}

export type ScheduledTaskAction
  = { readonly kind: 'command', readonly command: string, readonly argv: readonly string[] }
  | { readonly kind: 'job', readonly job: SchedulableJob<never>, readonly dispatch: () => PromiseLike<unknown> }
  | { readonly kind: 'call', readonly callback: ScheduleCallback }

export type ScheduledTaskState = {
  readonly action: ScheduledTaskAction
  readonly expression: string
  readonly timezone?: string
  readonly description?: string
  readonly withoutOverlapping: boolean
  readonly expiresAtMinutes: number
  readonly onOneServer: boolean
}

export const SCHEDULED_TASK_STATE = Symbol.for('holo-js.schedule.task-state')

const MONDAY = 1
const FRIDAY = 5
const SATURDAY = 6
const SUNDAY = 0

type CronValue = number | string
type CronValues = number | readonly number[]

function joinValues(values: CronValues): string {
  return typeof values === 'number' ? String(values) : values.join(',')
}

function parseTime(time: string): { readonly hour: number, readonly minute: number } {
  const match = /^(\d{1,2})(?::(\d{1,2}))?$/.exec(time.trim())
  const hour = Number(match?.[1])
  const minute = Number(match?.[2] ?? 0)
  if (!match || hour > 23 || minute > 59) {
    throw new RangeError(`[@holo-js/schedule] Invalid time "${time}". Expected HH:MM.`)
  }
  return { hour, minute }
}

export class ScheduledTask {
  #state: ScheduledTaskState

  constructor(action: ScheduledTaskAction) {
    this.#state = {
      action,
      expression: '* * * * *',
      withoutOverlapping: false,
      expiresAtMinutes: 1440,
      onOneServer: false,
    }
  }

  get [SCHEDULED_TASK_STATE](): ScheduledTaskState {
    return this.#state
  }

  cron(expression: string): this {
    parseCronExpression(expression)
    this.#state = { ...this.#state, expression }
    return this
  }

  timezone(timezone: string): this {
    this.#state = { ...this.#state, timezone: assertTimezone(timezone) }
    return this
  }

  name(description: string): this {
    if (!description.trim()) throw new Error('[@holo-js/schedule] Scheduled task names must not be empty.')
    this.#state = { ...this.#state, description }
    return this
  }

  withoutOverlapping(expiresAtMinutes = 1440): this {
    if (!Number.isInteger(expiresAtMinutes) || expiresAtMinutes < 1) {
      throw new RangeError('[@holo-js/schedule] withoutOverlapping() expects a positive whole number of minutes.')
    }
    this.#state = { ...this.#state, withoutOverlapping: true, expiresAtMinutes }
    return this
  }

  onOneServer(): this {
    this.#state = { ...this.#state, onOneServer: true }
    return this
  }

  everyMinute(): this {
    return this.spliceIntoPosition(1, '*')
  }

  everyTwoMinutes(): this {
    return this.spliceIntoPosition(1, '*/2')
  }

  everyThreeMinutes(): this {
    return this.spliceIntoPosition(1, '*/3')
  }

  everyFourMinutes(): this {
    return this.spliceIntoPosition(1, '*/4')
  }

  everyFiveMinutes(): this {
    return this.spliceIntoPosition(1, '*/5')
  }

  everyTenMinutes(): this {
    return this.spliceIntoPosition(1, '*/10')
  }

  everyFifteenMinutes(): this {
    return this.spliceIntoPosition(1, '*/15')
  }

  everyThirtyMinutes(): this {
    return this.spliceIntoPosition(1, '*/30')
  }

  hourly(): this {
    return this.spliceIntoPosition(1, 0)
  }

  hourlyAt(offset: CronValues): this {
    return this.hourBasedSchedule(joinValues(offset), '*')
  }

  everyOddHour(offset: CronValues = 0): this {
    return this.hourBasedSchedule(joinValues(offset), '1-23/2')
  }

  everyTwoHours(offset: CronValues = 0): this {
    return this.hourBasedSchedule(joinValues(offset), '*/2')
  }

  everyThreeHours(offset: CronValues = 0): this {
    return this.hourBasedSchedule(joinValues(offset), '*/3')
  }

  everyFourHours(offset: CronValues = 0): this {
    return this.hourBasedSchedule(joinValues(offset), '*/4')
  }

  everySixHours(offset: CronValues = 0): this {
    return this.hourBasedSchedule(joinValues(offset), '*/6')
  }

  daily(): this {
    return this.hourBasedSchedule(0, 0)
  }

  at(time: string): this {
    return this.dailyAt(time)
  }

  dailyAt(time: string): this {
    const { hour, minute } = parseTime(time)
    return this.hourBasedSchedule(minute, hour)
  }

  twiceDaily(first = 1, second = 13): this {
    return this.twiceDailyAt(first, second, 0)
  }

  twiceDailyAt(first = 1, second = 13, offset = 0): this {
    return this.hourBasedSchedule(offset, `${first},${second}`)
  }

  weekdays(): this {
    return this.days(`${MONDAY}-${FRIDAY}`)
  }

  weekends(): this {
    return this.days(`${SATURDAY},${SUNDAY}`)
  }

  mondays(): this {
    return this.days(1)
  }

  tuesdays(): this {
    return this.days(2)
  }

  wednesdays(): this {
    return this.days(3)
  }

  thursdays(): this {
    return this.days(4)
  }

  fridays(): this {
    return this.days(5)
  }

  saturdays(): this {
    return this.days(6)
  }

  sundays(): this {
    return this.days(0)
  }

  days(...days: ReadonlyArray<CronValue | readonly number[]>): this {
    return this.spliceIntoPosition(5, days.flat().join(','))
  }

  weekly(): this {
    return this.spliceIntoPosition(1, 0).spliceIntoPosition(2, 0).spliceIntoPosition(5, 0)
  }

  weeklyOn(dayOfWeek: CronValues, time = '0:0'): this {
    return this.dailyAt(time).days(joinValues(dayOfWeek))
  }

  monthly(): this {
    return this.spliceIntoPosition(1, 0).spliceIntoPosition(2, 0).spliceIntoPosition(3, 1)
  }

  monthlyOn(dayOfMonth = 1, time = '0:0'): this {
    return this.dailyAt(time).spliceIntoPosition(3, dayOfMonth)
  }

  twiceMonthly(first = 1, second = 16, time = '0:0'): this {
    return this.dailyAt(time).spliceIntoPosition(3, `${first},${second}`)
  }

  quarterly(): this {
    return this.monthly().spliceIntoPosition(4, '1-12/3')
  }

  quarterlyOn(dayOfQuarter = 1, time = '0:0'): this {
    return this.dailyAt(time).spliceIntoPosition(3, dayOfQuarter).spliceIntoPosition(4, '1-12/3')
  }

  yearly(): this {
    return this.monthly().spliceIntoPosition(4, 1)
  }

  yearlyOn(month = 1, dayOfMonth = 1, time = '0:0'): this {
    return this.dailyAt(time).spliceIntoPosition(3, dayOfMonth).spliceIntoPosition(4, month)
  }

  private hourBasedSchedule(minutes: CronValue, hours: CronValue): this {
    return this.spliceIntoPosition(1, minutes).spliceIntoPosition(2, hours)
  }

  private spliceIntoPosition(position: number, value: CronValue): this {
    const segments = this.#state.expression.split(/\s+/)
    segments[position - 1] = String(value)
    return this.cron(segments.join(' '))
  }
}
