import { findCreatedObjectName, type ForeignKeyConstraint, type KeyColumn, type StoredColumn, type StoredConstraint, type StoredTable } from './sqliteDefinitionGrammar'
import { sameIdentifier, sameIdentifiers, splitTokensOnCommas, type SqlToken } from './sqliteTokens'

const STRING_LITERAL_PATTERN = '\'(?:[^\']|\'\')*\''
const DEFAULT_COLLATION = 'BINARY'

export function unquoteStringLiteral(literal: string): string {
  return literal.slice(1, -1).replaceAll('\'\'', '\'')
}

export function readStringLiterals(text: string): string[] {
  return [...text.matchAll(new RegExp(STRING_LITERAL_PATTERN, 'g'))].map(match => unquoteStringLiteral(match[0]))
}

export function withIndexName(createIndexSql: string, quotedIndexName: string): string | undefined {
  const name = findCreatedObjectName(createIndexSql)?.name
  if (!name) return undefined
  return `${createIndexSql.slice(0, name.start)}${quotedIndexName}${createIndexSql.slice(name.end)}`
}

export function withSchemaQualifiedName(createSql: string, quotedSchema: string): string | undefined {
  const created = findCreatedObjectName(createSql)
  if (!created) return undefined
  return `${createSql.slice(0, created.qualifiedStart)}${quotedSchema}.${createSql.slice(created.name.start)}`
}

const STRING_LENGTH_PATTERN = /^(?:n?var)?char(?:acter)?(?:\s+varying)?\s*\(\s*(\d+)\s*\)/i

export function readStringLength(type: string): number | undefined {
  const match = type.trim().match(STRING_LENGTH_PATTERN)
  return match ? Number(match[1]) : undefined
}

export interface EnumCheckDefinition {
  readonly name?: string
  readonly column: string
  readonly values: string[]
}

export interface IndexKeyColumn {
  readonly name: string
  readonly collation: string
}

type ConstraintMatcher = (constraint: StoredConstraint) => boolean

function allConstraints(table: StoredTable): StoredConstraint[] {
  return [...table.columns.flatMap(column => column.constraints), ...table.constraints]
}

function readExpressionColumn(token: SqlToken | undefined): string | undefined {
  return token?.kind === 'word' || token?.kind === 'quotedIdentifier' ? token.value : undefined
}

function readEnumCheck(constraint: StoredConstraint): EnumCheckDefinition | undefined {
  if (constraint.kind !== 'CHECK') return undefined
  const [columnToken, operator, list, ...rest] = constraint.expression
  const column = readExpressionColumn(columnToken)
  if (column === undefined || operator?.keyword !== 'IN' || list?.kind !== 'group' || rest.length > 0) return undefined
  const items = splitTokensOnCommas(list.children ?? [])
  const values = items.flatMap(([value, ...extra]) => value?.kind === 'string' && value.value !== undefined && extra.length === 0 ? [value.value] : [])
  if (values.length === 0 || values.length !== items.length) return undefined
  return { ...(constraint.name === undefined ? {} : { name: constraint.name }), column, values }
}

function isEnumCheckOn(constraint: StoredConstraint, columnName: string): boolean {
  return sameIdentifier(columnName, readEnumCheck(constraint)?.column)
}

export function findStoredColumn(table: StoredTable, columnName: string): StoredColumn | undefined {
  return table.columns.find(column => sameIdentifier(column.name, columnName))
}

export function readEnumChecks(table: StoredTable): EnumCheckDefinition[] {
  return allConstraints(table).flatMap((constraint) => {
    const check = readEnumCheck(constraint)
    return check ? [{ ...check, column: findStoredColumn(table, check.column)?.name ?? check.column }] : []
  })
}

export function readForeignKeys(table: StoredTable): ForeignKeyConstraint[] {
  return allConstraints(table).filter(constraint => constraint.kind === 'FOREIGN KEY')
}

export function hasAutoIncrement(table: StoredTable): boolean {
  return allConstraints(table).some(constraint => constraint.kind === 'PRIMARY KEY' && constraint.autoIncrement)
}

export function isGeneratedColumn(column: StoredColumn): boolean {
  return column.constraints.some(constraint => constraint.kind === 'GENERATED')
}

function renderColumn(column: StoredColumn, constraints: readonly StoredConstraint[]): string {
  return constraints.length === column.constraints.length ? column.text : [column.declaration, ...constraints.map(constraint => constraint.text)].join(' ')
}

export function renderDefinitions(table: StoredTable): string[] {
  return [...table.columns.map(column => column.text), ...table.constraints.map(constraint => constraint.text)]
}

function withoutConstraints(table: StoredTable, matches: ConstraintMatcher): string[] | undefined {
  if (!allConstraints(table).some(matches)) return undefined
  const kept = (constraints: readonly StoredConstraint[]) => constraints.filter(constraint => !matches(constraint))
  return [
    ...table.columns.map(column => renderColumn(column, kept(column.constraints))),
    ...kept(table.constraints).map(constraint => constraint.text),
  ]
}

const CHANGED_COLUMN_CONSTRAINTS = new Set<StoredConstraint['kind']>(['NOT NULL', 'NULL', 'DEFAULT'])

export function readPreservedColumnConstraints(column: StoredColumn): string[] {
  return column.constraints
    .filter(constraint => !CHANGED_COLUMN_CONSTRAINTS.has(constraint.kind) && !isEnumCheckOn(constraint, column.name))
    .map(constraint => constraint.text)
}

export function withChangedColumn(table: StoredTable, changed: StoredColumn, changedDefinition: string): string[] {
  return [
    ...table.columns.map(column => column === changed ? changedDefinition : column.text),
    ...table.constraints.filter(constraint => !isEnumCheckOn(constraint, changed.name)).map(constraint => constraint.text),
  ]
}

export function withoutPrimaryKeys(table: StoredTable): string[] {
  return withoutConstraints(table, constraint => constraint.kind === 'PRIMARY KEY') ?? renderDefinitions(table)
}

export function withoutForeignKeys(table: StoredTable, matches: (foreignKey: ForeignKeyConstraint) => boolean): string[] | undefined {
  return withoutConstraints(table, constraint => constraint.kind === 'FOREIGN KEY' && matches(constraint))
}

function keyCollation(table: StoredTable, keyColumn: KeyColumn): string {
  const declared = findStoredColumn(table, keyColumn.name)?.constraints.flatMap(constraint => constraint.kind === 'COLLATE' ? [constraint.collation] : []) ?? []
  return keyColumn.collation ?? declared.at(-1) ?? DEFAULT_COLLATION
}

function withoutUniques(table: StoredTable, matchesKey: (columns: readonly KeyColumn[]) => boolean): string[] | undefined {
  return withoutConstraints(table, constraint => constraint.kind === 'UNIQUE' && matchesKey(constraint.columns))
}

export function withoutUniquesOnColumns(table: StoredTable, columns: readonly string[]): string[] | undefined {
  return withoutUniques(table, key => sameIdentifiers(key.map(keyColumn => keyColumn.name), columns))
}

export function withoutUniquesBackingIndex(table: StoredTable, indexKey: readonly IndexKeyColumn[]): string[] | undefined {
  return withoutUniques(table, key => key.length === indexKey.length && key.every((keyColumn, position) => {
    const indexColumn = indexKey[position]
    return sameIdentifier(keyColumn.name, indexColumn?.name) && sameIdentifier(keyCollation(table, keyColumn), indexColumn?.collation)
  }))
}
