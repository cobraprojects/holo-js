export { column, ColumnBuilder } from './columns'
export {
  clearGeneratedTables,
  defineGeneratedTable,
  getGeneratedTableDefinition,
  listGeneratedTableDefinitions,
  registerGeneratedTables,
  resolveGeneratedTableDefinition,
  renderGeneratedSchemaModule,
  renderGeneratedSchemaPlaceholder,
} from './generated'
export { TableDefinitionBuilder } from './TableDefinitionBuilder'
export { TableMutationBuilder } from './TableMutationBuilder'
export { SchemaRegistry, createSchemaRegistry } from './SchemaRegistry'
export { SchemaService, createSchemaService } from './SchemaService'
export { diffSchema, diffSchema as createSchemaDiff } from './diff'
export { SQLSchemaCompiler } from './SQLSchemaCompiler'
export { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
export { PostgresSchemaCompiler } from './PostgresSchemaCompiler'
export { MySQLSchemaCompiler } from './MySQLSchemaCompiler'
export { compileDialectDefaultLiteral } from './defaultLiterals'
export { DIALECT_VECTOR_SUPPORT, normalizeDialectReadValue, normalizeDialectWriteValue } from './normalization'
export { DIALECT_ID_STRATEGY_MAP, DIALECT_LOGICAL_TYPE_MAP, resolveDialectColumnType, resolveDialectIdStrategyType } from './typeMapping'
export { addColumnOperation, alterColumnOperation, createForeignKeyOperation, createIndexOperation, createTableOperation, dropColumnOperation, dropForeignKeyOperation, dropIndexOperation, dropTableOperation, renameColumnOperation, renameIndexOperation, renameTableOperation } from './ddl'
export type {
  AnyColumnDefinition,
  ColumnDefinition,
  ForeignKeyReference,
  TableColumnsShape,
  IdGenerationStrategy,
  InferInsert,
  InferSelect,
  InferUpdate,
  LogicalColumnKind,
  TableDefinition,
  TableIndexDefinition,
  VectorValue,
} from './types'
export type { BoundTableDefinition, DefineTableOptions } from './defineTable'
export type {
  GeneratedSchemaTable,
  GeneratedSchemaTableName,
  GeneratedSchemaTables,
} from './generated'
export type { SchemaDialectName } from './typeMapping'
export type { SchemaDefaultDialectName } from './defaultLiterals'
export type { AddColumnOperation, AlterColumnOperation, CreateForeignKeyOperation, DDLStatement, DDLOperation, CreateIndexOperation, CreateTableOperation, DropColumnOperation, DropForeignKeyOperation, DropIndexOperation, DropTableOperation, RenameColumnOperation, RenameIndexOperation, RenameTableOperation } from './ddl'
export type { IntrospectedColumn, IntrospectedForeignKey, IntrospectedIndex, SchemaSyncPlan } from './SchemaService'
export type { SchemaDiff, TableSchemaDiff, SchemaColumnMismatch, SchemaIndexMismatch, SchemaForeignKeyMismatch } from './diff'
