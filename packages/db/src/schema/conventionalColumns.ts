import { column } from './columns'

export const TIMESTAMP_COLUMN_NAMES = ['created_at', 'updated_at'] as const

export const SOFT_DELETE_COLUMN_NAME = 'deleted_at'

export function timestampColumn() {
  return column.timestamp().defaultNow()
}

export function softDeleteColumn() {
  return column.timestamp().nullable()
}
