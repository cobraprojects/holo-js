const IDENTIFIER_PATTERN = '"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Z_]\\w*'
const STRING_LITERAL_PATTERN = '\'(?:[^\']|\'\')*\''

const QUOTE_PAIRS: Readonly<Record<string, string>> = { '\'': '\'', '"': '"', '`': '`', '[': ']' }

function unquoteIdentifier(identifier: string): string {
  const first = identifier[0]
  if (first === '"') return identifier.slice(1, -1).replaceAll('""', '"')
  if (first === '`') return identifier.slice(1, -1).replaceAll('``', '`')
  if (first === '[') return identifier.slice(1, -1)
  return identifier
}

export function unquoteStringLiteral(literal: string): string {
  return literal.slice(1, -1).replaceAll('\'\'', '\'')
}

export function readStringLiterals(text: string): string[] {
  return [...text.matchAll(new RegExp(STRING_LITERAL_PATTERN, 'g'))].map(match => unquoteStringLiteral(match[0]))
}

type UnquotedCharacterVisitor = (character: string, index: number, depth: number) => boolean

function findUnquotedCharacter(sql: string, startIndex: number, matches: UnquotedCharacterVisitor): number {
  let depth = 0
  for (let index = startIndex; index < sql.length; index += 1) {
    const character = sql.charAt(index)
    const closingQuote = QUOTE_PAIRS[character]
    if (closingQuote) {
      index = sql.indexOf(closingQuote, index + 1)
      if (index === -1) return -1
      continue
    }
    if (character === '(') depth += 1
    if (character === ')') depth -= 1
    if (matches(character, index, depth)) return index
  }
  return -1
}

export function findClosingParenthesis(sql: string, openIndex: number): number {
  return findUnquotedCharacter(sql, openIndex, (character, _index, depth) => character === ')' && depth === 0)
}

function splitTopLevelCommas(sql: string): string[] {
  const separators: number[] = []
  findUnquotedCharacter(sql, 0, (character, index, depth) => {
    if (character === ',' && depth === 0) separators.push(index)
    return false
  })
  const starts = [0, ...separators.map(separator => separator + 1)]
  return starts.map((start, position) => sql.slice(start, separators[position] ?? sql.length).trim())
}

export interface CreateTableSqlParts {
  readonly definitions: string[]
  readonly options: string
}

export function splitCreateTableSql(createTableSql: string): CreateTableSqlParts | undefined {
  const openIndex = createTableSql.indexOf('(')
  const closeIndex = openIndex === -1 ? -1 : findClosingParenthesis(createTableSql, openIndex)
  if (closeIndex === -1) return undefined

  const definitions = splitTopLevelCommas(createTableSql.slice(openIndex + 1, closeIndex))
  return {
    definitions: definitions.filter(definition => definition.length > 0),
    options: createTableSql.slice(closeIndex + 1).trim(),
  }
}

export function splitTableDefinitions(createTableSql: string): string[] {
  return splitCreateTableSql(createTableSql)?.definitions ?? []
}

const CREATE_INDEX_NAME_PATTERN = new RegExp(`^(CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+)(?:${IDENTIFIER_PATTERN})`, 'i')

export function withIndexName(createIndexSql: string, quotedIndexName: string): string | undefined {
  if (!CREATE_INDEX_NAME_PATTERN.test(createIndexSql)) return undefined
  return createIndexSql.replace(CREATE_INDEX_NAME_PATTERN, (_match, prefix: string) => `${prefix}${quotedIndexName}`)
}

const PRIMARY_KEY_CONSTRAINT_PATTERN = /^(?:CONSTRAINT\s+\S+\s+)?PRIMARY\s+KEY\b/i
const TABLE_CONSTRAINT_PATTERN = /^(?:CONSTRAINT\s+\S+\s+)?(?:PRIMARY\s+KEY|UNIQUE|CHECK|FOREIGN\s+KEY)\b/i
const LEADING_IDENTIFIER_PATTERN = new RegExp(`^(${IDENTIFIER_PATTERN})`, 'i')

