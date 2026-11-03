import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const primaryKeysPostTagMysql = defineGeneratedTable("primary_keys_post_tag_mysql", {
  "post_id": column.integer().primaryKey(),
  "tag_id": column.integer().primaryKey(),
  "weight": column.integer().default(0),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "primary_keys_post_tag_mysql": typeof primaryKeysPostTagMysql
  }
}

export const tables = { "primary_keys_post_tag_mysql": primaryKeysPostTagMysql } as const

registerGeneratedTables(tables)
