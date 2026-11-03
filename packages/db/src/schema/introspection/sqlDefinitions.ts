import { findCreateIndexNameToken, parseTableDefinition, splitCreateTableSql, type ColumnConstraint, type ColumnDefinitionSql, type TableDefinitionSql } from './sqliteDefinitionGrammar'
import { readNameToken, splitTokensOnCommas, type SqlToken } from './sqliteTokens'

const STRING_LITERAL_PATTERN = '\'(?:[^\']|\'\')*\''

const QUOTE_PAIRS: Readonly<Record<string, string>> = { '\'': '\'', '"': '"', '`': '`', '[': ']' }

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

export { splitCreateTableSql }

export function splitTableDefinitions(createTableSql: string): string[] {
  return splitCreateTableSql(createTableSql)?.definitions ?? []
}

export function withIndexName(createIndexSql: string, quotedIndexName: string): string | undefined {
  const name = findCreateIndexNameToken(createIndexSql)
  if (!name) return undefined
  return `${createIndexSql.slice(0, name.start)}${quotedIndexName}${createIndexSql.slice(name.end)}`
}

function readColumnDefinition(definition: string): ColumnDefinitionSql | undefined {
  const parsed = parseTableDefinition(definition)
  return parsed.kind === 'column' ? parsed : undefined
}

export function readColumnDefinitionName(definition: string): string | undefined {
  return readColumnDefinition(definition)?.name
}

export function isGeneratedColumnDefinition(definition: string): boolean {
  return readColumnDefinition(definition)?.constraints.some(constraint => constraint.kind === 'GENERATED') ?? false
}

export interface EnumCheckDefinition {
  readonly name?: string
  readonly column: string
  readonly values: string[]
}

function readEnumCheck(check: SqlToken | undefined, name: string | undefined): EnumCheckDefinition[] {
  const [columnToken, operator, list, ...rest] = check?.children ?? []
  const column = readNameToken(columnToken)
  if (column === undefined || operator?.keyword !== 'IN' || list?.kind !== 'group' || rest.length > 0) return []
  const items = splitTokensOnCommas(list.children ?? [])
  const values = items.flatMap(([value, ...extra]) => value?.kind === 'string' && extra.length === 0 && value.value !== undefined ? [value.value] : [])
  if (values.length === 0 || values.length !== items.length) return []
  return [{ ...(name === undefined ? {} : { name }), column, values }]
}

function readDefinitionChecks(definition: TableDefinitionSql): { name?: string, check?: SqlToken }[] {
  if (definition.kind === 'column') return definition.constraints.filter(constraint => constraint.kind === 'CHECK')
  return definition.kind === 'CHECK' ? [definition] : []
}

export function readEnumChecks(definition: string): EnumCheckDefinition[] {
  return readDefinitionChecks(parseTableDefinition(definition)).flatMap(({ check, name }) => readEnumCheck(check, name))
}

export interface ForeignKeyDefinition {
  readonly columns: readonly string[]
  readonly table: string
  readonly name?: string
}

function readColumnForeignKey(columnName: string, constraint: ColumnConstraint): ForeignKeyDefinition[] {
  if (!constraint.references) return []
  const foreignKey = { columns: [columnName], table: constraint.references.table }
  return [constraint.name === undefined ? foreignKey : { ...foreignKey, name: constraint.name }]
}

export function readForeignKeys(definition: string): ForeignKeyDefinition[] {
  const parsed = parseTableDefinition(definition)
  if (parsed.kind === 'column') return parsed.constraints.flatMap(constraint => readColumnForeignKey(parsed.name, constraint))
  if (parsed.kind !== 'FOREIGN KEY' || !parsed.references) return []
  const foreignKey = { columns: parsed.columns, table: parsed.references.table }
  return [parsed.name === undefined ? foreignKey : { ...foreignKey, name: parsed.name }]
}

const STRING_LENGTH_PATTERN = /^(?:n?var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i

export function readStringLength(type: string): number | undefined {
  const match = type.trim().match(STRING_LENGTH_PATTERN)
  return match ? Number(match[1]) : undefined
}

export function isAutoIncrementDefinition(definition: string): boolean {
  return readColumnDefinition(definition)?.constraints.some(constraint => constraint.autoIncrement) ?? false
}

const CHANGED_COLUMN_CONSTRAINTS = new Set<ColumnConstraint['kind']>(['NOT NULL', 'NULL', 'DEFAULT'])

function isEnumCheckOf(constraint: ColumnConstraint, columnName: string): boolean {
  return constraint.kind === 'CHECK' && readEnumCheck(constraint.check, constraint.name).some(check => check.column === columnName)
}

export function readPreservedColumnConstraints(definition: string, columnName: string): string[] {
  return (readColumnDefinition(definition)?.constraints ?? [])
    .filter(constraint => !CHANGED_COLUMN_CONSTRAINTS.has(constraint.kind) && !isEnumCheckOf(constraint, columnName))
    .map(constraint => constraint.text)
}

function withoutColumnConstraints(column: ColumnDefinitionSql, removes: (constraint: ColumnConstraint) => boolean): string | undefined {
  const kept = column.constraints.filter(constraint => !removes(constraint))
  if (kept.length === column.constraints.length) return undefined
  return [column.nameAndType, ...kept.map(constraint => constraint.text)].join(' ')
}

type DefinitionRewrite = (definition: TableDefinitionSql) => string | null | undefined

function rewriteDefinitions(definitions: readonly string[], rewrite: DefinitionRewrite): string[] | undefined {
  let rewroteAny = false
  const kept: string[] = []
  for (const definition of definitions) {
    const rewritten = rewrite(parseTableDefinition(definition))
    if (rewritten === undefined) {
      kept.push(definition)
      continue
    }
    rewroteAny = true
    if (rewritten !== null) kept.push(rewritten)
  }
  return rewroteAny ? kept : undefined
}

export function withoutPrimaryKeyDefinitions(definitions: readonly string[]): string[] {
  return rewriteDefinitions(definitions, (definition) => {
    if (definition.kind === 'column') return withoutColumnConstraints(definition, constraint => constraint.kind === 'PRIMARY KEY')
    return definition.kind === 'PRIMARY KEY' ? null : undefined
  }) ?? [...definitions]
}

function sameColumns(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((column, index) => column === right[index])
}

export function withoutForeignKeyDefinitions(
  definitions: readonly string[],
  matches: (foreignKey: ForeignKeyDefinition) => boolean,
): string[] | undefined {
  return rewriteDefinitions(definitions, (definition) => {
    if (definition.kind === 'column') {
      return withoutColumnConstraints(definition, constraint => readColumnForeignKey(definition.name, constraint).some(matches))
    }
    if (definition.kind !== 'FOREIGN KEY' || !definition.references) return undefined
    const foreignKey = { columns: definition.columns, table: definition.references.table }
    return matches(definition.name === undefined ? foreignKey : { ...foreignKey, name: definition.name }) ? null : undefined
  })
}

export function withoutUniqueDefinitions(definitions: readonly string[], columns: readonly string[]): string[] | undefined {
  return rewriteDefinitions(definitions, (definition) => {
    if (definition.kind === 'column') {
      return sameColumns(columns, [definition.name])
        ? withoutColumnConstraints(definition, constraint => constraint.kind === 'UNIQUE')
        : undefined
    }
    return definition.kind === 'UNIQUE' && sameColumns(definition.columns, columns) ? null : undefined
  })
}
