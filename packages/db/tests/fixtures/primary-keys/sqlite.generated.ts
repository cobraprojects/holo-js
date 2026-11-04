import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const primaryKeysPostTagSqlite = defineGeneratedTable("primary_keys_post_tag_sqlite", {
  "post_id": column.integer().primaryKey(),
  "tag_id": column.integer().primaryKey(),
  "weight": column.integer().default(0),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "primary_keys_post_tag_sqlite": typeof primaryKeysPostTagSqlite
  }
}

export const tables = { "primary_keys_post_tag_sqlite": primaryKeysPostTagSqlite } as const

registerGeneratedTables(tables)
