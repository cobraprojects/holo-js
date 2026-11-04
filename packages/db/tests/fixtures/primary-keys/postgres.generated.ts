import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const primaryKeysPostTagPostgres = defineGeneratedTable("primary_keys_post_tag_postgres", {
  "post_id": column.integer().primaryKey(),
  "tag_id": column.integer().primaryKey(),
  "weight": column.integer().default(0),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "primary_keys_post_tag_postgres": typeof primaryKeysPostTagPostgres
  }
}

export const tables = { "primary_keys_post_tag_postgres": primaryKeysPostTagPostgres } as const

registerGeneratedTables(tables)
