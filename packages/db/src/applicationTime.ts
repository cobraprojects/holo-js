type WallClock = {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  millisecond: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()
const CALENDAR_DATE = /^(\d{4,})-(\d{2})-(\d{2})( BC)?$/
const WALL_CLOCK_TIMESTAMP = /^(\d{4,})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?( BC)?$/

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      era: 'short',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    })
    formatters.set(timeZone, formatter)
  }

  return formatter
}

function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = new Map(zoneFormatter(timeZone).formatToParts(instant).map(part => [part.type, part.value]))
  const year = Number(parts.get('year'))
  return {
    year: parts.get('era') === 'BC' ? 1 - year : year,
    month: Number(parts.get('month')),
    day: Number(parts.get('day')),
    hour: Number(parts.get('hour')),
    minute: Number(parts.get('minute')),
    second: Number(parts.get('second')),
    millisecond: instant.getUTCMilliseconds(),
  }
}

function utcMillisOf(wall: WallClock): number {
  const date = new Date(0)
  date.setUTCFullYear(wall.year, wall.month - 1, wall.day)
  date.setUTCHours(wall.hour, wall.minute, wall.second, wall.millisecond)
  return date.getTime()
}

function offsetMillisAt(instant: Date, timeZone: string): number {
  const wholeSecond = Math.floor(instant.getTime() / 1000) * 1000
  return utcMillisOf({ ...wallClockAt(instant, timeZone), millisecond: 0 }) - wholeSecond
}

const DAY_MILLIS = 24 * 60 * 60 * 1000

export type WallClockAmbiguity = 'earlier' | 'later'

function instantOfWallClock(wall: WallClock, timeZone: string, ambiguity: WallClockAmbiguity): Date {
  const local = utcMillisOf(wall)
  const offsets = [...new Set([
    offsetMillisAt(new Date(local - DAY_MILLIS), timeZone),
    offsetMillisAt(new Date(local + DAY_MILLIS), timeZone),
  ])]
  const valid = offsets
    .map(offset => local - offset)
    .filter(instant => offsetMillisAt(new Date(instant), timeZone) === local - instant)
  if (valid.length > 0) {
    return new Date(ambiguity === 'earlier' ? Math.min(...valid) : Math.max(...valid))
  }

  return new Date(local - offsetMillisAt(new Date(local - DAY_MILLIS), timeZone))
}

function pad(value: number, length: number): string {
  return String(value).padStart(length, '0')
}

function astronomicalYear(year: number, era: string | undefined): number {
  return era === 'BC' ? 1 - year : year
}

export function parseCalendarDate(value: string, timeZone: string): Date | undefined {
  const match = CALENDAR_DATE.exec(value)
  if (!match) return undefined

  return instantOfWallClock({
    year: astronomicalYear(Number(match[1]), match[4] ? 'BC' : undefined),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  }, timeZone, 'later')
}

export function parseWallClockTimestamp(value: string, timeZone: string, ambiguity: WallClockAmbiguity): Date | undefined {
  const match = WALL_CLOCK_TIMESTAMP.exec(value)
  if (!match) return undefined

  return instantOfWallClock({
    year: astronomicalYear(Number(match[1]), match[8] ? 'BC' : undefined),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6]),
    millisecond: Number((match[7] ?? '').padEnd(3, '0').slice(0, 3)),
  }, timeZone, ambiguity)
}

export function formatWallClock(instant: Date, timeZone: string): string {
  const wall = wallClockAt(instant, timeZone)
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)} ${pad(wall.hour, 2)}:${pad(wall.minute, 2)}:${pad(wall.second, 2)}.${pad(wall.millisecond, 3)}`
}

export function formatWithOffset(instant: Date, timeZone: string): string {
  const wall = wallClockAt(instant, timeZone)
  const offsetSeconds = Math.round(offsetMillisAt(instant, timeZone) / 1000)
  const sign = offsetSeconds < 0 ? '-' : '+'
  const absolute = Math.abs(offsetSeconds)
  const seconds = absolute % 60 === 0 ? '' : `:${pad(absolute % 60, 2)}`
  const era = wall.year <= 0 ? ' BC' : ''
  const year = wall.year <= 0 ? 1 - wall.year : wall.year
  return `${pad(year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}T${pad(wall.hour, 2)}:${pad(wall.minute, 2)}:${pad(wall.second, 2)}.${pad(wall.millisecond, 3)}${sign}${pad(Math.trunc(absolute / 3600), 2)}:${pad(Math.trunc(absolute % 3600 / 60), 2)}${seconds}${era}`
}
