import { CapabilityError, HydrationError } from '../core/errors'
import { SERVER_WALL_CLOCK_AMBIGUITY, formatCalendarDate, formatWithOffset, parseCalendarDate, parseWallClockTimestamp, startOfDayInTimezone } from '../applicationTime'
import { getApplicationTimezone } from '../applicationTimezone'
import { formatSQLiteDateTime, parseSQLiteDateTime } from '../sqliteDateTime'
import type { AnyColumnDefinition } from './types'
import type { SchemaDialectName } from './typeMapping'

export const DIALECT_VECTOR_SUPPORT: Readonly<Record<SchemaDialectName, boolean>> = Object.freeze({
  sqlite: false,
  postgres: true,
  mysql: false,
})

const DIALECT_DISPLAY_NAME: Readonly<Record<SchemaDialectName, string>> = Object.freeze({
  sqlite: 'SQLite',
  postgres: 'Postgres',
  mysql: 'MySQL',
})

const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/

export function coerceBoolean(value: unknown): boolean | null | undefined {
  if (value == null) {
    return value as null | undefined
  }

  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'number') {
    return value !== 0
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase()
    if (normalized === '1' || normalized === 'true' || normalized === 't') {
      return true
    }

    if (normalized === '0' || normalized === 'false' || normalized === 'f') {
      return false
    }

    if (NUMERIC_TEXT.test(normalized)) {
      return Number(normalized) !== 0
    }
  }

  return Boolean(value)
}

export function booleanStorageValue(value: unknown): number | null | undefined {
  if (value == null) {
    return value as null | undefined
  }

  return coerceBoolean(value) ? 1 : 0
}

export function parseInteger(value: unknown): unknown {
  if (value == null) {
    return value
  }

  const integer = Number(value)
  if (!Number.isSafeInteger(integer)) {
    throw new HydrationError(`Integer value "${String(value)}" cannot be represented as a safe integer.`)
  }

  return integer
}

const CANONICAL_INTEGER_TEXT = /^(?:0|-?[1-9]\d*)$/

export function isCanonicalIntegerText(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_INTEGER_TEXT.test(value)
}

export function readIntegerKey(value: unknown): unknown {
  if (!isCanonicalIntegerText(value)) {
    return value
  }

  const integer = Number(value)
  return Number.isSafeInteger(integer) ? integer : value
}

const SQLITE_DECIMAL_PLACES = 2

const EXPONENT_NUMBER_TEXT = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/

function plainNumberText(value: number): string {
  const text = String(value)
  const match = EXPONENT_NUMBER_TEXT.exec(text)
  if (!match) {
    return text
  }

  const [, sign = '', lead = '', fraction = '', exponent = '0'] = match
  const digits = `${lead}${fraction}`
  const point = 1 + Number(exponent)
  if (point <= 0) {
    return `${sign}0.${'0'.repeat(-point)}${digits}`
  }

  return point >= digits.length ? `${sign}${digits.padEnd(point, '0')}` : `${sign}${digits.slice(0, point)}.${digits.slice(point)}`
}

