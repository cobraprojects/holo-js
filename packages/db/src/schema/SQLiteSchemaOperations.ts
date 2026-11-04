import { currentPinnedConnection } from '../concurrency/pinnedConnection'
import { SchemaError } from '../core/errors'
import { dropTableOperation, renameTableOperation } from './ddl'
import { createSchemaReader, readTableStructure } from './introspection'
import { listSQLiteReferencingTables, readSQLiteCreateTableSql, readSQLiteDependentObjects, readSQLiteIndexKey, readSQLiteStoredTableName, readSQLiteTableObjects, SQLITE_AUTOINDEX_PREFIX } from './introspection/sqlite'
import { findStoredColumn, findUnshadowedRowIdName, hasAutoIncrement, isGeneratedColumn, keepsRowIdOnlyAsHiddenColumn, readPreservedColumnConstraints, renderDefinitions, withAddedColumn, withChangedColumn, withoutForeignKeys, withoutPrimaryKeys, withoutUniquesBackingIndex } from './introspection/sqlDefinitions'
import { parseCreateTableSql, type StoredTable } from './introspection/sqliteDefinitionGrammar'
import { sameIdentifier, sameIdentifiers } from './introspection/sqliteTokens'
import { createSQLiteSchemaCompiler } from './schemaCompilerFactory'
import { executeStatements } from './ddlExecution'
import type { DDLStatement } from './ddl'
import type { DatabaseContext } from '../core/DatabaseContext'
import { runInTransactionScope } from '../core/transactionScope'
import type { DatabaseTableStructure } from './introspection'
import type { SQLiteSchemaCompiler } from './SQLiteSchemaCompiler'
import type { AnyColumnDefinition, ForeignKeyReference } from './types'

type SQLiteForeignKeysRow = {
  foreign_keys: number
}

type SQLiteTableRewrite = (
  structure: DatabaseTableStructure,
  table: StoredTable,
) => string[]

type UniqueRewrite = (table: StoredTable) => string[] | undefined

export type ForeignKeyConstraintSuspender = <TResult>(callback: () => Promise<TResult>) => Promise<TResult>

export class SQLiteSchemaOperations {
  private readonly compiler: SQLiteSchemaCompiler

  constructor(
    private readonly connection: DatabaseContext,
    private readonly withoutForeignKeyConstraints: ForeignKeyConstraintSuspender,
  ) {
    this.compiler = createSQLiteSchemaCompiler(connection)
  }

  async addColumn(tableName: string, column: AnyColumnDefinition): Promise<void> {
    await this.rebuildTable(
      tableName,
      (_structure, table) => withAddedColumn(table, this.compiler.compileAddedColumn(tableName, column)),
      this.compiler.compileAddedColumnIndexes(tableName, column),
    )
  }

  async changeColumn(tableName: string, column: AnyColumnDefinition): Promise<void> {
    await this.rebuildTable(tableName, (_structure, table) => {
      const stored = findStoredColumn(table, column.name)
      if (!stored) {
        throw new SchemaError(
          `SQLite cannot change missing column "${column.name}" on table "${tableName}". Add the column without change() first.`,
        )
      }
      if (column.hasDefault && isGeneratedColumn(stored)) {
        throw new SchemaError(`SQLite cannot give column "${column.name}" on table "${tableName}" a default because it is a generated column.`)
      }
      return withChangedColumn(table, stored, this.compiler.compileChangedColumn(tableName, column, readPreservedColumnConstraints(stored, column)))
    })
  }

  async createPrimaryKey(tableName: string, columns: readonly string[], constraintName?: string): Promise<void> {
    await this.rebuildTable(tableName, (structure, table) => {
      if (structure.columns.some(column => column.primaryKey)) {
        throw new SchemaError(`Table "${tableName}" already has a primary key. Drop it with dropPrimary() first.`)
      }

      return [...renderDefinitions(table), this.compiler.compilePrimaryKeyConstraint(columns, constraintName)]
    })
  }

