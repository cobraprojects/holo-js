import { CapabilityError, HydrationError } from '../core/errors'
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

function stringifyDateLike(value: unknown): unknown {
  return value instanceof Date ? value.toISOString() : value
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
      return stringifyDateLike(value)
    case 'vector':
      if (!DIALECT_VECTOR_SUPPORT[dialect]) {
        throw new CapabilityError(`${DIALECT_DISPLAY_NAME[dialect]} does not support logical vector columns.`)
      }
      return stringifyVectorValue(value)
  }

  return value
}
