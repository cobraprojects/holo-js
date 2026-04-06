import { column, type AnyColumnBuilder } from './columns'
import { inferConstrainedTableName } from './pluralize'
import type { ForeignKeyReference, TableIndexDefinition } from './types'

interface AddColumnMutationOperation {
  kind: 'addColumn'
  columnName: string
  column: AnyColumnBuilder
}

interface AlterColumnMutationOperation {
  kind: 'alterColumn'
  columnName: string
  column: AnyColumnBuilder
}

interface DropColumnMutationOperation {
  kind: 'dropColumn'
  columnName: string
}

interface RenameColumnMutationOperation {
  kind: 'renameColumn'
  fromColumnName: string
  toColumnName: string
}

interface CreateIndexMutationOperation {
  kind: 'createIndex'
  index: TableIndexDefinition
}

interface DropIndexMutationOperation {
  kind: 'dropIndex'
  indexName: string
}

interface RenameIndexMutationOperation {
  kind: 'renameIndex'
  fromIndexName: string
  toIndexName: string
}

interface CreateForeignKeyMutationOperation {
  kind: 'createForeignKey'
  columnName: string
  reference: ForeignKeyReference
  constraintName?: string
}

interface DropForeignKeyMutationOperation {
  kind: 'dropForeignKey'
  constraintName: string
}

interface MutableColumnMutationOperation {
  kind: ColumnMutationMode
  columnName: string
  column: AnyColumnBuilder
}

type TableMutationOperation
  = AddColumnMutationOperation
    | AlterColumnMutationOperation
    | DropColumnMutationOperation
    | RenameColumnMutationOperation
    | CreateIndexMutationOperation
    | DropIndexMutationOperation
    | RenameIndexMutationOperation
    | CreateForeignKeyMutationOperation
    | DropForeignKeyMutationOperation

type ColumnMutationMode = 'addColumn' | 'alterColumn'
type ColumnFactory<TBuilder extends AnyColumnBuilder = AnyColumnBuilder> = () => TBuilder

class TableForeignKeyBuilder {
  constructor(
    private readonly operation: CreateForeignKeyMutationOperation,
  ) {}

  references(columnName: string): this {
    this.operation.reference = {
      ...this.operation.reference,
      column: columnName,
    }
    return this
  }

  on(table: string): this {
    this.operation.reference = {
      ...this.operation.reference,
      table,
    }
    return this
  }

  constrained(table?: string, columnName = 'id'): this {
    return this
      .on(table ?? inferConstrainedTableName(this.operation.columnName))
      .references(columnName)
  }

  onDelete(action: NonNullable<ForeignKeyReference['onDelete']>): this {
    this.operation.reference = {
      ...this.operation.reference,
      onDelete: action,
    }
    return this
  }

  onUpdate(action: NonNullable<ForeignKeyReference['onUpdate']>): this {
    this.operation.reference = {
      ...this.operation.reference,
      onUpdate: action,
    }
    return this
  }

  cascadeOnDelete(): this {
    return this.onDelete('cascade')
  }

  restrictOnDelete(): this {
    return this.onDelete('restrict')
  }

  nullOnDelete(): this {
    return this.onDelete('set null')
  }

  noActionOnDelete(): this {
    return this.onDelete('no action')
  }

  cascadeOnUpdate(): this {
    return this.onUpdate('cascade')
  }

  restrictOnUpdate(): this {
    return this.onUpdate('restrict')
  }

  nullOnUpdate(): this {
    return this.onUpdate('set null')
  }

  noActionOnUpdate(): this {
    return this.onUpdate('no action')
  }
}

class TableColumnMutationBuilder {
  constructor(
    protected readonly root: TableMutationBuilder,
    protected readonly operation: MutableColumnMutationOperation,
  ) {}

  notNull(): this {
    this.operation.column = this.operation.column.notNull()
    return this
  }

  nullable(): this {
    this.operation.column = this.operation.column.nullable()
    return this
  }

  default(value: unknown): this {
    this.operation.column = this.operation.column.default(value)
    return this
  }

  defaultNow(): this {
    this.operation.column = this.operation.column.defaultNow()
    return this
  }

  generated(): this {
    this.operation.column = this.operation.column.generated()
    return this
  }

  primaryKey(): this {
    this.operation.column = this.operation.column.primaryKey()
    return this
  }

  unique(): this {
    this.operation.column = this.operation.column.unique()
    return this
  }

  foreignId(columnName: string): TableForeignIdMutationBuilder {
    return this.root.foreignId(columnName)
  }