  async dropPrimaryKey(tableName: string): Promise<void> {
    await this.rebuildTable(tableName, (_structure, table) => withoutPrimaryKeys(table))
  }

  async renameIndex(tableName: string, fromIndexName: string, toIndexName: string): Promise<void> {
    const index = (await readTableStructure(this.connection, tableName))?.indexes
      .find(candidate => sameIdentifier(candidate.name, fromIndexName))
    if (!index) {
      throw new SchemaError(`SQLite cannot rename missing index "${fromIndexName}" on table "${tableName}".`)
    }
    if (!index.representable) {
      throw new SchemaError(`SQLite cannot rename index "${fromIndexName}" on table "${tableName}" because it is a partial or expression index.`)
    }

    const createIndexSql = (await readSQLiteTableObjects(this.connection, tableName))
      .find(object => object.type === 'index' && sameIdentifier(object.name, index.name))?.sql
    const statements = createIndexSql === undefined ? undefined : this.compiler.compileRecreateIndex(tableName, index.name, toIndexName, createIndexSql)
    if (!statements) {
      throw new SchemaError(`SQLite cannot rename index "${fromIndexName}" on table "${tableName}" because it backs a constraint declared in the table definition.`)
    }
    await this.connection.transaction(transaction => executeStatements(transaction, statements))
  }

  async addForeignKey(
    tableName: string,
    columnName: string,
    reference: ForeignKeyReference,
    constraintName?: string,
  ): Promise<void> {
    const foreignKey = this.compiler.compileTableForeignKey(tableName, columnName, reference, constraintName)
    await this.rebuildTable(tableName, (structure, table) => {
      if (structure.foreignKeys.some(existing => existing.name === foreignKey.name)) {
        throw new SchemaError(`SQLite cannot add foreign key "${foreignKey.name}" to table "${tableName}" because the table already has a foreign key with that name.`)
      }
      return [...renderDefinitions(table), foreignKey.definition]
    })
  }

  async dropForeignKey(tableName: string, target: { readonly name?: string, readonly columns: readonly string[] }): Promise<void> {
    await this.rebuildTable(tableName, (_structure, table) => {
      const kept = withoutForeignKeys(table, foreignKey => target.name === undefined
        ? foreignKey.name === undefined && sameIdentifiers(foreignKey.columns, target.columns)
        : foreignKey.name === target.name)
      if (!kept) {
        throw new SchemaError(`SQLite cannot drop missing foreign key "${target.name ?? target.columns.join('", "')}" on table "${tableName}".`)
      }
      return kept
    })
  }

  async dropInlineUnique(tableName: string, indexName: string): Promise<boolean> {
    const rewrite = await this.resolveInlineUniqueRewrite(tableName, indexName)
    if (!rewrite) {
      return false
    }

    await this.rebuildTable(tableName, (_structure, table) => {
      const kept = rewrite(table)
      if (!kept) {
        throw new SchemaError(`SQLite cannot drop missing unique "${indexName}" on table "${tableName}".`)
      }
      return kept
    })
    return true
  }

  private async resolveInlineUniqueRewrite(tableName: string, indexName: string): Promise<UniqueRewrite | undefined> {
    const index = (await readTableStructure(this.connection, tableName))?.indexes.find(candidate => sameIdentifier(candidate.name, indexName))
    if (!index?.name.startsWith(SQLITE_AUTOINDEX_PREFIX)) {
      return undefined
    }

    const indexKey = await readSQLiteIndexKey(this.connection, tableName, index.name)
    return table => withoutUniquesBackingIndex(table, indexKey)
  }

  private rebuildTable(tableName: string, rewrite: SQLiteTableRewrite, followUp: readonly DDLStatement[] = []): Promise<void> {
    return runInTransactionScope(this.connection, () => this.rebuildTableWithinAdapterScope(tableName, rewrite, followUp))
  }

