export interface RawSqlPlaceholder {
  start: number
  end: number
  style: '?' | '$'
  index?: number
}

export function rawSqlPlaceholders(sql: string): RawSqlPlaceholder[] {
  const placeholders: RawSqlPlaceholder[] = []
  for (let offset = 0; offset < sql.length; offset += 1) {
    const char = sql[offset]
    if (char === "'" || char === '"' || char === '`' || char === '[') {
      const closing = char === '[' ? ']' : char
      for (offset += 1; offset < sql.length; offset += 1) {
        if (sql[offset] === '\\') {
          offset += 1
        } else if (sql[offset] === closing) {
          if (sql[offset + 1] !== closing) break
          offset += 1
        }
      }
      continue
    }
    if (sql.startsWith('--', offset)) {
      const end = sql.indexOf('\n', offset + 2)
      offset = end < 0 ? sql.length : end
      continue
    }
    if (sql.startsWith('/*', offset)) {
      let depth = 1
      for (offset += 2; offset < sql.length && depth > 0; offset += 1) {
        if (sql.startsWith('/*', offset)) { depth += 1; offset += 1 }
        else if (sql.startsWith('*/', offset)) { depth -= 1; offset += 1 }
      }
      offset -= 1
      continue
    }
    if (char === '$') {
      const delimiter = /^\$(?:[A-Z_]\w*)?\$/i.exec(sql.slice(offset))?.[0]
      if (delimiter) {
        const end = sql.indexOf(delimiter, offset + delimiter.length)
        offset = end < 0 ? sql.length : end + delimiter.length - 1
        continue
      }
    }
    if (char !== '?' && char !== '$') continue
    const digits = /^\d+/.exec(sql.slice(offset + 1))?.[0]
    if (char === '$' && !digits) continue
    const end = offset + 1 + (digits?.length ?? 0)
    placeholders.push({ start: offset, end, style: char, index: digits ? Number(digits) : undefined })
    offset = end - 1
  }
  return placeholders
}
