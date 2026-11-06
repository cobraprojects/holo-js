const SCHEMA_PRESERVING_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'EXPLAIN', 'DESCRIBE', 'DESC', 'INSERT', 'UPDATE', 'DELETE', 'REPLACE', 'SAVEPOINT', 'RELEASE', 'LOCK'])
const SETTING_KEYWORDS = new Set(['SET', 'RESET'])
const READ_KEYWORDS = new Set(['SELECT', 'WITH', 'VALUES', 'TABLE'])
const SCHEMA_SETTINGS = /\b(?:search_path|schema|role|authorization|all)\b/i
const SCHEMA_DEFINITIONS = /\b(?:create|alter|drop|truncate|rename|into)\b/i

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
  if (keyword === undefined) return false
  if (/;\s*\S/.test(statement) || /\b(?:set_config|search_path)\b/i.test(statement)) return false
  if (SETTING_KEYWORDS.has(keyword)) return !SCHEMA_SETTINGS.test(statement)
  if (!SCHEMA_PRESERVING_KEYWORDS.has(keyword)) return false
  if (keyword === 'EXPLAIN') return !SCHEMA_DEFINITIONS.test(statement)
  return !(READ_KEYWORDS.has(keyword) && /\binto\b/i.test(statement))
}
