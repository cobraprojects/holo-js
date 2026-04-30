import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const holoMigrations = defineGeneratedTable("_holo_migrations", {
  "id": column.id(),
  "name": column.string().unique(),
  "batch": column.integer(),
  "migrated_at": column.timestamp().defaultNow(),
})

export const authIdentities = defineGeneratedTable("auth_identities", {
  "id": column.id(),
  "user_id": column.string(),
  "guard": column.string().default("web"),
  "auth_provider": column.string().default("users"),
  "provider": column.string(),
  "provider_user_id": column.string(),
  "email": column.string().nullable(),
  "email_verified": column.boolean().default(false),
  "profile": column.json().default({}),
  "tokens": column.json().default({}),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
}, { indexes: [{ columns: ["user_id"], unique: false }, { columns: ["provider","provider_user_id"], unique: true, name: "auth_identities_provider_user_unique" }] })

export const categories = defineGeneratedTable("categories", {
  "id": column.id(),
  "name": column.string(),
  "slug": column.string().unique(),
  "description": column.text().nullable(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
})

export const emailVerificationTokens = defineGeneratedTable("email_verification_tokens", {
  "id": column.uuid().primaryKey(),
  "provider": column.string().default("users"),
  "user_id": column.string(),
  "email": column.string(),
  "token_hash": column.string(),
  "expires_at": column.timestamp(),
  "used_at": column.timestamp().nullable(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
}, { indexes: [{ columns: ["provider"], unique: false }, { columns: ["user_id"], unique: false }, { columns: ["email"], unique: false }] })

export const notifications = defineGeneratedTable("notifications", {
  "id": column.string().primaryKey(),
  "type": column.string().nullable(),
  "notifiable_type": column.string(),
  "notifiable_id": column.string(),
  "data": column.json().default({}),
  "read_at": column.timestamp().nullable(),
  "created_at": column.timestamp(),
  "updated_at": column.timestamp(),
}, { indexes: [{ columns: ["notifiable_type","notifiable_id"], unique: false }, { columns: ["read_at"], unique: false }] })

export const passwordResetTokens = defineGeneratedTable("password_reset_tokens", {
  "id": column.uuid().primaryKey(),
  "provider": column.string().default("users"),
  "email": column.string(),
  "token_hash": column.string(),
  "expires_at": column.timestamp(),
  "used_at": column.timestamp().nullable(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
}, { indexes: [{ columns: ["provider"], unique: false }, { columns: ["email"], unique: false }] })

export const personalAccessTokens = defineGeneratedTable("personal_access_tokens", {
  "id": column.uuid().primaryKey(),
  "provider": column.string().default("users"),
  "user_id": column.string(),
  "name": column.string(),
  "token_hash": column.string().unique(),
  "abilities": column.json().default([]),
  "last_used_at": column.timestamp().nullable(),
  "expires_at": column.timestamp().nullable(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
}, { indexes: [{ columns: ["provider"], unique: false }, { columns: ["user_id"], unique: false }] })

export const postTags = defineGeneratedTable("post_tags", {
  "post_id": column.integer(),
  "tag_id": column.integer(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
})

export const posts = defineGeneratedTable("posts", {
  "id": column.id(),
  "user_id": column.integer(),
  "category_id": column.integer().nullable(),
  "title": column.string(),
  "slug": column.string().unique(),
  "status": column.string().default("draft"),
  "excerpt": column.text().nullable(),
  "body": column.text(),
  "published_at": column.timestamp().nullable(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
})

export const sessions = defineGeneratedTable("sessions", {
  "id": column.string().primaryKey(),
  "store": column.string().default("database"),
  "data": column.json().default({}),
  "created_at": column.timestamp(),
  "last_activity_at": column.timestamp(),
  "expires_at": column.timestamp(),
  "invalidated_at": column.timestamp().nullable(),
  "remember_token_hash": column.string().nullable(),
}, { indexes: [{ columns: ["expires_at"], unique: false }] })

export const tags = defineGeneratedTable("tags", {
  "id": column.id(),
  "name": column.string(),
  "slug": column.string().unique(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
})

export const users = defineGeneratedTable("users", {
  "id": column.id(),
  "name": column.string(),
  "email": column.string().unique(),
  "password": column.string().nullable(),
  "avatar": column.string().nullable(),
  "email_verified_at": column.timestamp().nullable(),
  "created_at": column.timestamp().defaultNow(),
  "updated_at": column.timestamp().defaultNow(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "_holo_migrations": typeof holoMigrations
    "auth_identities": typeof authIdentities
    "categories": typeof categories
    "email_verification_tokens": typeof emailVerificationTokens
    "notifications": typeof notifications
    "password_reset_tokens": typeof passwordResetTokens
    "personal_access_tokens": typeof personalAccessTokens
    "post_tags": typeof postTags
    "posts": typeof posts
    "sessions": typeof sessions
    "tags": typeof tags
    "users": typeof users
  }
}

export const tables = { "_holo_migrations": holoMigrations, "auth_identities": authIdentities, "categories": categories, "email_verification_tokens": emailVerificationTokens, "notifications": notifications, "password_reset_tokens": passwordResetTokens, "personal_access_tokens": personalAccessTokens, "post_tags": postTags, "posts": posts, "sessions": sessions, "tags": tags, "users": users } as const

registerGeneratedTables(tables)
