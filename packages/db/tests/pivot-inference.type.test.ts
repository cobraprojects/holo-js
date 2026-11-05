import { expectTypeOf, it } from 'vitest'
import { belongsToMany, column, defineFactory, defineModel, defineGeneratedTable, hasMany, morphToMany, morphedByMany, type InferSelect } from '../src'

const registeredPivot = defineGeneratedTable('pivot_type_registered', {
  user_id: column.integer(),
  role_id: column.integer(),
  approved: column.boolean(),
})

declare module '../src' {
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

const typedPivotWrites = defineGeneratedTable('pivot_type_typed_writes', {
  user_id: column.integer(),
  role_id: column.integer(),
  approved: column.boolean(),
  note: column.string().nullable(),
  score: column.integer().storedAs('1').nullable(),
})

declare module '../src' {
  interface GeneratedSchemaTables {
    pivot_type_typed_writes: typeof typedPivotWrites
  }
}

it('types pivot attribute writes from the pivot table columns', () => {
  const roles = defineGeneratedTable('pivot_type_write_roles', { id: column.id() })
  const users = defineGeneratedTable('pivot_type_write_users', { id: column.id() })
  const Role = defineModel(roles)
  const User = defineModel(users, {
    relations: {
      roles: belongsToMany(() => Role, typedPivotWrites, 'user_id', 'role_id').withPivot('approved', 'note'),
      registered: belongsToMany(() => Role, { pivotTable: 'pivot_type_typed_writes', foreignPivotKey: 'user_id', relatedPivotKey: 'role_id' }),
      morphRoles: morphToMany(() => Role, 'owner', typedPivotWrites, 'role_id'),
      inverseMorphRoles: morphedByMany(() => Role, 'owner', typedPivotWrites, 'user_id'),
      untyped: belongsToMany(() => Role, 'pivot_type_untyped_writes', 'user_id', 'role_id'),
    },
  })
  const RoleFactory = defineFactory(Role, () => ({}))
  const UserFactory = defineFactory(User, () => ({}))

  if (false) {
    const check = async () => {
      const user = await User.firstOrFail()

      await user.roles().attach(1, { approved: true, note: null })
      await user.roles().attach([1, 2], { approved: false })
      await user.roles().attach({ 1: { approved: true } })
      await user.roles().sync([1, 2])
      await user.roles().sync(null)
      await user.roles().sync({ 1: null, 2: undefined })
      await user.attach('roles', { 1: null })
      await user.roles().toggle(undefined)
      await user.roles().attach([new Uint8Array([1])])
      await user.roles().sync({ 1: { approved: true }, 2: { note: 'x' } })
      await user.roles().toggle({ 1: { approved: true } })
      await user.roles().updateExistingPivot(1, { note: 'x' })
      await user.registered().attach(1, { approved: true })
      await user.morphRoles().updateExistingPivot(1, { approved: true })
      await user.inverseMorphRoles().sync({ 1: { approved: true } })
      await user.attach('roles', 1, { approved: true })
      await user.sync('roles', { 1: { approved: true } })
      await user.syncWithoutDetaching('roles', { 1: { note: null } })
      await user.toggle('roles', [1])
      await user.updateExistingPivot('roles', 1, { approved: false })
      UserFactory.hasAttached(RoleFactory, 'roles', { approved: true })

      // @ts-expect-error a single binary id is read as an id map
      await user.roles().attach(new Uint8Array([1]))
      // @ts-expect-error unknown pivot column
      await user.roles().attach(1, { aproved: true })
      // @ts-expect-error computed pivot column
      await user.roles().attach(1, { score: 1 })
      // @ts-expect-error wrong pivot value type
      await user.roles().attach(1, { approved: 'yes' })
      // @ts-expect-error unknown pivot column
      await user.roles().sync({ 1: { aproved: true } })
      // @ts-expect-error computed pivot column
      await user.roles().sync({ 1: { score: 1 } })
      // @ts-expect-error unknown pivot column
      await user.roles().toggle({ 1: { aproved: true } })
      // @ts-expect-error computed pivot column
      await user.roles().updateExistingPivot(1, { score: 1 })
      // @ts-expect-error unknown pivot column
      await user.registered().attach(1, { aproved: true })
      // @ts-expect-error computed pivot column
      await user.morphRoles().updateExistingPivot(1, { score: 1 })
      // @ts-expect-error wrong pivot value type
      await user.inverseMorphRoles().sync({ 1: { approved: 'yes' } })
      // @ts-expect-error unknown pivot column
      await user.attach('roles', 1, { aproved: true })
      // @ts-expect-error computed pivot column
      await user.sync('roles', { 1: { score: 1 } })
      // @ts-expect-error unknown pivot column
      await user.syncWithoutDetaching('roles', { 1: { aproved: true } })
      // @ts-expect-error computed pivot column
      await user.toggle('roles', { 1: { score: 1 } })
      // @ts-expect-error wrong pivot value type
      await user.updateExistingPivot('roles', 1, { approved: 'yes' })
      // @ts-expect-error unknown pivot column
      UserFactory.hasAttached(RoleFactory, 'roles', { aproved: true })
      // @ts-expect-error computed pivot column
      UserFactory.hasAttached(RoleFactory, 'roles', { score: 1 })

      await user.untyped().attach(1, { anything: 'goes' })
      await user.untyped().sync({ 1: { anything: 'goes' } })
      await user.untyped().updateExistingPivot(1, { anything: 1 })
      await user.attach('untyped', 1, { anything: 'goes' })
      await user.syncWithoutDetaching('untyped', { 1: { anything: 'goes' } })
      UserFactory.hasAttached(RoleFactory, 'untyped', { anything: 'goes' })
    }
    void check
  }
})
