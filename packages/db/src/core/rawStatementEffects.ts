const SCHEMA_PRESERVING_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE'])
const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])

function stripLeadingTrivia(sql: string): string {
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
      rest = end < 0 ? '' : trimmed.slice(end + 2)
      continue
    }
    return trimmed
  }
}

export function isSchemaPreservingRawStatement(sql: string): boolean {
  const statement = stripLeadingTrivia(sql)
  const keyword = /^[A-Za-z]+/.exec(statement)?.[0]?.toUpperCase()
  if (keyword === undefined || !SCHEMA_PRESERVING_KEYWORDS.has(keyword)) return false
  if (/;\s*\S/.test(statement) || /\b(?:set_config|search_path)\b/i.test(statement)) return false
  return !(READ_KEYWORDS.has(keyword) && /\binto\b/i.test(statement))
}
