import { CapabilityError, HydrationError } from '../core/errors'
import { formatWithOffset } from '../applicationTime'
import { getApplicationTimezone } from '../applicationTimezone'
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

function coerceBoolean(value: unknown): boolean | null | undefined {
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
  }

  return Boolean(value)
}

function parseInteger(value: unknown): unknown {
  if (value == null) {
    return value
  }

  const integer = Number(value)
  if (!Number.isSafeInteger(integer)) {
    throw new HydrationError(`Integer value "${String(value)}" cannot be represented as a safe integer.`)
  }

  return integer
}

function parseJson(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value
}

function stringifyJson(value: unknown): unknown {
  return typeof value === 'string' ? value : JSON.stringify(value)
}

function parseDateLike(value: unknown): unknown {
  if (value == null || value instanceof Date) {
    return value
  }

  return new Date(String(value))
}

const ISO_INSTANT_TEXT = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.(\d+))?)?)(Z|[+-]\d{2}:?\d{2})$/i

function parseIsoInstantText(value: string): { instant: Date, fraction: string | undefined } | undefined {
  const match = ISO_INSTANT_TEXT.exec(value)
  if (!match) {
    return undefined
  }

  const zone = match[3]!.toUpperCase()
  const canonicalZone = zone.length === 5 ? `${zone.slice(0, 3)}:${zone.slice(3)}` : zone
  const instant = new Date(`${match[1]}${canonicalZone}`)
  return Number.isNaN(instant.getTime()) ? undefined : { instant, fraction: match[2] }
}

function postgresZonedText(parsed: { instant: Date, fraction: string | undefined }): string {
  const formatted = formatWithOffset(parsed.instant, getApplicationTimezone())
  if (parsed.fraction === undefined) {
    return formatted
  }

  return formatted.replace(/\.\d{3}(?=[+-])/, `.${parsed.fraction.padEnd(6, '0').slice(0, 6)}`)
}

function dateLikeWriteValue(dialect: SchemaDialectName, value: unknown): unknown {
  if (dialect === 'sqlite') {
    return value instanceof Date ? value.toISOString() : value
  }

  if (value instanceof Date) {
    return value
  }

  if (typeof value !== 'string') {
    return value
  }

  const parsed = parseIsoInstantText(value)
  if (!parsed) {
    return value
  }

  return dialect === 'postgres' ? postgresZonedText(parsed) : parsed.instant
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
    case 'json':
      return parseJson(value)
    case 'date':
    case 'datetime':
    case 'timestamp':
      return parseDateLike(value)
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
    case 'boolean':
      if (value == null) {
        return value
      }
      {
        const normalized = coerceBoolean(value)
        if (dialect === 'postgres') {
          return normalized
        }

        return normalized ? 1 : 0
      }
    case 'json':
      return value == null ? value : stringifyJson(value)
    case 'date':
    case 'datetime':
    case 'timestamp':
      return dateLikeWriteValue(dialect, value)
    case 'vector':
      if (!DIALECT_VECTOR_SUPPORT[dialect]) {
        throw new CapabilityError(`${DIALECT_DISPLAY_NAME[dialect]} does not support logical vector columns.`)
      }
      return stringifyVectorValue(value)
  }

  return value
}
