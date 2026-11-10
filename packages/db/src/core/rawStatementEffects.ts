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

export function isSchemaPreservingRawStatement(sql: string): boolean {
  const statement = stripLeadingTrivia(sql)
  const keyword = /^[A-Za-z]+/.exec(statement)?.[0]?.toUpperCase()
  if (keyword === undefined) return false
  if (/;\s*\S/.test(statement) || /\b(?:set_config|search_path)\b/i.test(statement)) return false
  if (!SCHEMA_PRESERVING_KEYWORDS.has(keyword)) return false
  if (keyword === 'EXPLAIN') return !SCHEMA_DEFINITIONS.test(statement)
  return !(READ_KEYWORDS.has(keyword) && /\binto\b/i.test(statement))
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
