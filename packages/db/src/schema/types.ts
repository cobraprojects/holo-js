/* v8 ignore file -- type declarations only */
export type LogicalColumnKind
  = | 'id'
    | 'integer'
    | 'bigInteger'
    | 'string'
    | 'text'
    | 'boolean'
    | 'real'
    | 'decimal'
    | 'date'
    | 'datetime'
    | 'timestamp'
    | 'json'
    | 'blob'
    | 'uuid'
    | 'ulid'
    | 'snowflake'
    | 'vector'
    | 'enum'

export type ColumnDefaultKind = 'value' | 'now'
export type IdGenerationStrategy = 'autoIncrement' | 'uuid' | 'ulid' | 'snowflake'
export type VectorValue = readonly number[]

export interface ForeignKeyReference {
  table: string
  column: string
  constraintName?: string
  onDelete?: string
  onUpdate?: string
}

export interface ColumnDefinition<
  _TType = unknown,
  TNullable extends boolean = false,
  THasDefault extends boolean = false,
  TGenerated extends boolean = false,
> {
  readonly kind: LogicalColumnKind
  readonly name: string
  readonly nullable: TNullable
  readonly hasDefault: THasDefault
  readonly generated: TGenerated
  readonly primaryKey: boolean
  readonly unique: boolean
  readonly defaultKind?: ColumnDefaultKind
  readonly defaultValue?: unknown
  readonly references?: ForeignKeyReference
  readonly idStrategy?: IdGenerationStrategy
  readonly enumValues?: readonly string[]
  readonly vectorDimensions?: number
}

export type AnyColumnDefinition = ColumnDefinition<unknown, boolean, boolean, boolean>
export type TableColumnsShape = Record<string, AnyColumnDefinition>

export interface TableDefinition<
  TName extends string = string,
  TColumns extends TableColumnsShape = TableColumnsShape,
> {
  readonly kind: 'table'
  readonly tableName: TName
  readonly columns: TColumns
  readonly indexes: readonly TableIndexDefinition[]
}

export interface TableIndexDefinition {
  readonly name?: string
  readonly columns: readonly string[]
  readonly unique: boolean
}

export type ColumnSelectType<TColumn extends AnyColumnDefinition>
  = TColumn extends ColumnDefinition<infer TValue, infer TNullable, boolean, boolean>
    ? TNullable extends true ? TValue | null : TValue
    : never

export type ColumnInsertType<TColumn extends AnyColumnDefinition>
  = TColumn extends ColumnDefinition<infer TValue, infer TNullable, boolean, boolean>
    ? TNullable extends true ? TValue | null : TValue
    : never

export type OptionalInsertKeys<TColumns extends TableColumnsShape> = {
  [K in keyof TColumns]:
  TColumns[K] extends ColumnDefinition<unknown, boolean, infer THasDefault, infer TGenerated>
    ? THasDefault extends true
      ? K
      : TGenerated extends true
        ? K
        : never
    : never
}[keyof TColumns]

export type RequiredInsertKeys<TColumns extends TableColumnsShape> = Exclude<keyof TColumns, OptionalInsertKeys<TColumns>>

export type InferSelect<TTable extends TableDefinition> = {
  [K in keyof TTable['columns']]: ColumnSelectType<TTable['columns'][K]>
}

export type InferInsert<TTable extends TableDefinition> = {
  [K in RequiredInsertKeys<TTable['columns']>]: ColumnInsertType<TTable['columns'][K]>
} & {
  [K in OptionalInsertKeys<TTable['columns']>]?: ColumnInsertType<TTable['columns'][K]>
}

export type InferUpdate<TTable extends TableDefinition> = Partial<{
  [K in keyof TTable['columns']]: ColumnInsertType<TTable['columns'][K]>
}>
