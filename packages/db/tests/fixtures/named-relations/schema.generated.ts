import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const namedRelationTenants = defineGeneratedTable("named_relation_tenants", {
  "id": column.id(),
  "display_name": column.string(),
  "created_at": column.string(),
})

export const namedRelationRewards = defineGeneratedTable("named_relation_rewards", {
  "id": column.id(),
  "tenant_id": column.integer(),
  "parent_id": column.integer().nullable(),
  "points": column.integer(),
})

export const namedRelationAllocations = defineGeneratedTable("named_relation_allocations", {
  "id": column.id(),
  "reward_id": column.integer(),
  "quantity": column.integer(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    "named_relation_tenants": typeof namedRelationTenants
    "named_relation_rewards": typeof namedRelationRewards
    "named_relation_allocations": typeof namedRelationAllocations
  }
}

export const tables = { "named_relation_tenants": namedRelationTenants, "named_relation_rewards": namedRelationRewards, "named_relation_allocations": namedRelationAllocations } as const

registerGeneratedTables(tables)