  private async rebuildTableWithinAdapterScope(tableName: string, rewrite: SQLiteTableRewrite, followUp: readonly DDLStatement[]): Promise<void> {
    if (!(await this.foreignKeysEnabled())) {
      await this.connection.transaction(transaction => this.copyTable(transaction, tableName, rewrite, followUp))
      return
    }

    if (this.connection.isInTransaction() || currentPinnedConnection(this.connection.getAdapter())) {
      await this.assertTableUnreferenced(tableName)
      await this.connection.transaction(transaction => this.copyTable(transaction, tableName, rewrite, followUp))
      return
    }

    await this.withoutForeignKeyConstraints(() => this.connection.transaction(async (transaction) => {
      await this.copyTable(transaction, tableName, rewrite, followUp)
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

  private async copyTable(connection: DatabaseContext, requestedTableName: string, rewrite: SQLiteTableRewrite, followUp: readonly DDLStatement[]): Promise<void> {
    const tableName = await readSQLiteStoredTableName(connection, requestedTableName)
    const structure = tableName === undefined ? undefined : await readTableStructure(connection, tableName)
    if (tableName === undefined || !structure) {
      throw new SchemaError(`SQLite cannot rebuild table "${requestedTableName}" because it does not exist.`)
    }

    const temporaryTableName = `__holo_rebuild_${tableName.replaceAll('.', '_')}`
    if ((await createSchemaReader(connection).listTables()).some(existing => sameIdentifier(existing, temporaryTableName))) {
      throw new SchemaError(
        `SQLite cannot rebuild table "${tableName}" because temporary table "${temporaryTableName}" already exists.`,
      )
    }

    const storedTable = parseCreateTableSql(await readSQLiteCreateTableSql(connection, tableName) ?? '')
    if (!storedTable) {
      throw new SchemaError(`SQLite cannot read the definition of table "${tableName}" to rebuild it.`)
    }

    const schemaObjects = await readSQLiteTableObjects(connection, tableName)
    const dependentObjects = await readSQLiteDependentObjects(connection, tableName)
    const rebuildStatement = this.compiler.compileRebuildTable(tableName, temporaryTableName, rewrite(structure, storedTable), storedTable.options)
    const rebuiltTable = parseCreateTableSql(rebuildStatement.sql)
    if (!rebuiltTable) {
      throw new SchemaError(`SQLite cannot read the rebuilt definition of table "${tableName}".`)
    }
    const copiedColumns = [
      ...rebuiltTable.columns
        .filter(rebuilt => !isGeneratedColumn(rebuilt) && storedTable.columns.some(stored => sameIdentifier(stored.name, rebuilt.name)))
        .map(rebuilt => rebuilt.name),
      ...this.readHiddenRowIdColumns(tableName, rebuiltTable),
    ]

    await executeStatements(connection, [
      rebuildStatement,
      this.compiler.compileCopyTableRows(tableName, temporaryTableName, copiedColumns),
      ...(hasAutoIncrement(rebuiltTable) ? this.compiler.compileMoveAutoIncrementSequence(tableName, temporaryTableName) : []),
      ...this.compiler.compileDropDependentObjects(dependentObjects),
      ...this.compiler.compile(dropTableOperation(tableName)),
      ...this.compiler.compile(renameTableOperation(temporaryTableName, tableName)),
      ...this.compiler.compileRestoreSchemaObjects([...schemaObjects, ...dependentObjects]),
      ...followUp,
    ])
  }

  private readHiddenRowIdColumns(tableName: string, rebuiltTable: StoredTable): string[] {
    if (!keepsRowIdOnlyAsHiddenColumn(rebuiltTable)) {
      return []
    }

    const rowIdName = findUnshadowedRowIdName(rebuiltTable)
    if (!rowIdName) {
      throw new SchemaError(`SQLite cannot rebuild table "${tableName}" because its columns "rowid", "_rowid_", and "oid" hide the row ids it must keep.`)
    }
    return [rowIdName]
  }
}
