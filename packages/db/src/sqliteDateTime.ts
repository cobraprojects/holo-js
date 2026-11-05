import { formatWallClockSeconds } from './applicationTime'

const SQLITE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
const WHOLE_SECOND_SUFFIX = '.000'
const UNIX_EPOCH_JULIAN_DAY = 2440587.5
const DAY_MILLISECONDS = 86_400_000

export const SQLITE_WALL_CLOCK_FUNCTION = 'holo_wall_clock'

export function formatSQLiteDateTime(instant: Date): string {
  const text = instant.toISOString().replace('T', ' ').slice(0, -1)
  return text.endsWith(WHOLE_SECOND_SUFFIX) ? text.slice(0, -WHOLE_SECOND_SUFFIX.length) : text
}

export function parseSQLiteDateTime(value: string): Date | undefined {
  if (!SQLITE_DATE_TIME.test(value)) {
    return undefined
  }

  const instant = new Date(`${value.replace(' ', 'T')}Z`)
  return Number.isNaN(instant.getTime()) ? undefined : instant
}

export function compileSQLiteWallClock(column: string, timeZoneLiteral: string): string {
  return `${SQLITE_WALL_CLOCK_FUNCTION}((julianday(${column}) - ${UNIX_EPOCH_JULIAN_DAY}) * ${DAY_MILLISECONDS}.0, ${timeZoneLiteral})`
}

export function formatSQLiteWallClock(epochMilliseconds: unknown, timeZone: unknown): string | null {
  if (typeof epochMilliseconds !== 'number' || !Number.isFinite(epochMilliseconds) || typeof timeZone !== 'string') {
    return null
  }

  const instant = new Date(Math.round(epochMilliseconds))
  return Number.isNaN(instant.getTime()) ? null : formatWallClockSeconds(instant, timeZone)
}
