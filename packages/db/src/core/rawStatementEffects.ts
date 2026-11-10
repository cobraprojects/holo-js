const SCHEMA_PRESERVING_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'SAVEPOINT', 'RELEASE', 'LOCK'])
const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])
const RAW_WRITE_IDENTIFIER = '(?:[A-Za-z_]\\w*|"[A-Za-z_]\\w*"|`[A-Za-z_]\\w*`|\\[[A-Za-z_]\\w*\\])'
const RAW_WRITE_TARGET = new RegExp(`^(${RAW_WRITE_IDENTIFIER}(?:\\s*\\.\\s*${RAW_WRITE_IDENTIFIER})?)(?=\\s|\\(|;|$)`)
const SCHEMA_DEFINITIONS = /\b(?:create|alter|drop|truncate|rename|into)\b/i

function stripLeadingTrivia(sql: string, conservative = false): string {
  let rest = sql
  for (;;) {
    const trimmed = rest.replace(/^[\s(]+/, '')
    if (trimmed.startsWith('--')) {
      const end = trimmed.indexOf('\n')
      rest = end < 0 ? '' : trimmed.slice(end + 1)
      continue
    }
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/')
      if (conservative && (trimmed.startsWith('/*!') || trimmed.slice(2, end).includes('/*'))) return ''
      rest = end < 0 ? '' : trimmed.slice(end + 2)
      continue
    }
    return trimmed
  }
}

function statementSyntax(sql: string, dialect: string, backslashEscapes: boolean): string | undefined {
  let syntax = ''
  let index = 0
  while (index < sql.length) {
    const char = sql[index]!
    if ((sql.startsWith('--', index) && (dialect !== 'mysql' || (sql[index + 2] ?? ' ') <= ' ')) || (dialect === 'mysql' && char === '#')) {
      const end = sql.slice(index).search(/[\r\n]/)
      index = end < 0 ? sql.length : index + end + 1
      syntax += ' '
    } else if (sql.startsWith('/*', index)) {
      if (dialect === 'mysql' && (sql[index + 2] === '!' || sql.startsWith('/*M!', index))) return undefined
      let depth = 1
      index += 2
      while (index < sql.length && depth > 0) {
        if (dialect === 'postgres' && sql.startsWith('/*', index)) { depth++; index += 2 }
        else if (sql.startsWith('*/', index)) { depth--; index += 2 }
        else index++
      }
      if (depth > 0) return undefined
      syntax += ' '
    } else if (dialect === 'postgres' && char === '$' && !/[\w$\u0080-\uFFFF]/.test(sql[index - 1] ?? '')) {
      const delimiter = /^\$(?:[A-Za-z_\u0080-\uFFFF][\w\u0080-\uFFFF]*)?\$/.exec(sql.slice(index))?.[0]
      if (!delimiter) { syntax += char; index++; continue }
      const end = sql.indexOf(delimiter, index + delimiter.length)
      if (end < 0) return undefined
      index = end + delimiter.length
      syntax += ' ? '
    } else if (char === "'" || char === '"' || (dialect !== 'postgres' && char === '`') || (dialect.startsWith('sqlite') && char === '[')) {
      const close = char === '[' ? ']' : char
      if (dialect === 'postgres' && char === '"' && /[uU]/.test(sql[index - 2] ?? '') && sql[index - 1] === '&') return undefined
      const escape = char === "'" && (backslashEscapes || (dialect === 'postgres' && /[eE]/.test(sql[index - 1] ?? '') && !/[\w$\u0080-\uFFFF]/.test(sql[index - 2] ?? '')))
        || (dialect === 'mysql' && char === '"' && backslashEscapes)
      let content = ''
      index++
      let closed = false
      while (index < sql.length) {
        const next = sql[index++]!
        if (escape && next === '\\') { index++; continue }
        if (next === close) {
          if (char !== '[' && sql[index] === close) { content += close; index++; continue }
          closed = true
          break
        }
        content += next
      }
      if (!closed) return undefined
      syntax += char !== "'" && content.toLowerCase() === 'set_config' ? ' set_config ' : ' ? '
    } else {
      syntax += char
      index++
    }
  }
  return syntax
}

function preservesSchema(syntax: string | undefined): boolean {
  if (syntax === undefined) return false
  const statement = syntax.replace(/^[\s(]+/, '')
  const keyword = /^[A-Za-z]+/.exec(statement)?.[0]?.toUpperCase()
  if (keyword === undefined || !SCHEMA_PRESERVING_KEYWORDS.has(keyword)) return false
  if (/;\s*\S/.test(statement) || /\bset_config\s*\(/i.test(statement)) return false
  if (keyword === 'EXPLAIN') return !SCHEMA_DEFINITIONS.test(statement)
  return !(READ_KEYWORDS.has(keyword) && /\binto\b/i.test(statement))
}

export function isSchemaPreservingRawStatement(sql: string, dialect = 'postgres'): boolean {
  if (!preservesSchema(statementSyntax(sql, dialect, false))) return false
  return dialect.startsWith('sqlite') || !sql.includes('\\') || preservesSchema(statementSyntax(sql, dialect, true))
}

export function rawStatementWriteTarget(sql: string, dialect: string): string | undefined {
  const statement = stripLeadingTrivia(sql, true)
  const prefix = /^(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+/i.exec(statement)
  if (!prefix) return undefined
  const target = RAW_WRITE_TARGET.exec(statement.slice(prefix[0].length))
  if (!target) return undefined
  const remainder = statement.slice(prefix[0].length + target[0].length).trimStart()
  const kind = prefix[1]!.split(/\s/)[0]!.toUpperCase()
  if (kind === 'UPDATE' && !/^SET\s/i.test(remainder)) return undefined
  if (kind === 'DELETE' && !/^(?:WHERE\b|RETURNING\b|ORDER\s+BY\b|LIMIT\b|;?\s*$)/i.test(remainder)) return undefined
  if (kind === 'INSERT' && !/^(?:\(|VALUES\b|DEFAULT\s+VALUES\b|SELECT\b)/i.test(remainder)) return undefined
  return target[1]!.split(/\s*\.\s*/).map(segment => {
    if (/^[A-Za-z_]/.test(segment)) return dialect === 'postgres' ? segment.toLowerCase() : segment
    return segment.slice(1, -1)
  }).join('.')
}
