import { pluralize } from 'inflection'

export function pluralizeTableName(word: string): string {
  return pluralize(word)
}

export function inferConstrainedTableName(columnName: string): string {
  if (columnName.endsWith('_id')) {
    return pluralizeTableName(columnName.slice(0, -3))
  }

  if (columnName.endsWith('Id')) {
    return pluralizeTableName(columnName.slice(0, -2))
  }

  return pluralizeTableName(columnName)
}