export function readSQLiteDecimal(value: unknown): unknown {
  const text = typeof value === 'number' && Number.isFinite(value)
    ? plainNumberText(value)
    : typeof value === 'bigint' || isCanonicalIntegerText(value) ? String(value) : undefined
  if (text === undefined) {
    return value
  }

  const [integer = '', fraction = ''] = text.split('.')
  return `${integer}.${fraction.padEnd(SQLITE_DECIMAL_PLACES, '0')}`
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function stringifyJson(value: unknown): unknown {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

export function parseStoredDate(dialect: SchemaDialectName, value: unknown): unknown {
  if (value == null || value instanceof Date) {
    return value
  }

  const text = String(value)
  return parseOffsetFreeDateTime(dialect, text) ?? new Date(text)
}

function parseOffsetFreeDateTime(dialect: SchemaDialectName, text: string): Date | undefined {
  if (dialect === 'sqlite') return parseSQLiteDateTime(text)
  return parseWallClockTimestamp(text, getApplicationTimezone(), SERVER_WALL_CLOCK_AMBIGUITY[dialect])
}

const ISO_INSTANT_TEXT = /^((\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)(Z|[+-](\d{2}):?(\d{2}))$/i

function daysInMonth(year: number, month: number): number {
  const last = new Date(0)
  last.setUTCFullYear(year, month, 0)
  return last.getUTCDate()
}

function isEndOfDay(match: RegExpExecArray): boolean {
  return Number(match[5]) === 24 && Number(match[6]) === 0 && Number(match[7] ?? 0) === 0 && /^0*$/.test(match[8] ?? '')
}

function hasCalendarFields(match: RegExpExecArray): boolean {
  const year = Number(match[2])
  const month = Number(match[3])
  const day = Number(match[4])
  const minute = Number(match[6])
  const second = Number(match[7] ?? 0)
  const zoneHour = Number(match[10] ?? 0)
  const zoneMinute = Number(match[11] ?? 0)
  const clockOk = Number(match[5]) <= 23 || isEndOfDay(match)
  return month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth(year, month)
    && clockOk && minute <= 59 && second <= 59
    && zoneHour <= 23 && zoneMinute <= 59
}

function parseIsoInstantText(value: string): { instant: Date, fraction: string | undefined } | undefined {
  const match = ISO_INSTANT_TEXT.exec(value)
  if (!match) {
    return undefined
  }

  if (Number(match[7] ?? 0) === 60) {
    throw new HydrationError(`Leap second in "${value}" cannot be written as a timestamp.`)
  }

  const zone = match[9]?.toUpperCase()
  if (zone === undefined || !hasCalendarFields(match)) {
    return undefined
  }

  const canonicalZone = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone
  const instant = new Date(`${match[1]}${canonicalZone}`)
  return Number.isNaN(instant.getTime()) ? undefined : { instant, fraction: match[8] }
}

const MILLISECOND_DIGITS = 3

const MYSQL_FRACTIONAL_WALL_CLOCK = /^(\d{4,}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})\.\d+$/

type ParsedInstant = { instant: Date, fraction: string | undefined }

export type DateStorage = 'native' | 'text'

function withPreciseFraction(formatted: string, fraction: string | undefined): string {
  if (fraction === undefined || fraction.length <= MILLISECOND_DIGITS) {
    return formatted
  }

  return formatted.replace(/\.\d{3}(?=[+Z-])/, `.${fraction.padEnd(6, '0').slice(0, 6)}`)
}

function postgresZonedText(parsed: ParsedInstant): string {
  return withPreciseFraction(formatWithOffset(parsed.instant, getApplicationTimezone()), parsed.fraction)
}


function parseInstant(value: unknown): ParsedInstant | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : { instant: value, fraction: undefined }
  }

  return typeof value === 'string' ? parseIsoInstantText(value) : undefined
}

function normalizeSQLiteDateValue(value: unknown): unknown {
  if (value instanceof Date) {
    return formatSQLiteDateTime(value)
  }

  const parsed = typeof value === 'string' ? parseIsoInstantText(value) : undefined
  return parsed ? formatSQLiteDateTime(parsed.instant) : value
}

const OFFSET_FREE_WALL_CLOCK = /^(\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(\.\d{1,6})?)?)?$/

function wallClockInstant(dialect: Exclude<SchemaDialectName, 'sqlite'>, value: string, timeZone: string): Date | undefined {
  const match = OFFSET_FREE_WALL_CLOCK.exec(value)
  if (!match) return undefined
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = ''] = match
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > daysInMonth(Number(year), Number(month))) return undefined
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined
  return match[4] === undefined
    ? parseCalendarDate(`${year}-${month}-${day}`, timeZone)
    : parseWallClockTimestamp(`${year}-${month}-${day} ${hour}:${minute}:${second}${fraction}`, timeZone, SERVER_WALL_CLOCK_AMBIGUITY[dialect])
}

export function calendarMidnightWriteValue(dialect: SchemaDialectName, value: unknown): unknown {
  if (dialect === 'sqlite' && typeof value === 'string' && OFFSET_FREE_WALL_CLOCK.test(value)) return dateLikeWriteValue(dialect, value)
  const timeZone = getApplicationTimezone()
  const instant = value instanceof Date ? value
    : typeof value !== 'string' ? undefined
      : dialect !== 'sqlite' && OFFSET_FREE_WALL_CLOCK.test(value) ? wallClockInstant(dialect, value, timeZone) : parseIsoInstantText(value)?.instant
  if (!instant || Number.isNaN(instant.getTime())) return typeof value === 'string' ? value : dateLikeWriteValue(dialect, value)
  return dateLikeWriteValue(dialect, parseCalendarDate(formatCalendarDate(instant, timeZone), timeZone) ?? startOfDayInTimezone(instant, timeZone))
}

export function wholeSecondInstant(instant: Date): Date {
  const time = instant.getTime()
  const millisecond = ((time % 1000) + 1000) % 1000
  return millisecond === 0 ? instant : new Date(time - millisecond)
}

export function dateLikeWriteValue(dialect: SchemaDialectName, value: unknown, storage: DateStorage = 'native'): unknown {
  if (dialect === 'sqlite') {
    return normalizeSQLiteDateValue(value)
  }

  const parsed = parseInstant(value)
  if (!parsed) {
    return dialect === 'mysql' && typeof value === 'string' ? value.replace(MYSQL_FRACTIONAL_WALL_CLOCK, '$1') : value
  }

  if (dialect === 'mysql') {
    return wholeSecondInstant(parsed.instant)
  }

  if (storage === 'text') {
    return parsed.instant.toISOString()
  }

  return value instanceof Date ? value : postgresZonedText(parsed)
}

