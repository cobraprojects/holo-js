import { column, defineGeneratedTable, registerGeneratedTables } from '@holo-js/db'

export const teams = defineGeneratedTable('teams', {
  id: column.id(),
  name: column.string(),
  created_at: column.timestamp().defaultNow(),
  updated_at: column.timestamp().defaultNow(),
})

export const users = defineGeneratedTable('users', {
  id: column.id(),
  team_id: column.foreignId().constrained('teams'),
  name: column.string(),
  status: column.string(),
  loginCount: column.integer(),
  created_at: column.timestamp().defaultNow(),
  updated_at: column.timestamp().defaultNow(),
})

declare module '@holo-js/db' {
  interface GeneratedSchemaTables {
    teams: typeof teams
    users: typeof users
  }
}

export const tables = {
  teams,
  users,
} as const

registerGeneratedTables(tables)