export function isPrimaryKeyConstraintDefinition(definition: string): boolean {
  return PRIMARY_KEY_CONSTRAINT_PATTERN.test(definition)
}

export function readColumnDefinitionName(definition: string): string | undefined {
  if (TABLE_CONSTRAINT_PATTERN.test(definition)) return undefined
  const name = definition.match(LEADING_IDENTIFIER_PATTERN)?.[1]
  return name === undefined ? undefined : unquoteIdentifier(name)
}

const ENUM_CHECK_PATTERN = new RegExp(
  `(?:CONSTRAINT\\s+(${IDENTIFIER_PATTERN})\\s+)?CHECK\\s*\\(\\s*(${IDENTIFIER_PATTERN})\\s+IN\\s*\\(\\s*(${STRING_LITERAL_PATTERN}(?:\\s*,\\s*${STRING_LITERAL_PATTERN})*)\\s*\\)\\s*\\)`,
  'gi',
)

export function readEnumChecks(definition: string): { name?: string, column: string, values: string[] }[] {
  return [...definition.matchAll(ENUM_CHECK_PATTERN)].flatMap(([, name, column, values]) => column === undefined || values === undefined
    ? []
    : [{
        ...(name ? { name: unquoteIdentifier(name) } : {}),
        column: unquoteIdentifier(column),
        values: readStringLiterals(values),
      }])
}

const INLINE_FOREIGN_KEY_NAME_PATTERN = new RegExp(`CONSTRAINT\\s+(${IDENTIFIER_PATTERN})\\s+REFERENCES\\b`, 'i')
const TABLE_FOREIGN_KEY_PATTERN = new RegExp(
  `^(?:CONSTRAINT\\s+(${IDENTIFIER_PATTERN})\\s+)?FOREIGN\\s+KEY\\s*\\(\\s*(${IDENTIFIER_PATTERN})\\s*\\)`,
  'i',
)

export interface ForeignKeyDefinition {
  readonly column: string
  readonly name?: string
}

export function readForeignKey(definition: string, columnName: string | undefined): ForeignKeyDefinition | undefined {
  if (columnName) {
    if (!readInlineColumnConstraints(definition).references) return undefined
    const name = definition.match(INLINE_FOREIGN_KEY_NAME_PATTERN)?.[1]
    return name === undefined ? { column: columnName } : { column: columnName, name: unquoteIdentifier(name) }
  }

  const [, name, column] = definition.match(TABLE_FOREIGN_KEY_PATTERN) ?? []
  if (column === undefined) return undefined
  return name ? { column: unquoteIdentifier(column), name: unquoteIdentifier(name) } : { column: unquoteIdentifier(column) }
}

