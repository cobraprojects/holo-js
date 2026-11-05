/* v8 ignore file -- type declarations only */
import type { ComputedColumn } from '../types'

export type SchemaReadingDialect = 'sqlite' | 'postgres' | 'mysql'

export type DatabaseColumnDefault
  = | { readonly kind: 'none' }
    | { readonly kind: 'now' }
    | { readonly kind: 'literal', readonly value: string | boolean | null }
    | { readonly kind: 'expression', readonly sql: string }

export interface DatabaseColumnStructure {
  readonly name: string
  readonly dataType: string
  readonly fullType: string
  readonly length?: number
  readonly notNull: boolean
  readonly defaultExpression: string | null
  readonly default: DatabaseColumnDefault
  readonly primaryKey: boolean
  readonly autoIncrement: boolean
  readonly computed?: ComputedColumn
}

export interface DatabaseIndexStructure {
  readonly name: string
  readonly unique: boolean
  readonly primary: boolean
  readonly constraint: boolean
  readonly columns: readonly string[]
  readonly representable: boolean
}

export interface DatabaseForeignKeyStructure {
  readonly name?: string
  readonly columns: readonly string[]
  readonly table: string
  readonly from: string
  readonly to: string
  readonly onUpdate: string
  readonly onDelete: string
}

export interface DatabaseEnumCheckStructure {
  readonly name?: string
  readonly column: string
  readonly values: readonly string[]
}

export interface DatabaseTableStructure {
  readonly dialect: SchemaReadingDialect
  readonly tableName: string
  readonly schema?: string
  readonly columns: readonly DatabaseColumnStructure[]
  readonly primaryKeyColumns: readonly string[]
  readonly indexes: readonly DatabaseIndexStructure[]
  readonly foreignKeys: readonly DatabaseForeignKeyStructure[]
  readonly enumChecks: readonly DatabaseEnumCheckStructure[]
}

export interface TableLocation {
  readonly schema: string
  readonly table: string
}

export interface DialectSchemaReader {
  listTables(): Promise<string[]>
  locateTable(tableName: string): Promise<TableLocation | undefined>
  resolveReferencedTableSchema(tableName: string, ownerSchema: string): Promise<string | undefined>
  readTableStructure(tableName: string): Promise<DatabaseTableStructure | undefined>
  readListedTableStructure?(tableName: string): Promise<DatabaseTableStructure | undefined>
}
