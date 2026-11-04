const SQLITE_DATE_TIME = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/
const WHOLE_SECOND_SUFFIX = '.000'

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
