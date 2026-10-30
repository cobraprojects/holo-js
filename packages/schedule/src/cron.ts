const MINUTE_MS = 60_000
const MAX_SEARCH_DAYS = 366 * 9

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

type DayRule = (clock: WallClock) => boolean

type CronField = {
  readonly values: ReadonlySet<number>
  readonly rules: readonly DayRule[]
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

  if (stepToken !== undefined && range !== '*' && !range.includes('-')) {
    throw new CronExpressionError(expression, `"${part}" steps over a single value; use a range such as "${range}-${spec.max}/${stepToken}".`)
  }

  let start = spec.min
  let end = spec.max
  if (range !== '*') {
    const [startToken = '', endToken, ...rest] = range.split('-')
    if (rest.length > 0) throw new CronExpressionError(expression, `"${part}" is not a valid ${spec.label}.`)
    start = parseValue(startToken, spec, expression)
    end = endToken === undefined ? (stepToken === undefined ? start : spec.max) : parseValue(endToken, spec, expression)
    if (spec.label === 'day of week' && endToken !== undefined) {
      if (start === 7) start = 0
      else if (end === 0) end = 7
    }
    if (end < start) throw new CronExpressionError(expression, `"${part}" is a descending range.`)
  }

  if (step > spec.max) return [spec.min + (step % (spec.max - spec.min + 1))]

  const values: number[] = []
  for (let value = start; value <= end; value += step) values.push(value)
  return values
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function isWeekday(year: number, month: number, day: number): boolean {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

function nearestWeekday(target: number): DayRule {
  return (clock) => {
    const lastDay = daysInMonth(clock.year, clock.month)
    if (target > lastDay) return false
    const nearest = [0, -1, 1, -2, 2]
      .map(offset => target + offset)
      .find(day => day >= 1 && day <= lastDay && isWeekday(clock.year, clock.month, day))
    return nearest === clock.day
  }
}

function parseDayOfMonthRule(part: string, source: string, spec: FieldSpec, expression: string): DayRule | undefined {
  const special = part === 'L' || part.endsWith('W')
  if (!special) return undefined
  if (source.includes(',')) throw new CronExpressionError(expression, `"${part}" can't be combined with other days of the month.`)
  if (part === 'L') return clock => clock.day === daysInMonth(clock.year, clock.month)
  return nearestWeekday(parseValue(part.slice(0, -1), spec, expression))
}

function parseDayOfWeekRule(part: string, spec: FieldSpec, expression: string): DayRule | undefined {
  const last = /^(\w+)L$/i.exec(part)
  if (last) {
    const weekday = parseValue(last[1]!, spec, expression) % 7
    return clock => clock.weekday === weekday && daysInMonth(clock.year, clock.month) - clock.day < 7
  }
  const nth = /^(\w+)#(\d+)$/.exec(part)
  if (!nth) return undefined
  const weekday = parseValue(nth[1]!, spec, expression) % 7
  const occurrence = Number(nth[2])
  if (occurrence < 1 || occurrence > 5) throw new CronExpressionError(expression, `"${part}" must name the 1st to 5th weekday of the month.`)
  return clock => clock.weekday === weekday && Math.ceil(clock.day / 7) === occurrence
}

function parseRule(part: string, source: string, spec: FieldSpec, expression: string): DayRule | undefined {
  if (spec.label === 'day of month') return parseDayOfMonthRule(part, source, spec, expression)
  if (spec.label === 'day of week') return parseDayOfWeekRule(part, spec, expression)
  return undefined
}

function parseField(source: string, spec: FieldSpec, expression: string): CronField {
  if (source === '?') return { values: new Set(parsePart('*', spec, expression)), rules: [], restricted: false }
  const values = new Set<number>()
  const rules: DayRule[] = []
  for (const part of source.split(',')) {
    const rule = parseRule(part, source, spec, expression)
    if (rule) {
      rules.push(rule)
      continue
    }
    for (const value of parsePart(part, spec, expression)) {
      values.add(spec.label === 'day of week' && value === 7 ? 0 : value)
    }
  }
  return { values, rules, restricted: source !== '*' }
}

export function normalizeCronExpression(expression: string): string {
  return MACROS[expression.trim().toLowerCase()] ?? expression.trim()
}

export function parseCronExpression(expression: string): CronSchedule {
  const fields = normalizeCronExpression(expression).split(/\s+/)
  if (fields.length !== 5) throw new CronExpressionError(expression, 'expected 5 fields.')
  if ([fields[0], fields[1], fields[3]].includes('?') || (fields[2] === '?' && fields[4] === '?')) {
    throw new CronExpressionError(expression, '"?" is only allowed in one of the day-of-month and day-of-week fields.')
  }

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
  const dayOfMonth = schedule.dayOfMonth.values.has(clock.day) || schedule.dayOfMonth.rules.some(rule => rule(clock))
  const dayOfWeek = schedule.dayOfWeek.values.has(clock.weekday) || schedule.dayOfWeek.rules.some(rule => rule(clock))
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

function offsetAt(time: number, timezone: string): number {
  const clock = wallClock(new Date(time), timezone)
  return Date.UTC(clock.year, clock.month - 1, clock.day, clock.hour, clock.minute) - Math.floor(time / MINUTE_MS) * MINUTE_MS
}

function nextLocalMidnight(time: number, clock: WallClock, timezone: string): number {
  const midnight = Date.UTC(clock.year, clock.month - 1, clock.day + 1)
  const estimate = midnight - offsetAt(midnight, timezone)
  const candidate = Math.min(estimate, midnight - offsetAt(estimate, timezone))
  return Math.max(time + MINUTE_MS, candidate)
}

export function nextCronDate(schedule: CronSchedule, after: Date, timezone: string, expression: string): Date {
  let time = Math.floor(after.getTime() / MINUTE_MS) * MINUTE_MS + MINUTE_MS
  const limit = time + MAX_SEARCH_DAYS * 24 * 60 * MINUTE_MS
  while (time <= limit) {
    const clock = wallClock(new Date(time), timezone)
    if (!dayMatches(schedule, clock)) {
      time = nextLocalMidnight(time, clock, timezone)
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