const STRING_LENGTH_PATTERN = /^(?:n?var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i

export function readStringLength(type: string): number | undefined {
  const match = type.trim().match(STRING_LENGTH_PATTERN)
  return match ? Number(match[1]) : undefined
}

const QUOTED_TEXT_PATTERN = new RegExp(`${STRING_LITERAL_PATTERN}|"(?:[^"]|"")*"|\`(?:[^\`]|\`\`)*\`|\\[[^\\]]*\\]`, 'g')

export interface InlineColumnConstraints {
  readonly primaryKey: boolean
  readonly autoIncrement: boolean
  readonly unique: boolean
  readonly references: boolean
}

export function readInlineColumnConstraints(definition: string): InlineColumnConstraints {
  const keywords = definition.replace(QUOTED_TEXT_PATTERN, ' ')
  return {
    primaryKey: /\bPRIMARY\s+KEY\b/i.test(keywords),
    autoIncrement: /\bAUTOINCREMENT\b/i.test(keywords),
    unique: /\bUNIQUE\b/i.test(keywords),
    references: /\bREFERENCES\b/i.test(keywords),
  }
}

const INLINE_PRIMARY_KEY_PATTERN = new RegExp(
  `(${QUOTED_TEXT_PATTERN.source})|(?:\\s+CONSTRAINT\\s+(?:${IDENTIFIER_PATTERN}))?\\s+PRIMARY\\s+KEY(?:\\s+(?:ASC|DESC))?(?:\\s+ON\\s+CONFLICT\\s+\\w+)?(?:\\s+AUTOINCREMENT)?\\b`,
  'gi',
)

export function withoutInlinePrimaryKey(definition: string): string {
  return definition.replace(INLINE_PRIMARY_KEY_PATTERN, (match, quoted: string | undefined) => quoted ?? '')
}

const IDENTIFIER = `(?:${IDENTIFIER_PATTERN})`
const QUOTED_TEXT_GROUP = `(${QUOTED_TEXT_PATTERN.source})`
const INLINE_FOREIGN_KEY_PATTERN = new RegExp(
  `${QUOTED_TEXT_GROUP}|\\s+(?:CONSTRAINT\\s+${IDENTIFIER}\\s+)?REFERENCES\\s+${IDENTIFIER}(?:\\s*\\.\\s*${IDENTIFIER})?(?:\\s*\\(\\s*${IDENTIFIER}(?:\\s*,\\s*${IDENTIFIER})*\\s*\\))?`
  + '(?:\\s+ON\\s+(?:DELETE|UPDATE)\\s+(?:SET\\s+NULL|SET\\s+DEFAULT|CASCADE|RESTRICT|NO\\s+ACTION)|\\s+MATCH\\s+\\w+|\\s+(?:NOT\\s+)?DEFERRABLE(?:\\s+INITIALLY\\s+(?:DEFERRED|IMMEDIATE))?)*',
  'gi',
)
const INLINE_UNIQUE_PATTERN = new RegExp(
  `${QUOTED_TEXT_GROUP}|\\s+(?:CONSTRAINT\\s+${IDENTIFIER}\\s+)?UNIQUE(?:\\s+ON\\s+CONFLICT\\s+\\w+)?\\b`,
  'gi',
)
const TABLE_UNIQUE_PATTERN = new RegExp(`^(?:CONSTRAINT\\s+${IDENTIFIER}\\s+)?UNIQUE\\s*\\(([^)]*)\\)`, 'i')

function withoutInlineClause(definition: string, pattern: RegExp): string | undefined {
  const rewritten = definition.replace(pattern, (match, quoted: string | undefined) => quoted ?? '')
  return rewritten === definition ? undefined : rewritten
}

function readTableUniqueColumns(definition: string): string[] | undefined {
  const match = definition.match(TABLE_UNIQUE_PATTERN)
  return match?.[1]?.split(',').map(column => readColumnDefinitionName(column.trim()) ?? column.trim())
}

function rewriteDefinitions(
  definitions: readonly string[],
  rewrite: (definition: string, columnName: string | undefined) => string | null | undefined,
): string[] | undefined {
  let rewroteAny = false
  const kept: string[] = []
  for (const definition of definitions) {
    const rewritten = rewrite(definition, readColumnDefinitionName(definition))
    if (rewritten === undefined) {
      kept.push(definition)
      continue
    }
    rewroteAny = true
    if (rewritten !== null) kept.push(rewritten)
  }
  return rewroteAny ? kept : undefined
}

export function withoutForeignKeyDefinitions(
  definitions: readonly string[],
  matches: (foreignKey: ForeignKeyDefinition) => boolean,
): string[] | undefined {
  return rewriteDefinitions(definitions, (definition, columnName) => {
    const foreignKey = readForeignKey(definition, columnName)
    if (!foreignKey || !matches(foreignKey)) return undefined
    return columnName ? withoutInlineClause(definition, INLINE_FOREIGN_KEY_PATTERN) : null
  })
}

export function withoutUniqueDefinitions(definitions: readonly string[], columns: readonly string[]): string[] | undefined {
  return rewriteDefinitions(definitions, (definition, columnName) => {
    if (columnName) {
      return columns.length === 1 && columns[0] === columnName && readInlineColumnConstraints(definition).unique
        ? withoutInlineClause(definition, INLINE_UNIQUE_PATTERN)
        : undefined
    }
    return readTableUniqueColumns(definition)?.join('\0') === columns.join('\0') ? null : undefined
  })
}
