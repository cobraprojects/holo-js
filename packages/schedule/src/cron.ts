const MINUTE_MS = 60_000
const MAX_SEARCH_DAYS = 366 * 5

const MACROS: Readonly<Record<string, string>> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
}

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']

type FieldSpec = {
  readonly label: string
  readonly min: number
  readonly max: number
  readonly names?: readonly string[]
  readonly nameOffset?: number
}

const FIELD_SPECS: readonly FieldSpec[] = [
  { label: 'minute', min: 0, max: 59 },
  { label: 'hour', min: 0, max: 23 },
  { label: 'day of month', min: 1, max: 31 },
  { label: 'month', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  { label: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES, nameOffset: 0 },
]

type CronField = {
  readonly values: ReadonlySet<number>
  readonly restricted: boolean
}

export type CronSchedule = {
  readonly minute: CronField
  readonly hour: CronField
  readonly dayOfMonth: CronField
  readonly month: CronField
  readonly dayOfWeek: CronField
}

type WallClock = {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly weekday: number
}

export class CronExpressionError extends Error {
  constructor(expression: string, reason: string) {
    super(`[@holo-js/schedule] Invalid cron expression "${expression}": ${reason}`)
    this.name = 'CronExpressionError'
  }
}

function parseValue(token: string, spec: FieldSpec, expression: string): number {
  const nameIndex = spec.names?.indexOf(token.toUpperCase()) ?? -1
  if (nameIndex >= 0) return nameIndex + (spec.nameOffset ?? 0)
  if (!/^\d+$/.test(token)) throw new CronExpressionError(expression, `"${token}" is not a valid ${spec.label}.`)
  const value = Number(token)
  if (value < spec.min || value > spec.max) {
    throw new CronExpressionError(expression, `${spec.label} ${value} is outside ${spec.min}-${spec.max}.`)
  }
  return value
}

function parsePart(part: string, spec: FieldSpec, expression: string): number[] {
  const [range = '', stepToken, ...extra] = part.split('/')
  if (extra.length > 0 || range === '') throw new CronExpressionError(expression, `"${part}" is not a valid ${spec.label}.`)
  const step = stepToken === undefined ? 1 : Number(stepToken)
  if (!Number.isInteger(step) || step < 1 || (stepToken !== undefined && !/^\d+$/.test(stepToken))) {
    throw new CronExpressionError(expression, `"${part}" has an invalid step.`)
  }

  let start = spec.min
  let end = spec.max
  if (range !== '*' && range !== '?') {
    const [startToken = '', endToken, ...rest] = range.split('-')
    if (rest.length > 0) throw new CronExpressionError(expression, `"${part}" is not a valid ${spec.label}.`)
    start = parseValue(startToken, spec, expression)
    end = endToken === undefined ? (stepToken === undefined ? start : spec.max) : parseValue(endToken, spec, expression)
    if (end < start) throw new CronExpressionError(expression, `"${part}" is a descending range.`)
  }

  const values: number[] = []
  for (let value = start; value <= end; value += step) values.push(value)
  return values
}

function parseField(source: string, spec: FieldSpec, expression: string): CronField {
  const values = new Set<number>()
  for (const part of source.split(',')) {
    for (const value of parsePart(part, spec, expression)) {
      values.add(spec.label === 'day of week' && value === 7 ? 0 : value)
    }
  }
  return { values, restricted: source !== '*' && source !== '?' }
}

export function parseCronExpression(expression: string): CronSchedule {
  const normalized = MACROS[expression.trim().toLowerCase()] ?? expression.trim()
  const fields = normalized.split(/\s+/)
  if (fields.length !== 5) throw new CronExpressionError(expression, 'expected 5 fields.')

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields.map((field, index) => parseField(field, FIELD_SPECS[index]!, expression))
  return { minute: minute!, hour: hour!, dayOfMonth: dayOfMonth!, month: month!, dayOfWeek: dayOfWeek! }
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function wallClock(date: Date, timezone: string): WallClock {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      weekday: 'short',
    })
    formatters.set(timezone, formatter)
  }

  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_NAMES.indexOf(String(parts.weekday).toUpperCase()),
  }
}

function dayMatches(schedule: CronSchedule, clock: WallClock): boolean {
  if (!schedule.month.values.has(clock.month)) return false
  const dayOfMonth = schedule.dayOfMonth.values.has(clock.day)
  const dayOfWeek = schedule.dayOfWeek.values.has(clock.weekday)
  if (schedule.dayOfMonth.restricted && schedule.dayOfWeek.restricted) return dayOfMonth || dayOfWeek
  return dayOfMonth && dayOfWeek
}

export function assertTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone
  } catch {
    throw new RangeError(`[@holo-js/schedule] Invalid timezone: ${timezone}`)
  }
}

export function formatHourMinute(date: Date, timezone: string): string {
  const clock = wallClock(date, timezone)
  return `${String(clock.hour).padStart(2, '0')}${String(clock.minute).padStart(2, '0')}`
}

export function cronMatches(schedule: CronSchedule, date: Date, timezone: string): boolean {
  const clock = wallClock(date, timezone)
  return dayMatches(schedule, clock)
    && schedule.hour.values.has(clock.hour)
    && schedule.minute.values.has(clock.minute)
}

export function nextCronDate(schedule: CronSchedule, after: Date, timezone: string, expression: string): Date {
  let time = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const limit = time + MAX_SEARCH_DAYS * 24 * 60 * MINUTE_MS
  while (time <= limit) {
    const clock = wallClock(new Date(time), timezone)
    if (!dayMatches(schedule, clock)) {
      time += Math.max(1, 24 * 60 - (clock.hour * 60 + clock.minute) - 60) * MINUTE_MS
      continue
    }
    if (!schedule.hour.values.has(clock.hour)) {
      time += (60 - clock.minute) * MINUTE_MS
      continue
    }
    if (schedule.minute.values.has(clock.minute)) return new Date(time)
    time += MINUTE_MS
  }

  throw new CronExpressionError(expression, 'it never matches a date.')
}
