import { column, defineGeneratedTable, defineModel } from '@holo-js/db'

export const authModelColumns = {
  id: column.id(),
  name: column.string(),
  email: column.string(),
  role: column.enum(['admin', 'member']).default('member'),
  phone: column.string().nullable(),
  country: column.string().nullable(),
  dob: column.string().nullable(),
  password: column.string().nullable(),
  avatar: column.string().nullable(),
  email_verified_at: column.timestamp().nullable(),
  created_at: column.timestamp().defaultNow(),
  updated_at: column.timestamp().defaultNow(),
}

export function createAuthModel(tableName: string) {
  return defineModel(defineGeneratedTable(tableName, authModelColumns), {
    hidden: ['password', 'avatar', 'created_at', 'updated_at'],
    appended: ['avatarUrl'],
    accessors: { avatarUrl: (_value, entity) => entity.toAttributes().avatar ?? null },
  })
}

export function prepareAuthCreateInput(input: Readonly<Record<string, unknown>>) {
  return { name: '', email: '', ...input }
}
