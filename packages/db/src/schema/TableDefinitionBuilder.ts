import { SchemaError } from '../core/errors'
import { column, type AnyColumnBuilder, type ColumnInput } from './columns'
import { defineTable, type BoundTableDefinition, type DefineTableOptions } from './defineTable'
import { inferConstrainedTableName } from './pluralize'
import type { ForeignKeyReference, TableIndexDefinition } from './types'

type ColumnShapeInput = Record<string, ColumnInput>

type WithColumn<
  TColumns extends ColumnShapeInput,
  TColumnName extends string,
  TColumn extends ColumnInput,
> = TColumns & { [K in TColumnName]: TColumn }

type TimestampColumn = ReturnType<typeof column.timestamp>
type NullableTimestampColumn = ReturnType<ReturnType<typeof column.timestamp>['nullable']>
type StringColumn = ReturnType<typeof column.string>
type NullableStringColumn = ReturnType<ReturnType<typeof column.string>['nullable']>

type WithTimestamps<TColumns extends ColumnShapeInput> = TColumns & {
  created_at: TimestampColumn
  updated_at: TimestampColumn
}

type WithSoftDeletes<
  TColumns extends ColumnShapeInput,
  TColumnName extends string,
> = TColumns & { [K in TColumnName]: NullableTimestampColumn }

type WithMorphColumns<
  TColumns extends ColumnShapeInput,
  TMorphName extends string,
  TIdColumn extends AnyColumnBuilder,
> = TColumns
  & { [K in `${TMorphName}_type`]: StringColumn }
  & { [K in `${TMorphName}_id`]: TIdColumn }

type WithNullableMorphColumns<
  TColumns extends ColumnShapeInput,
  TMorphName extends string,
  TIdColumn extends AnyColumnBuilder,
> = TColumns
  & { [K in `${TMorphName}_type`]: NullableStringColumn }
  & { [K in `${TMorphName}_id`]: ReturnType<TIdColumn['nullable']> }

type ColumnReference = {
  builder: AnyColumnBuilder
}

class TableCreateColumnBuilder<
  TName extends string,
  TColumns extends ColumnShapeInput,