  foreignUuid(columnName: string): TableForeignIdMutationBuilder {
    return this.root.foreignUuid(columnName)
  }

  foreignUlid(columnName: string): TableForeignIdMutationBuilder {
    return this.root.foreignUlid(columnName)
  }

  foreignSnowflake(columnName: string): TableForeignIdMutationBuilder {
    return this.root.foreignSnowflake(columnName)
  }

  change(): this {
    this.operation.kind = 'alterColumn'
    return this
  }

  morphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.morphs(name, indexName)
  }

  nullableMorphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.nullableMorphs(name, indexName)
  }

  uuidMorphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.uuidMorphs(name, indexName)
  }

  nullableUuidMorphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.nullableUuidMorphs(name, indexName)
  }

  ulidMorphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.ulidMorphs(name, indexName)
  }

  nullableUlidMorphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.nullableUlidMorphs(name, indexName)
  }

  snowflakeMorphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.snowflakeMorphs(name, indexName)
  }

  nullableSnowflakeMorphs(name: string, indexName?: string): TableMutationBuilder {
    return this.root.nullableSnowflakeMorphs(name, indexName)
  }
}

class TableForeignIdMutationBuilder extends TableColumnMutationBuilder {
  private foreignOperation?: CreateForeignKeyMutationOperation
  private referenceTable?: string
  private referenceColumn = 'id'
  private onDeleteAction?: ForeignKeyReference['onDelete']
  private onUpdateAction?: ForeignKeyReference['onUpdate']

  constructor(
    root: TableMutationBuilder,
    operation: MutableColumnMutationOperation,
    private readonly operations: TableMutationOperation[],
    private readonly columnName: string,
  ) {
    super(root, operation)
  }

  references(
    columnName: string,
  ): this {
    this.referenceColumn = columnName
    return this.applyForeignKey()
  }

  on(table: string): this {
    this.referenceTable = table
    return this.applyForeignKey()
  }

  constrained(table?: string, columnName = 'id'): this {
    this.referenceTable = table ?? inferConstrainedTableName(this.columnName)
    this.referenceColumn = columnName
    return this.applyForeignKey()
  }

  onDelete(action: NonNullable<ForeignKeyReference['onDelete']>): this {
    this.onDeleteAction = action
    return this.applyForeignKey()
  }

  onUpdate(action: NonNullable<ForeignKeyReference['onUpdate']>): this {
    this.onUpdateAction = action
    return this.applyForeignKey()
  }

  cascadeOnDelete(): this {
    return this.onDelete('cascade')
  }

  restrictOnDelete(): this {
    return this.onDelete('restrict')
  }

  nullOnDelete(): this {
    return this.onDelete('set null')
  }

  noActionOnDelete(): this {
    return this.onDelete('no action')
  }

  cascadeOnUpdate(): this {
    return this.onUpdate('cascade')
  }

  restrictOnUpdate(): this {
    return this.onUpdate('restrict')
  }

  nullOnUpdate(): this {
    return this.onUpdate('set null')
  }

  noActionOnUpdate(): this {
    return this.onUpdate('no action')
  }

  private applyForeignKey(): this {
    const operation = this.ensureForeignOperation()
    operation.reference = {
      table: this.referenceTable ?? '',
      column: this.referenceColumn,
      onDelete: this.onDeleteAction,
      onUpdate: this.onUpdateAction,
    }
    return this
  }

  private ensureForeignOperation(): CreateForeignKeyMutationOperation {
    if (!this.foreignOperation) {
      this.foreignOperation = {
        kind: 'createForeignKey',
        columnName: this.columnName,
        reference: {
          table: this.referenceTable ?? '',
          column: this.referenceColumn,
          onDelete: this.onDeleteAction,
          onUpdate: this.onUpdateAction,
        },
      }
      this.operations.push(this.foreignOperation)
    }

    return this.foreignOperation
  }
}

export class TableMutationBuilder {
  private readonly operations: Array<TableMutationOperation | MutableColumnMutationOperation> = []

  constructor(readonly table: string) {}

  getOperations(): readonly TableMutationOperation[] {
    return [...this.operations]
  }

