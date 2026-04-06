export function pluralizeTableName(word: string): string {
  if (word.endsWith('y') && !/[aeiou]y$/i.test(word)) {
    return `${word.slice(0, -1)}ies`
  }

  if (/(?:[sxz]|ch|sh)$/i.test(word)) {
    return `${word}es`
  }

  return `${word}s`
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
