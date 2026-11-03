import { currentPinnedConnection } from '../concurrency/pinnedConnection'
import { SchemaError } from '../core/errors'
import { dropTableOperation, renameTableOperation } from './ddl'
import { createSchemaReader, readTableStructure } from './introspection'
import { toTableDefinition } from './introspection/definitions'
import { listSQLiteReferencingTables, readSQLiteCreateTableSql, readSQLiteTableObjects, SQLITE_AUTOINDEX_PREFIX } from './introspection/sqlite'
import { isPrimaryKeyConstraintDefinition, readColumnDefinitionName, readEnumChecks, readInlineColumnConstraints, splitCreateTableSql, withoutForeignKeyDefinitions, withoutInlinePrimaryKey, withoutUniqueDefinitions } from './introspection/sqlDefinitions'
import { createSQLiteSchemaCompiler } from './schemaCompilerFactory'
import { executeStatements } from './ddlExecution'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DatabaseTableStructure } from './introspection'
import type { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
import type { AnyColumnDefinition, ForeignKeyReference } from './types'

type SQLiteForeignKeysRow = {
  foreign_keys: number
}

type SQLiteTableRewrite = (
  structure: DatabaseTableStructure,
  definitions: readonly string[],
) => Array<string | AnyColumnDefinition>

export type ForeignKeyConstraintSuspender = <TResult>(callback: () => Promise<TResult>) => Promise<TResult>

export class SQLiteSchemaOperations {
  private readonly compiler: SQLiteSchemaCompiler

  constructor(
    private readonly connection: DatabaseContext,
    private readonly withoutForeignKeyConstraints: ForeignKeyConstraintSuspender,
  ) {
    this.compiler = createSQLiteSchemaCompiler(connection)
  }

  async changeColumn(tableName: string, column: AnyColumnDefinition): Promise<void> {
    await this.rebuildTable(tableName, (structure, definitions) => {
      if (!structure.columns.some(existing => existing.name === column.name)) {
        throw new SchemaError(
          `SQLite cannot change missing column "${column.name}" on table "${tableName}". Add the column without change() first.`,
        )
      }

      return definitions.flatMap((definition): Array<string | AnyColumnDefinition> => {
        const columnName = readColumnDefinitionName(definition)
        if (columnName === column.name) {
          return [keepInlineColumnConstraints(structure, definition, column)]
        }

        if (columnName === undefined && readEnumChecks(definition).some(check => check.column === column.name)) {
          return []
        }

        return [definition]
      })
    })
  }

  async createPrimaryKey(tableName: string, columns: readonly string[], constraintName?: string): Promise<void> {
    await this.rebuildTable(tableName, (structure, definitions) => {
      if (structure.columns.some(column => column.primaryKey)) {
        throw new SchemaError(`Table "${tableName}" already has a primary key. Drop it with dropPrimary() first.`)
      }

      return [...definitions, this.compiler.compilePrimaryKeyConstraint(columns, constraintName)]
    })
  }

  async dropPrimaryKey(tableName: string): Promise<void> {
    await this.rebuildTable(tableName, (_structure, definitions) => definitions
      .filter(definition => !isPrimaryKeyConstraintDefinition(definition))
      .map(definition => readColumnDefinitionName(definition) === undefined ? definition : withoutInlinePrimaryKey(definition)))
  }

  async renameIndex(tableName: string, fromIndexName: string, toIndexName: string): Promise<void> {
    const index = (await readTableStructure(this.connection, tableName))?.indexes
      .find(candidate => candidate.name === fromIndexName)
    if (!index) {
      throw new SchemaError(`SQLite cannot rename missing index "${fromIndexName}" on table "${tableName}".`)
    }
    if (!index.representable) {
      throw new SchemaError(`SQLite cannot rename index "${fromIndexName}" on table "${tableName}" because it is a partial or expression index.`)
    }

    const statements = this.compiler.compileRecreateIndex(tableName, fromIndexName, { name: toIndexName, columns: index.columns, unique: index.unique })
    await this.connection.transaction(transaction => executeStatements(transaction, statements))
  }

  async addForeignKey(
    tableName: string,
    columnName: string,
    reference: ForeignKeyReference,
    constraintName?: string,
  ): Promise<void> {
    const foreignKey = this.compiler.compileTableForeignKey(tableName, columnName, reference, constraintName)
    await this.rebuildTable(tableName, (structure, definitions) => {
      if (structure.foreignKeys.some(existing => existing.name === foreignKey.name)) {
        throw new SchemaError(`SQLite cannot add foreign key "${foreignKey.name}" to table "${tableName}" because the table already has a foreign key with that name.`)
      }
      return [...definitions, foreignKey.definition]
    })
  }

  async dropForeignKey(tableName: string, constraintName: string, columns?: readonly string[]): Promise<void> {
    const unnamedColumn = columns?.length === 1 ? columns[0] : undefined
    await this.rebuildTable(tableName, (_structure, definitions) => {
      const kept = withoutForeignKeyDefinitions(definitions, foreignKey => foreignKey.name === undefined
        ? foreignKey.column === unnamedColumn
        : foreignKey.name === constraintName)
      if (!kept) {
        throw new SchemaError(`SQLite cannot drop missing foreign key "${constraintName}" on table "${tableName}".`)
      }
      return kept
    })
  }

  async dropInlineUnique(tableName: string, indexName: string, columns?: readonly string[]): Promise<boolean> {
    const indexes = (await readTableStructure(this.connection, tableName))?.indexes ?? []
    const index = indexes.find(candidate => candidate.name === indexName)
    const inlineColumns = index ? (index.name.startsWith(SQLITE_AUTOINDEX_PREFIX) ? index.columns : undefined) : columns
    if (!inlineColumns) {
      return false
    }

    await this.rebuildTable(tableName, (_structure, definitions) => {
      const kept = withoutUniqueDefinitions(definitions, inlineColumns)
      if (!kept) {
        throw new SchemaError(`SQLite cannot drop missing unique "${indexName}" on table "${tableName}".`)
      }
      return kept
    })
    return true
  }

  private async rebuildTable(tableName: string, rewrite: SQLiteTableRewrite): Promise<void> {
    if (!(await this.foreignKeysEnabled())) {
      await this.connection.transaction(transaction => this.copyTable(transaction, tableName, rewrite))
      return
    }

    if (this.connection.isInTransaction() || currentPinnedConnection(this.connection.getAdapter())) {
      await this.assertTableUnreferenced(tableName)
      await this.connection.transaction(transaction => this.copyTable(transaction, tableName, rewrite))
      return
    }

    await this.withoutForeignKeyConstraints(() => this.connection.transaction(async (transaction) => {
      await this.copyTable(transaction, tableName, rewrite)
      await this.assertNoForeignKeyViolations(transaction, tableName)
    }))
  }

  private async foreignKeysEnabled(): Promise<boolean> {
    const result = await this.connection.introspectCompiled<SQLiteForeignKeysRow>(this.compiler.compileForeignKeyEnforcementQuery())
    return Number(result.rows[0]?.foreign_keys) === 1
  }

  private async assertTableUnreferenced(tableName: string): Promise<void> {
    const referencingTables = await listSQLiteReferencingTables(this.connection, tableName)
    if (referencingTables.length > 0) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" inside a transaction while foreign-key enforcement is on, because table "${referencingTables.join('", "')}" references it. Run the change outside the transaction or in a migration.`,
      )
    }
  }

  private async assertNoForeignKeyViolations(connection: DatabaseContext, tableName: string): Promise<void> {
    const result = await connection.introspectCompiled(this.compiler.compileForeignKeyViolationsQuery(tableName))
    if (result.rows.length > 0) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" because it would leave ${result.rows.length} foreign key violation${result.rows.length === 1 ? '' : 's'}.`,
      )
    }
  }

  private async copyTable(connection: DatabaseContext, tableName: string, rewrite: SQLiteTableRewrite): Promise<void> {
    const structure = await readTableStructure(connection, tableName)
    if (!structure) {
      throw new SchemaError(`SQLite cannot rebuild table "${tableName}" because it does not exist.`)
    }

    const temporaryTableName = `__holo_rebuild_${tableName.replaceAll('.', '_')}`
    if ((await createSchemaReader(connection).listTables()).includes(temporaryTableName)) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" because temporary table "${temporaryTableName}" already exists.`,
      )
    }

    const currentSql = splitCreateTableSql(await readSQLiteCreateTableSql(connection, tableName) ?? '')
    if (!currentSql) {
      throw new SchemaError(`SQLite cannot read the definition of table "${tableName}" to rebuild it.`)
    }

    const schemaObjects = await readSQLiteTableObjects(connection, tableName)
    const definitions = rewrite(structure, currentSql.definitions)
    const copiedColumns = structure.columns.filter(existing => !existing.computed).map(existing => existing.name)

    await executeStatements(connection, [
      this.compiler.compileRebuildTable(tableName, temporaryTableName, definitions, currentSql.options),
      this.compiler.compileCopyTableRows(tableName, temporaryTableName, copiedColumns),
      ...(definitions.some(isAutoIncrementDefinition) ? this.compiler.compileMoveAutoIncrementSequence(tableName, temporaryTableName) : []),
      ...this.compiler.compile(dropTableOperation(tableName)),
      ...this.compiler.compile(renameTableOperation(temporaryTableName, tableName)),
      ...schemaObjects.map(object => ({ sql: object.sql, source: `schema:sqliteRebuild:restore:${object.type}:${object.name}` })),
    ])
  }
}

function isAutoIncrementDefinition(definition: string | AnyColumnDefinition): boolean {
  return typeof definition === 'string'
    ? readInlineColumnConstraints(definition).autoIncrement
    : definition.idStrategy === 'autoIncrement'
}

function keepInlineColumnConstraints(
  structure: DatabaseTableStructure,
  definition: string,
  column: AnyColumnDefinition,
): AnyColumnDefinition {
  const inline = readInlineColumnConstraints(definition)
  const references = inline.references ? toTableDefinition(structure).columns[column.name]?.references : undefined
  return {
    ...column,
    primaryKey: inline.primaryKey,
    unique: inline.unique,
    references,
    ...(inline.autoIncrement ? { idStrategy: 'autoIncrement' as const } : {}),
  }
}
