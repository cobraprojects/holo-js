import { randomUUID } from 'node:crypto'
import { resolveGeneratedCheckName } from './generatedNames'
import { splitTablePath } from './identifiers'
import { createPostgresSchemaCompiler } from './schemaCompilerFactory'
import { executeStatements } from './ddlExecution'
import { readTableStructure } from './introspection'
import type { DatabaseContext } from '../core/DatabaseContext'
import type { DDLStatement } from './ddl'
import type { DatabaseEnumCheckStructure } from './introspection'
import type { PostgresSchemaCompiler } from './PostgresSchemaCompiler'

type CheckConstraintRename = {
  readonly from: string
  readonly to: string
}

async function readEnumChecks(connection: DatabaseContext, tableName: string): Promise<readonly DatabaseEnumCheckStructure[]> {
  return (await readTableStructure(connection, tableName))?.enumChecks ?? []
}

function namedChecks(checks: readonly DatabaseEnumCheckStructure[]): string[] {
  return checks.flatMap(check => check.name ? [check.name] : [])
}

function conventionalCheckRenames(
  checks: readonly DatabaseEnumCheckStructure[],
  tableName: string,
  resolveTargetName: (column: string) => string,
): CheckConstraintRename[] {
  return checks.flatMap(check => check.name === resolveGeneratedCheckName(tableName, check.column)
    ? [{ from: check.name, to: resolveTargetName(check.column) }]
    : [])
}

function resolveRenamedTablePath(fromTableName: string, toTableName: string): string {
  const { schema } = splitTablePath(fromTableName)
  return toTableName.includes('.') || schema === undefined ? toTableName : `${schema}.${toTableName}`
}

export class PostgresEnumChecks {
  private readonly compiler: PostgresSchemaCompiler

  constructor(private readonly connection: DatabaseContext) {
    this.compiler = createPostgresSchemaCompiler(connection)
  }

  async renameTable(fromTableName: string, toTableName: string, statements: readonly DDLStatement[]): Promise<void> {
    const destinationTableName = resolveRenamedTablePath(fromTableName, toTableName)
    const checks = await readEnumChecks(this.connection, fromTableName)
    await this.renameWithChecks(statements, destinationTableName, conventionalCheckRenames(checks, fromTableName, column => resolveGeneratedCheckName(destinationTableName, column)))
  }

  async renameColumn(tableName: string, fromColumnName: string, toColumnName: string, statements: readonly DDLStatement[]): Promise<void> {
    const checks = (await readEnumChecks(this.connection, tableName)).filter(check => check.column === fromColumnName)
    await this.renameWithChecks(statements, tableName, conventionalCheckRenames(checks, tableName, () => resolveGeneratedCheckName(tableName, toColumnName)))
  }

  async alterColumn(tableName: string, columnName: string, statements: readonly DDLStatement[]): Promise<void> {
    const checkNames = namedChecks((await readEnumChecks(this.connection, tableName)).filter(check => check.column === columnName))
    await this.connection.transaction(async (transaction) => {
      await executeStatements(transaction, checkNames.map(checkName => this.compiler.compileDropCheck(tableName, checkName)))
      await executeStatements(transaction, statements)
    })
  }

  private async renameWithChecks(
    statements: readonly DDLStatement[],
    tableName: string,
    checkRenames: readonly CheckConstraintRename[],
  ): Promise<void> {
    if (checkRenames.length === 0) {
      await executeStatements(this.connection, statements)
      return
    }

    await this.connection.transaction(async (transaction) => {
      await executeStatements(transaction, statements)
      await this.renameChecks(transaction, tableName, checkRenames)
    })
  }

  private async renameChecks(
    connection: DatabaseContext,
    tableName: string,
    checkRenames: readonly CheckConstraintRename[],
  ): Promise<void> {
    const pendingRenames = checkRenames
      .filter(({ from, to }) => from !== to)
      .map(rename => ({ ...rename, temporary: `__holo_check_rename_${randomUUID().replaceAll('-', '')}` }))

    await executeStatements(connection, [
      ...pendingRenames.map(({ from, temporary }) => this.compiler.compileRenameCheck(tableName, from, temporary)),
      ...pendingRenames.map(({ to, temporary }) => this.compiler.compileRenameCheck(tableName, temporary, to)),
    ])
  }
}