> {
  constructor(
    protected readonly root: TableDefinitionBuilder<TName, TColumns>,
    protected readonly builderRef: ColumnReference,
  ) {}

  build(): BoundTableDefinition<TName, TColumns> {
    return this.root.build()
  }

  notNull(): this {
    this.builderRef.builder = this.builderRef.builder.notNull()
    return this
  }

  nullable(): this {
    this.builderRef.builder = this.builderRef.builder.nullable()
    return this
  }

  default(value: unknown): this {
    this.builderRef.builder = this.builderRef.builder.default(value)
    return this
  }

  defaultNow(): this {
    this.builderRef.builder = this.builderRef.builder.defaultNow()
    return this
  }

  generated(): this {
    this.builderRef.builder = this.builderRef.builder.generated()
    return this
  }

  primaryKey(): this {
    this.builderRef.builder = this.builderRef.builder.primaryKey()
    return this
  }

  unique(): this
  unique(columns: readonly string[], name?: string): TableDefinitionBuilder<TName, TColumns>
  unique(columns?: readonly string[], name?: string): this | TableDefinitionBuilder<TName, TColumns> {
    if (columns) {
      return this.root.unique(columns, name)
    }

    this.builderRef.builder = this.builderRef.builder.unique()
    return this
  }

  foreign(columnName: string): TableCreateForeignKeyBuilder<TName, TColumns> {
    return this.root.foreign(columnName)
  }

  foreignId<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.bigInteger>>
  > {
    return this.root.foreignId(columnName)
  }

  foreignUuid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.uuid>>
  > {
    return this.root.foreignUuid(columnName)
  }

  foreignUlid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.ulid>>
  > {
    return this.root.foreignUlid(columnName)
  }

  foreignSnowflake<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.snowflake>>
  > {
    return this.root.foreignSnowflake(columnName)
  }

  id<TColumnName extends string = 'id'>(
    columnName?: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.id>>
  > {
    return this.root.id(columnName)
  }

  autoIncrementId<TColumnName extends string = 'id'>(
    columnName?: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.autoIncrementId>>
  > {
    return this.root.autoIncrementId(columnName)
  }

  integer<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.integer>>
  > {
    return this.root.integer(columnName)
  }

  bigInteger<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.bigInteger>>
  > {
    return this.root.bigInteger(columnName)
  }

  string<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.string>>
  > {
    return this.root.string(columnName)
  }

  text<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.text>>
  > {
    return this.root.text(columnName)
  }

  boolean<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.boolean>>
  > {
    return this.root.boolean(columnName)
  }

  real<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.real>>
  > {
    return this.root.real(columnName)
  }

  decimal<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.decimal>>
  > {
    return this.root.decimal(columnName)
  }

  date<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.date>>
  > {
    return this.root.date(columnName)
  }

  datetime<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.datetime>>
  > {
    return this.root.datetime(columnName)
  }

  timestamp<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.timestamp>>
  > {
    return this.root.timestamp(columnName)
  }

  json<TColumnName extends string, TValue = unknown>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.json<TValue>>>
  > {
    return this.root.json<TColumnName, TValue>(columnName)
  }

  blob<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.blob>>
  > {
    return this.root.blob(columnName)
  }

  uuid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.uuid>>
  > {
    return this.root.uuid(columnName)
  }

  ulid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.ulid>>
  > {
    return this.root.ulid(columnName)
  }

  snowflake<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.snowflake>>
  > {
    return this.root.snowflake(columnName)
  }

  vector<TColumnName extends string>(
    columnName: TColumnName,
    options: { dimensions: number },
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.vector>>
  > {
    return this.root.vector(columnName, options)
  }

  enum<const TValues extends readonly string[], TColumnName extends string>(
    columnName: TColumnName,
    values: TValues,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.enum<TValues>>>
  > {
    return this.root.enum(columnName, values)
  }

  index(columns: readonly string[], name?: string): TableDefinitionBuilder<TName, TColumns> {
    return this.root.index(columns, name)
  }

  timestamps(): TableDefinitionBuilder<TName, WithTimestamps<TColumns>> {
    return this.root.timestamps()
  }

  softDeletes<TColumnName extends string = 'deleted_at'>(
    columnName?: TColumnName,
  ): TableDefinitionBuilder<TName, WithSoftDeletes<TColumns, TColumnName>> {
    return this.root.softDeletes(columnName)
  }

  morphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.bigInteger>>> {
    return this.root.morphs(name, indexName)
  }

  nullableMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.bigInteger>>> {
    return this.root.nullableMorphs(name, indexName)
  }

  uuidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.uuid>>> {
    return this.root.uuidMorphs(name, indexName)
  }

  nullableUuidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.uuid>>> {
    return this.root.nullableUuidMorphs(name, indexName)
  }

  ulidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.ulid>>> {
    return this.root.ulidMorphs(name, indexName)
  }

  nullableUlidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.ulid>>> {
    return this.root.nullableUlidMorphs(name, indexName)
  }

  snowflakeMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.snowflake>>> {
    return this.root.snowflakeMorphs(name, indexName)
  }

  nullableSnowflakeMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.snowflake>>> {
    return this.root.nullableSnowflakeMorphs(name, indexName)
  }
}

class TableCreateForeignIdBuilder<
  TName extends string,
  TColumns extends ColumnShapeInput,
> extends TableCreateColumnBuilder<TName, TColumns> {
  private referenceTable?: string
  private referenceColumn = 'id'
  private onDeleteAction?: ForeignKeyReference['onDelete']
  private onUpdateAction?: ForeignKeyReference['onUpdate']

  constructor(
    root: TableDefinitionBuilder<TName, TColumns>,
    builderRef: ColumnReference,
    private readonly columnName: string,
  ) {
    super(root, builderRef)
  }

  references(
    columnName: string,
  ): this {
    this.referenceColumn = columnName
    return this.applyReference()
  }

  on(table: string): this {
    this.referenceTable = table
    return this.applyReference()
  }

  constrained(table?: string, columnName = 'id'): this {
    this.referenceTable = table ?? inferConstrainedTableName(this.columnName)
    this.referenceColumn = columnName
    return this.applyReference()
  }

  onDelete(action: NonNullable<ForeignKeyReference['onDelete']>): this {
    this.onDeleteAction = action
    return this.applyReference()
  }

  onUpdate(action: NonNullable<ForeignKeyReference['onUpdate']>): this {
    this.onUpdateAction = action
    return this.applyReference()
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

  private applyReference(): this {
    let builder = this.builderRef.builder.references(this.referenceColumn)
    if (this.referenceTable) {
      builder = builder.on(this.referenceTable)
    }
    if (this.onDeleteAction) {
      builder = builder.onDelete(this.onDeleteAction)
    }
    if (this.onUpdateAction) {
      builder = builder.onUpdate(this.onUpdateAction)
    }
    this.builderRef.builder = builder
    return this
  }
}

class TableCreateForeignKeyBuilder<
  TName extends string,
  TColumns extends ColumnShapeInput,
> {
  private referenceTable?: string
  private referenceColumn = 'id'
  private onDeleteAction?: ForeignKeyReference['onDelete']
  private onUpdateAction?: ForeignKeyReference['onUpdate']

  constructor(
    private readonly root: TableDefinitionBuilder<TName, TColumns>,
    private readonly builderRef: ColumnReference,
    private readonly columnName: string,
  ) {}

  references(columnName: string): this {
    this.referenceColumn = columnName
    return this.applyReference()
  }

  on(table: string): this {
    this.referenceTable = table
    return this.applyReference()
  }

  constrained(table?: string, columnName = 'id'): this {
    this.referenceTable = table ?? inferConstrainedTableName(this.columnName)
    this.referenceColumn = columnName
    return this.applyReference()
  }

  onDelete(action: NonNullable<ForeignKeyReference['onDelete']>): this {
    this.onDeleteAction = action
    return this.applyReference()
  }

  onUpdate(action: NonNullable<ForeignKeyReference['onUpdate']>): this {
    this.onUpdateAction = action
    return this.applyReference()
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

  build(): BoundTableDefinition<TName, TColumns> {
    return this.root.build()
  }

  private applyReference(): this {
    let builder = this.builderRef.builder.references(this.referenceColumn)
    if (this.referenceTable) {
      builder = builder.on(this.referenceTable)
    }
    if (this.onDeleteAction) {
      builder = builder.onDelete(this.onDeleteAction)
    }
    if (this.onUpdateAction) {
      builder = builder.onUpdate(this.onUpdateAction)
    }
    this.builderRef.builder = builder
    return this
  }
}

export class TableDefinitionBuilder<
  TName extends string,
  TColumns extends ColumnShapeInput = Record<never, never>,
> {
  private readonly columns: Record<string, ColumnInput> = {}
  private readonly columnRefs = new Map<string, ColumnReference>()
  private readonly indexes: TableIndexDefinition[] = []

  constructor(readonly tableName: TName) {}

  build(): BoundTableDefinition<TName, TColumns> {
    const options: DefineTableOptions = {
      indexes: Object.freeze([...this.indexes]),
    }

    return defineTable(this.tableName, this.columns as TColumns, options) as BoundTableDefinition<TName, TColumns>
  }

  id<TColumnName extends string = 'id'>(
    columnName = 'id' as TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.id>>
  > {
    return this.column(columnName, column.id())
  }

  autoIncrementId<TColumnName extends string = 'id'>(
    columnName = 'id' as TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.autoIncrementId>>
  > {
    return this.column(columnName, column.autoIncrementId())
  }

  integer<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.integer>>
  > {
    return this.column(columnName, column.integer())
  }

  bigInteger<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.bigInteger>>
  > {
    return this.column(columnName, column.bigInteger())
  }

  foreignId<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.bigInteger>>
  > {
    return this.foreignColumn(columnName, column.bigInteger())
  }

  foreignUuid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.uuid>>
  > {
    return this.foreignColumn(columnName, column.uuid())
  }

  foreignUlid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.ulid>>
  > {
    return this.foreignColumn(columnName, column.ulid())
  }

  foreignSnowflake<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateForeignIdBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.snowflake>>
  > {
    return this.foreignColumn(columnName, column.snowflake())
  }

  string<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.string>>
  > {
    return this.column(columnName, column.string())
  }

  text<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.text>>
  > {
    return this.column(columnName, column.text())
  }

  boolean<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.boolean>>
  > {
    return this.column(columnName, column.boolean())
  }

  real<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.real>>
  > {
    return this.column(columnName, column.real())
  }

  decimal<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.decimal>>
  > {
    return this.column(columnName, column.decimal())
  }

  date<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.date>>
  > {
    return this.column(columnName, column.date())
  }

  datetime<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.datetime>>
  > {
    return this.column(columnName, column.datetime())
  }

  timestamp<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.timestamp>>
  > {
    return this.column(columnName, column.timestamp())
  }

  json<TColumnName extends string, TValue = unknown>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.json<TValue>>>
  > {
    return this.column(columnName, column.json<TValue>())
  }

  blob<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.blob>>
  > {
    return this.column(columnName, column.blob())
  }

  uuid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.uuid>>
  > {
    return this.column(columnName, column.uuid())
  }

  ulid<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.ulid>>
  > {
    return this.column(columnName, column.ulid())
  }

  snowflake<TColumnName extends string>(
    columnName: TColumnName,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.snowflake>>
  > {
    return this.column(columnName, column.snowflake())
  }

  vector<TColumnName extends string>(
    columnName: TColumnName,
    options: { dimensions: number },
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.vector>>
  > {
    return this.column(columnName, column.vector(options))
  }

  enum<const TValues extends readonly string[], TColumnName extends string>(
    columnName: TColumnName,
    values: TValues,
  ): TableCreateColumnBuilder<
    TName,
    WithColumn<TColumns, TColumnName, ReturnType<typeof column.enum<TValues>>>
  > {
    return this.column(columnName, column.enum(values))
  }

  index(columns: readonly string[], name?: string): this {
    this.indexes.push({ columns, name, unique: false })
    return this
  }

  unique(columns: readonly string[], name?: string): this {
    this.indexes.push({ columns, name, unique: true })
    return this
  }

  foreign(columnName: string): TableCreateForeignKeyBuilder<TName, TColumns> {
    const builderRef = this.columnRefs.get(columnName)
    if (!builderRef) {
      throw new SchemaError(`Cannot attach a foreign key to unknown column "${columnName}". Declare the column first.`)
    }

    return new TableCreateForeignKeyBuilder(this, builderRef, columnName)
  }

  timestamps(): TableDefinitionBuilder<TName, WithTimestamps<TColumns>> {
    this.timestamp('created_at').defaultNow()
    this.timestamp('updated_at').defaultNow()
    return this as unknown as TableDefinitionBuilder<TName, WithTimestamps<TColumns>>
  }

  softDeletes<TColumnName extends string = 'deleted_at'>(
    columnName = 'deleted_at' as TColumnName,
  ): TableDefinitionBuilder<TName, WithSoftDeletes<TColumns, TColumnName>> {
    this.timestamp(columnName).nullable()
    return this as unknown as TableDefinitionBuilder<TName, WithSoftDeletes<TColumns, TColumnName>>
  }

  morphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.bigInteger>>> {
    return this.applyMorphColumns(name, () => column.bigInteger(), false, indexName)
  }

  nullableMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.bigInteger>>> {
    return this.applyMorphColumns(name, () => column.bigInteger(), true, indexName)
  }

  uuidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.uuid>>> {
    return this.applyMorphColumns(name, () => column.uuid(), false, indexName)
  }

  nullableUuidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.uuid>>> {
    return this.applyMorphColumns(name, () => column.uuid(), true, indexName)
  }

  ulidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.ulid>>> {
    return this.applyMorphColumns(name, () => column.ulid(), false, indexName)
  }

  nullableUlidMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.ulid>>> {
    return this.applyMorphColumns(name, () => column.ulid(), true, indexName)
  }

  snowflakeMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithMorphColumns<TColumns, TMorphName, ReturnType<typeof column.snowflake>>> {
    return this.applyMorphColumns(name, () => column.snowflake(), false, indexName)
  }

  nullableSnowflakeMorphs<TMorphName extends string>(
    name: TMorphName,
    indexName?: string,
  ): TableDefinitionBuilder<TName, WithNullableMorphColumns<TColumns, TMorphName, ReturnType<typeof column.snowflake>>> {
    return this.applyMorphColumns(name, () => column.snowflake(), true, indexName)
  }

  private column<
    TColumnName extends string,
    TColumn extends AnyColumnBuilder,
  >(
    columnName: TColumnName,
    initialBuilder: TColumn,
  ): TableCreateColumnBuilder<TName, WithColumn<TColumns, TColumnName, TColumn>> {
    const builderRef: ColumnReference = { builder: initialBuilder }
    this.columnRefs.set(columnName, builderRef)
    this.columns[columnName] = {
      toDefinition: ({ name }: { name: string }) => builderRef.builder.toDefinition({ name }),
    } as TColumn

    return new TableCreateColumnBuilder(
      this as unknown as TableDefinitionBuilder<TName, WithColumn<TColumns, TColumnName, TColumn>>,
      builderRef,
    )
  }

  private foreignColumn<
    TColumnName extends string,
    TColumn extends AnyColumnBuilder,
  >(
    columnName: TColumnName,
    initialBuilder: TColumn,
  ): TableCreateForeignIdBuilder<TName, WithColumn<TColumns, TColumnName, TColumn>> {
    const builderRef: ColumnReference = { builder: initialBuilder }
    this.columnRefs.set(columnName, builderRef)
    this.columns[columnName] = {
      toDefinition: ({ name }: { name: string }) => builderRef.builder.toDefinition({ name }),
    } as TColumn

    return new TableCreateForeignIdBuilder(
      this as unknown as TableDefinitionBuilder<TName, WithColumn<TColumns, TColumnName, TColumn>>,
      builderRef,
      columnName,
    )
  }

  private applyMorphColumns<
    TMorphName extends string,
    TIdColumn extends AnyColumnBuilder,
    TResult extends TableDefinitionBuilder<TName, ColumnShapeInput>,
  >(
    name: TMorphName,
    createIdBuilder: () => TIdColumn,
    nullable: boolean,
    indexName?: string,
  ): TResult {
    const typeColumn = `${name}_type`
    const idColumn = `${name}_id`
    const typeBuilder = nullable ? column.string().nullable() : column.string()
    const idBuilder = nullable ? createIdBuilder().nullable() : createIdBuilder()

    this.column(typeColumn, typeBuilder)
    this.column(idColumn, idBuilder)
    this.index([typeColumn, idColumn], indexName)

    return this as unknown as TResult
  }
}