function parseVectorString(value: string): number[] {
  const trimmed = value.trim()
  if (!trimmed) {
    throw new HydrationError('Vector values require a non-empty payload.')
  }

  try {
    const parsed = JSON.parse(trimmed)
    if (!Array.isArray(parsed)) {
      throw new HydrationError('Vector values require a JSON array or PostgreSQL-style vector literal.')
    }

    return parsed.map(entry => Number(entry))
  } catch (error) {
    if (error instanceof HydrationError) {
      throw error
    }

    throw new HydrationError('Vector values require a JSON array or PostgreSQL-style vector literal.')
  }
}

function parseVectorValue(value: unknown): readonly number[] | null | undefined {
  if (value == null) {
    return value as null | undefined
  }

  const numbers = Array.isArray(value)
    ? value.map(entry => Number(entry))
    : typeof value === 'string'
      ? parseVectorString(value)
      : null

  if (!numbers) {
    throw new HydrationError('Vector values require an array or string payload.')
  }

  if (numbers.some(entry => Number.isNaN(entry))) {
    throw new HydrationError('Vector values require numeric array values.')
  }

  return [...numbers]
}

function stringifyVectorValue(value: unknown): unknown {
  const parsed = parseVectorValue(value)
  if (parsed == null) {
    return parsed
  }

  return `[${parsed.join(',')}]`
}

export function storesJson(dialect: SchemaDialectName | undefined, column: AnyColumnDefinition): boolean {
  return column.kind === 'json' || (dialect === 'sqlite' && column.kind === 'text')
}

export function storesText(column: AnyColumnDefinition): boolean {
  return column.kind === 'string' || column.kind === 'text'
}

export function storesDate(column: AnyColumnDefinition): boolean {
  return column.kind === 'date' || column.kind === 'datetime' || column.kind === 'timestamp'
}

export function readsAsInteger(column: AnyColumnDefinition): boolean {
  return column.kind === 'integer' || column.kind === 'bigInteger' || (column.kind === 'id' && column.idStrategy === 'autoIncrement')
}

const DECIMAL_NUMBER_TEXT = /^-?\d+(?:\.\d+)?$/

export function readNumericValue(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isNaN(value) ? undefined : value
  if (typeof value !== 'string' || !DECIMAL_NUMBER_TEXT.test(value)) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

export function readsAsSQLiteDecimal(dialect: SchemaDialectName, column: AnyColumnDefinition): boolean {
  return dialect === 'sqlite' && column.kind === 'decimal'
}

export function normalizeDialectReadValue(
  dialect: SchemaDialectName,
  column: AnyColumnDefinition,
  value: unknown,
): unknown {
  switch (column.kind) {
    case 'id':
      return column.idStrategy === 'autoIncrement' ? parseInteger(value) : value
    case 'integer':
    case 'bigInteger':
      return parseInteger(value)
    case 'boolean':
      return coerceBoolean(value)
    case 'decimal':
      return dialect === 'sqlite' ? readSQLiteDecimal(value) : value
    case 'json':
      return parseJson(value)
    case 'date':
    case 'datetime':
    case 'timestamp':
      return parseStoredDate(dialect, value)
    case 'vector':
      if (!DIALECT_VECTOR_SUPPORT[dialect]) {
        throw new CapabilityError(`${DIALECT_DISPLAY_NAME[dialect]} does not support logical vector columns.`)
      }
      return parseVectorValue(value)
    default:
      return value
  }
}

export function normalizeDialectWriteValue(
  dialect: SchemaDialectName,
  column: AnyColumnDefinition,
  value: unknown,
): unknown {
  switch (column.kind) {
    case 'integer':
    case 'bigInteger':
      return typeof value === 'boolean' ? Number(value) : value
    case 'boolean':
      return dialect === 'postgres' ? coerceBoolean(value) : booleanStorageValue(value)
    case 'json':
      return value == null ? value : stringifyJson(value)
    case 'date':
    case 'datetime':
    case 'timestamp':
      return dateLikeWriteValue(dialect, value)
    case 'string':
    case 'text':
      return value instanceof Date ? dateLikeWriteValue(dialect, value, 'text') : value
    case 'vector':
      if (!DIALECT_VECTOR_SUPPORT[dialect]) {
        throw new CapabilityError(`${DIALECT_DISPLAY_NAME[dialect]} does not support logical vector columns.`)
      }
      return stringifyVectorValue(value)
  }

  return value
}
