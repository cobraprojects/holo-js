import { expectTypeOf, it } from 'vitest'
import { belongsToMany, column, defineModel, defineGeneratedTable, hasMany, morphToMany, morphedByMany, type InferSelect } from '../src'

const registeredPivot = defineGeneratedTable('pivot_type_registered', {
  user_id: column.integer(),
  role_id: column.integer(),
  approved: column.boolean(),
})

declare module '../src/schema/generated' {
  interface GeneratedSchemaTables {
    pivot_type_registered: typeof registeredPivot
  }
}

it('infers all pivot fields on eager-loaded relations', () => {
  const users = defineGeneratedTable('pivot_type_users', { id: column.id() })
  const roles = defineGeneratedTable('pivot_type_roles', { id: column.id(), name: column.string() })
  const memberships = defineGeneratedTable('pivot_type_memberships', {
    id: column.id(),
    user_id: column.integer(),
    role_id: column.integer(),
    approved: column.boolean(),
    note: column.string().nullable(),
    hidden: column.string(),
    created_at: column.timestamp(),
    updated_at: column.timestamp(),
  })
  const Role = defineModel(roles)
  const Membership = defineModel(memberships)
  const User = defineModel(users, {
    relations: {
      roles: belongsToMany(() => Role, memberships, 'user_id', 'role_id')
        .withPivot('approved')
        .wherePivot('approved', true)
        .withPivot('note')
        .orderByPivot('note'),
      custom: belongsToMany(() => Role, memberships, 'user_id', 'role_id').using(() => Membership).as('membership').withTimestamps(),
      registered: belongsToMany(() => Role, { pivotTable: 'pivot_type_registered', foreignPivotKey: 'user_id', relatedPivotKey: 'role_id' }).withPivot('approved'),
      morphRoles: morphToMany(() => Role, 'owner', memberships, 'role_id').withTimestamps(),
      inverseMorphRoles: morphedByMany(() => Role, 'owner', memberships, 'user_id').as('membership'),
      memberships: belongsToMany(() => Role, memberships, 'user_id', 'role_id')
        .withTimestamps().as('membership'),
    },
  })
  const Team = defineModel(defineGeneratedTable('pivot_type_teams', { id: column.id() }), {
    relations: { users: hasMany(() => User, 'team_id') },
  })

  if (false) {
    const check = async () => {
      const user = await User.with('roles', 'memberships', 'registered', 'morphRoles', 'inverseMorphRoles', 'custom').firstOrFail()
      expectTypeOf(user.roles[0]?.pivot.approved).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(user.roles[0]?.pivot.note).toEqualTypeOf<string | null | undefined>()
      expectTypeOf(user.memberships[0]?.membership.approved).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(user.roles[0]?.pivot.hidden).toEqualTypeOf<string | undefined>()
      expectTypeOf(user.roles[0]?.pivot.user_id).toEqualTypeOf<number | undefined>()
      expectTypeOf(user.memberships[0]?.membership.created_at).toEqualTypeOf<Date | undefined>()
      expectTypeOf(user.memberships[0]?.membership.updated_at).toEqualTypeOf<Date | undefined>()
      expectTypeOf(user.registered[0]?.pivot.approved).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(user.morphRoles[0]?.pivot.approved).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(user.inverseMorphRoles[0]?.membership.approved).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(user.roles[0]?.pivot).toEqualTypeOf<InferSelect<typeof memberships> | undefined>()
      expectTypeOf(user.custom[0]?.membership.approved).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(user.custom[0]?.membership.get('approved')).toEqualTypeOf<boolean | undefined>()
      const unloaded = await User.firstOrFail()
      const loaded = await unloaded.load('roles')
      expectTypeOf(loaded.roles[0]?.pivot.approved).toEqualTypeOf<boolean | undefined>()
      expectTypeOf(loaded.toJSON().roles[0]?.pivot.approved).toEqualTypeOf<boolean | undefined>()
      const json = await User.with('roles').firstJson()
      expectTypeOf(json?.roles[0]?.pivot.approved).toEqualTypeOf<boolean | undefined>()
      const team = await Team.with('users.roles').firstOrFail()
      expectTypeOf(team.users[0]?.roles[0]?.pivot.approved).toEqualTypeOf<boolean | undefined>()
    }
    void check
  }
})
