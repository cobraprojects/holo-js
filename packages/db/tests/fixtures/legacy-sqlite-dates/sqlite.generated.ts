import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const legacyDateTagUser = defineGeneratedTable("legacy_date_tag_user", {
  "user_id": column.integer(),
  "tag_id": column.integer(),
  "is_primary": column.integer().default(0),
  "created_at": column.text().nullable(),
  "updated_at": column.text().nullable(),
}, { indexes: [{ columns: ["user_id","tag_id"], unique: true, name: "sqlite_autoindex_legacy_date_tag_user_1" }] })

export const legacyDateTags = defineGeneratedTable("legacy_date_tags", {
  "id": column.id(),
  "name": column.text(),
  "created_at": column.text().nullable(),
  "updated_at": column.text().nullable(),
})

export const legacyDateUsers = defineGeneratedTable("legacy_date_users", {
  "id": column.id(),
  "name": column.text(),
  "birthday": column.text().nullable(),
  "created_at": column.text().nullable(),
  "updated_at": column.text().nullable(),
  "deleted_at": column.text().nullable(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "legacy_date_tag_user": typeof legacyDateTagUser
    "legacy_date_tags": typeof legacyDateTags
    "legacy_date_users": typeof legacyDateUsers
  }
}

export const tables = { "legacy_date_tag_user": legacyDateTagUser, "legacy_date_tags": legacyDateTags, "legacy_date_users": legacyDateUsers } as const

registerGeneratedTables(tables)
