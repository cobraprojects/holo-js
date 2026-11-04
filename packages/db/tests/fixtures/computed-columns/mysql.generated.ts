import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const computedBuilderMysql = defineGeneratedTable("computed_builder_mysql", {
  "id": column.id(),
  "price": column.integer(),
  "quantity": column.integer(),
  "name": column.string(),
  "note": column.string().nullable(),
  "total": column.integer().storedAs("(`price` * `quantity`)").nullable(),
  "label": column.string().virtualAs("concat(`name`,_utf8mb4' (it\\'s)')").nullable(),
})

export const computedRawMysql = defineGeneratedTable("computed_raw_mysql", {
  "id": column.id(),
  "width": column.integer(),
  "height": column.integer(),
  "area": column.integer().storedAs("(`width` * `height`)").notNull(),
  "perimeter": column.integer().virtualAs("(2 * (`width` + `height`))").nullable(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "computed_builder_mysql": typeof computedBuilderMysql
    "computed_raw_mysql": typeof computedRawMysql
  }
}

export const tables = { "computed_builder_mysql": computedBuilderMysql, "computed_raw_mysql": computedRawMysql } as const

registerGeneratedTables(tables)
