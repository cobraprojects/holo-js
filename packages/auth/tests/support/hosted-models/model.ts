import { column, defineGeneratedTable, defineModel } from '@holo-js/db'
import { authModelColumns, prepareAuthCreateInput as prepareBaseAuthCreateInput } from '../models/model'

export function createHostedAuthModel(tableName: string) {
  return defineModel(defineGeneratedTable(tableName, {
    ...authModelColumns,
    clerkUserId: column.string().nullable(),
    timezone: column.string().nullable(),
  }), {
    hidden: ['password', 'phone', 'country', 'dob', 'created_at', 'updated_at'],
    appended: ['avatarUrl'],
    accessors: { avatarUrl: (_value, entity) => entity.toAttributes().avatar ?? null },
  })
}

export function prepareAuthCreateInput(input: Readonly<Record<string, unknown>>) {
  return { ...prepareBaseAuthCreateInput(input), name: input.name ?? input.email }
}
