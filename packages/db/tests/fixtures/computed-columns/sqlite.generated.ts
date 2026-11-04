import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const computedBuilderSqlite = defineGeneratedTable("computed_builder_sqlite", {
  "id": column.id(),
  "price": column.integer(),
  "quantity": column.integer(),
  "name": column.string(),
  "note": column.string().nullable(),
  "total": column.integer().storedAs("price * quantity").nullable(),
  "label": column.string().virtualAs("name || ' (it''s)'").nullable(),
})

export const computedRawSqlite = defineGeneratedTable("computed_raw_sqlite", {
  "id": column.id(),
  "width": column.integer(),
  "height": column.integer(),
  "area": column.integer().storedAs("width * height").nullable(),
  "perimeter": column.integer().virtualAs("2 * (width + height)").nullable(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "computed_builder_sqlite": typeof computedBuilderSqlite
    "computed_raw_sqlite": typeof computedRawSqlite
  }
}

export const tables = { "computed_builder_sqlite": computedBuilderSqlite, "computed_raw_sqlite": computedRawSqlite } as const

registerGeneratedTables(tables)
