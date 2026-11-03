import type { InferSelect, TableDefinition } from '../schema/types'

export type QualifiedTableColumns<TTable extends TableDefinition> = {
  [TColumn in keyof InferSelect<TTable> & string as `${TTable['tableName']}.${TColumn}`]: InferSelect<TTable>[TColumn]
}

export type AvailableTableColumns<TTable extends string | TableDefinition> = TTable extends TableDefinition
  ? InferSelect<TTable> & QualifiedTableColumns<TTable>
  : Record<string, unknown>

export type NullableColumns<TColumns extends Record<string, unknown>> = {
  [TColumn in keyof TColumns]: TColumns[TColumn] | null
}

type QualifiedTableName<TColumn extends string> = TColumn extends `${infer TTable}.${string}` ? TTable : never

export type TableWildcardSelection<TTableName extends string> = `${TTableName}.*`

export type ColumnSelection<TColumns extends Record<string, unknown>> = keyof TColumns & string
  | `${keyof TColumns & string} as ${string}`
  | TableWildcardSelection<QualifiedTableName<keyof TColumns & string>>

type SelectionColumn<TSelection extends string> = TSelection extends `${infer TColumn} as ${string}` ? TColumn : TSelection

type SelectionName<TSelection extends string> = TSelection extends `${string} as ${infer TAlias}`
  ? TAlias
  : TSelection extends `${string}.${infer TColumn}` ? SelectionName<TColumn> : TSelection

type WildcardTableName<TSelection extends string> = TSelection extends TableWildcardSelection<infer TTable> ? TTable : never

type WildcardSelectedColumns<
  TAvailableColumns extends Record<string, unknown>,
  TTableName extends string,
> = {
  [TColumn in keyof TAvailableColumns & string as TColumn extends `${TTableName}.${infer TName}` ? TName : never]: TAvailableColumns[TColumn]
}

type NamedSelectedColumns<
  TAvailableColumns extends Record<string, unknown>,
  TSelection extends string,
> = {
  [TName in TSelection as SelectionName<TName>]: TAvailableColumns[SelectionColumn<TName> & keyof TAvailableColumns]
}

type Simplify<TValue> = { [TKey in keyof TValue]: TValue[TKey] }

export type SelectedColumns<
  TAvailableColumns extends Record<string, unknown>,
  TSelections extends readonly string[],
> = string extends TSelections[number]
  ? Record<string, unknown>
  : [WildcardTableName<TSelections[number]>] extends [never]
    ? NamedSelectedColumns<TAvailableColumns, TSelections[number]>
    : Simplify<
      WildcardSelectedColumns<TAvailableColumns, WildcardTableName<TSelections[number]>>
      & NamedSelectedColumns<TAvailableColumns, Exclude<TSelections[number], TableWildcardSelection<string>>>
    >