  id(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.id())
  }

  autoIncrementId(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.autoIncrementId())
  }

  integer(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.integer())
  }

  bigInteger(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.bigInteger())
  }

  foreignId(columnName: string): TableForeignIdMutationBuilder {
    return this.foreignColumn(columnName, () => column.bigInteger())
  }

  foreignUuid(columnName: string): TableForeignIdMutationBuilder {
    return this.foreignColumn(columnName, () => column.uuid())
  }

  foreignUlid(columnName: string): TableForeignIdMutationBuilder {
    return this.foreignColumn(columnName, () => column.ulid())
  }

  foreignSnowflake(columnName: string): TableForeignIdMutationBuilder {
    return this.foreignColumn(columnName, () => column.snowflake())
  }

  string(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.string())
  }

  text(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.text())
  }

  boolean(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.boolean())
  }

  real(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.real())
  }

  decimal(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.decimal())
  }

  date(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.date())
  }

  datetime(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.datetime())
  }

  timestamp(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.timestamp())
  }

  json<TValue = unknown>(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.json<TValue>())
  }

  blob(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.blob())
  }

  uuid(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.uuid())
  }

  ulid(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.ulid())
  }

  snowflake(columnName: string): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.snowflake())
  }

  vector(
    columnName: string,
    options: { dimensions: number },
  ): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.vector(options))
  }

  enum<const TValues extends readonly string[]>(
    columnName: string,
    values: TValues,
  ): TableColumnMutationBuilder {
    return this.columnMutation(columnName, () => column.enum(values))
  }

  dropColumn(columnName: string): void {
    this.operations.push({ kind: 'dropColumn', columnName })
  }

  renameColumn(fromColumnName: string, toColumnName: string): void {
    this.operations.push({ kind: 'renameColumn', fromColumnName, toColumnName })
  }

  index(columns: readonly string[], name?: string): void {
    this.operations.push({
      kind: 'createIndex',
      index: { columns, name, unique: false },
    })
  }

  unique(columns: readonly string[], name?: string): void {
    this.operations.push({
      kind: 'createIndex',
      index: { columns, name, unique: true },
    })
  }

  dropIndex(indexName: string): void {
    this.operations.push({ kind: 'dropIndex', indexName })
  }

  renameIndex(fromIndexName: string, toIndexName: string): void {
    this.operations.push({ kind: 'renameIndex', fromIndexName, toIndexName })
  }

  foreign(columnName: string, constraintName?: string): TableForeignKeyBuilder {
    const operation: CreateForeignKeyMutationOperation = {
      kind: 'createForeignKey',
      columnName,
      reference: { table: '', column: '' },
      constraintName,
    }

    this.operations.push(operation)
    return new TableForeignKeyBuilder(operation)
  }

  dropForeign(indexName: string): void {
    this.operations.push({ kind: 'dropForeignKey', constraintName: indexName })
  }

  morphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.bigInteger(), false, indexName)
  }

  nullableMorphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.bigInteger(), true, indexName)
  }

  uuidMorphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.uuid(), false, indexName)
  }

  nullableUuidMorphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.uuid(), true, indexName)
  }

  ulidMorphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.ulid(), false, indexName)
  }

  nullableUlidMorphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.ulid(), true, indexName)
  }

  snowflakeMorphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.snowflake(), false, indexName)
  }

  nullableSnowflakeMorphs(name: string, indexName?: string): this {
    return this.applyMorphColumns(name, () => column.snowflake(), true, indexName)
  }

  private columnMutation<TBuilder extends AnyColumnBuilder>(
    columnName: string,
    createBuilder: ColumnFactory<TBuilder>,
  ): TableColumnMutationBuilder {
    const operation: MutableColumnMutationOperation = {
      kind: 'addColumn',
      columnName,
      column: createBuilder(),
    }

    this.operations.push(operation)

    return new TableColumnMutationBuilder(this, operation)
  }

  private foreignColumn<TBuilder extends AnyColumnBuilder>(
    columnName: string,
    createBuilder: ColumnFactory<TBuilder>,
  ): TableForeignIdMutationBuilder {
    const operation: MutableColumnMutationOperation = {
      kind: 'addColumn',
      columnName,
      column: createBuilder(),
    }

    this.operations.push(operation)

    return new TableForeignIdMutationBuilder(this, operation, this.operations as TableMutationOperation[], columnName)
  }

  private applyMorphColumns<TBuilder extends AnyColumnBuilder>(
    name: string,
    createIdBuilder: ColumnFactory<TBuilder>,
    nullable: boolean,
    indexName?: string,
  ): this {
    const typeColumn = `${name}_type`
    const idColumn = `${name}_id`

    this.columnMutation(typeColumn, () => nullable ? column.string().nullable() : column.string())
    this.columnMutation(idColumn, () => nullable ? createIdBuilder().nullable() : createIdBuilder())
    this.index([typeColumn, idColumn], indexName)

    return this
  }
}
