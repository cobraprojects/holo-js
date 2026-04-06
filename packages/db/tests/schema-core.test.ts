import { describe, expect, expectTypeOf, it } from 'vitest'
import {
  SchemaError,
  TableDefinitionBuilder,
  TableMutationBuilder,
  column,
  createSchemaRegistry,
  type InferInsert,
  type InferSelect,
  type InferUpdate,
  type TableDefinition } from '../src'
import { defineTable } from './support/internal'

type Equal<A, B>
  = (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2)
    ? true
    : false

type Expect<T extends true> = T

describe('native schema core', () => {
  it('binds logical columns into a table definition with direct property access', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string().notNull(),
      active: column.boolean().default(true),
      profile: column.json<{ bio: string }>().nullable(),
      vector: column.vector({ dimensions: 3 }).nullable(),
      role: column.enum(['admin', 'member'] as const).default('member'),
      accountId: column.foreignId().constrained('accounts').cascadeOnDelete(),
      account_uuid: column.foreignUuid().constrained('accounts', 'uuid'),
      session_ulid: column.foreignUlid().constrained('sessions', 'id'),
      actor_snowflake: column.foreignSnowflake().constrained('actors', 'snowflake_id') }, {
      indexes: [{ columns: ['email'], unique: true }] })

    expect(users.kind).toBe('table')
    expect(users.tableName).toBe('users')
    expect(users.id.name).toBe('id')
    expect(users.id.primaryKey).toBe(true)
    expect(users.id.generated).toBe(true)
    expect(users.id.idStrategy).toBe('autoIncrement')
    expect(users.active.kind).toBe('boolean')
    expect(users.active.hasDefault).toBe(true)
    expect(users.active.defaultValue).toBe(true)
    expect(users.profile.nullable).toBe(true)
    expect(users.vector.vectorDimensions).toBe(3)
    expect(users.role.enumValues).toEqual(['admin', 'member'])
    expect(users.accountId.references).toEqual({
      table: 'accounts',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: undefined })
    expect(users.account_uuid.kind).toBe('uuid')
    expect(users.account_uuid.references).toEqual({
      table: 'accounts',
      column: 'uuid',
      onDelete: undefined,
      onUpdate: undefined })
    expect(users.session_ulid.kind).toBe('ulid')
    expect(users.session_ulid.references).toEqual({
      table: 'sessions',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(users.actor_snowflake.kind).toBe('snowflake')
    expect(users.actor_snowflake.references).toEqual({
      table: 'actors',
      column: 'snowflake_id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(users.columns.name).toBe(users.name)
    expect(users.indexes).toEqual([{ columns: ['email'], unique: true }])
  })

  it('supports logical ID strategy helpers with exact declared names', () => {
    const widgets = defineTable('widgets', {
      widget_id: column.autoIncrementId(),
      uuid: column.uuid().unique(),
      ulid: column.ulid(),
      snowflake: column.snowflake(),
      score: column.real(),
      amount: column.decimal(),
      created_at: column.timestamp().defaultNow(),
      starts_on: column.date(),
      published_at: column.datetime().nullable(),
      payload: column.blob(),
      count: column.bigInteger(),
      widget_title_2: column.string() })

    expect(widgets.widget_id.name).toBe('widget_id')
    expect(widgets.uuid.kind).toBe('uuid')
    expect(widgets.ulid.kind).toBe('ulid')
    expect(widgets.snowflake.idStrategy).toBe('snowflake')
    expect(widgets.score.kind).toBe('real')
    expect(widgets.amount.kind).toBe('decimal')
    expect(widgets.created_at.defaultKind).toBe('now')
    expect(widgets.starts_on.kind).toBe('date')
    expect(widgets.published_at.nullable).toBe(true)
    expect(widgets.payload.kind).toBe('blob')
    expect(widgets.count.kind).toBe('bigInteger')
    expect(widgets.widget_title_2.name).toBe('widget_title_2')
  })

  it('supports schema-qualified table names structurally', () => {
    const auditLogs = defineTable('public.audit_logs', {
      id: column.id(),
      actorId: column.foreignId().constrained('public.users') })

    expect(auditLogs.tableName).toBe('public.audit_logs')
    expect(auditLogs.actorId.references).toEqual({
      table: 'public.users',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })
  })

  it('infers select, insert, and update types from logical column metadata', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string().notNull(),
      active: column.boolean().default(true),
      profile: column.json<{ bio: string }>().nullable(),
      vector: column.vector({ dimensions: 2 }).nullable() })

    type UserSelect = InferSelect<typeof users>
    type UserInsert = InferInsert<typeof users>
    type UserUpdate = InferUpdate<typeof users>

    type _UserSelectAssignableA = Expect<UserSelect extends {
      id: number
      name: string
      active: boolean
      profile: { bio: string } | null
      vector: readonly number[] | null
    } ? true : false>
    type _UserSelectAssignableB = Expect<{
      id: number
      name: string
      active: boolean
      profile: { bio: string } | null
      vector: readonly number[] | null
    } extends UserSelect ? true : false>

    type _UserInsertAssignableA = Expect<UserInsert extends {
      name: string
      active?: boolean
      profile: { bio: string } | null
      vector: readonly number[] | null
      id?: number
    } ? true : false>
    type _UserInsertAssignableB = Expect<{
      name: string
      active?: boolean
      profile: { bio: string } | null
      vector: readonly number[] | null
      id?: number
    } extends UserInsert ? true : false>

    type _UserUpdateAssignableA = Expect<UserUpdate extends Partial<{
      id: number
      name: string
      active: boolean
      profile: { bio: string } | null
      vector: readonly number[] | null
    }> ? true : false>
    type _UserUpdateAssignableB = Expect<Partial<{
      id: number
      name: string
      active: boolean
      profile: { bio: string } | null
      vector: readonly number[] | null
    }> extends UserUpdate ? true : false>

    const insertRow: UserInsert = {
      name: 'A',
      profile: null,
      vector: null }
    expect(insertRow.name).toBe('A')
  })

  it('supports per-registry table registration without global leakage', () => {
    const users = defineTable('users', {
      id: column.id() })

    const registryA = createSchemaRegistry()
    const registryB = createSchemaRegistry()

    expect(registryA.register(users)).toBe(users)
    expect(registryA.has('users')).toBe(true)
    expect(registryA.get('users')).toBe(users)
    expect(registryA.list()).toEqual([users])
    expect(registryB.list()).toEqual([])

    registryA.register(users)
    expect(registryA.list()).toEqual([users])

    registryA.clear()
    expect(registryA.list()).toEqual([])
  })

  it('fails closed when attempting to bind an unbound raw column definition or duplicate registry name', () => {
    const users = defineTable('users', {
      id: column.id() })

    const registry = createSchemaRegistry()
    registry.register(users)

    const usersClone = defineTable('users', {
      id: column.id() })

    expect(() => registry.register(usersClone)).toThrow(SchemaError)

    expect(() => defineTable('broken', {
      id: users.id,
      broken: { kind: 'string' } as never })).toThrow(SchemaError)

    expect(() => defineTable('users', {
      email: {
        kind: 'string',
        name: 'email_address',
        nullable: false,
        hasDefault: false,
        generated: false,
        primaryKey: false,
        unique: false } as never })).toThrow(SchemaError)
  })

  it('covers the fluent create-table builder surface directly', () => {
    const tableBuilder = new TableDefinitionBuilder('audit_logs')
      .id('audit_id').generated().primaryKey()
      .autoIncrementId('legacy_id')
      .integer('account_id')
      .integer('manager_id')
      .integer('region_id')
      .foreignId('team_id').constrained('teams').cascadeOnDelete()
      .foreignUuid('account_uuid').constrained('accounts', 'uuid')
      .foreignUlid('session_ulid').constrained('sessions')
      .foreignSnowflake('actor_snowflake').constrained('actors', 'snowflake_id')
      .bigInteger('sequence')
      .string('display_name').notNull()
      .text('notes').nullable()
      .boolean('active').default(true)
      .real('score')
      .decimal('amount')
      .date('starts_on')
      .datetime('published_at')
      .timestamp('archived_at').nullable().defaultNow()
      .json('settings')
      .blob('payload')
      .uuid('public_id')
      .ulid('trace_id')
      .snowflake('snowflake_id')
      .vector('embedding', { dimensions: 3 })
      .enum('status_code', ['pending', 'completed'] as const)
      .index(['account_id'], 'audit_logs_account_idx')
      .unique(['public_id'], 'audit_logs_public_id_unique')
      .timestamps()
      .softDeletes()

    tableBuilder
      .foreign('account_id')
      .references('id')
      .on('accounts')
      .cascadeOnDelete()
      .noActionOnUpdate()
    tableBuilder
      .foreign('manager_id')
      .references('id')
      .on('users')
      .nullOnUpdate()
    tableBuilder
      .foreign('region_id')
      .references('id')
      .on('regions')
      .restrictOnUpdate()

    const table = tableBuilder.build()

    expect(table.audit_id.name).toBe('audit_id')
    expect(table.account_id.references).toEqual({
      table: 'accounts',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: 'no action' })
    expect(table.account_uuid.kind).toBe('uuid')
    expect(table.account_uuid.references).toEqual({
      table: 'accounts',
      column: 'uuid',
      onDelete: undefined,
      onUpdate: undefined })
    expect(table.session_ulid.kind).toBe('ulid')
    expect(table.session_ulid.references).toEqual({
      table: 'sessions',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(table.actor_snowflake.kind).toBe('snowflake')
    expect(table.actor_snowflake.references).toEqual({
      table: 'actors',
      column: 'snowflake_id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(table.manager_id.references).toEqual({
      table: 'users',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'set null' })
    expect(table.region_id.references).toEqual({
      table: 'regions',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'restrict' })
    expect(table.team_id.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: undefined })
    expect(table.display_name.name).toBe('display_name')
    expect(table.notes.nullable).toBe(true)
    expect(table.active.defaultValue).toBe(true)
    expect(table.archived_at.defaultKind).toBe('now')
    expect(table.public_id.name).toBe('public_id')
    expect(table.trace_id.kind).toBe('ulid')
    expect(table.snowflake_id.idStrategy).toBe('snowflake')
    expect(table.embedding.vectorDimensions).toBe(3)
    expect(table.status_code.enumValues).toEqual(['pending', 'completed'])
    expect(table.created_at.name).toBe('created_at')
    expect(table.updated_at.name).toBe('updated_at')
    expect(table.deleted_at.name).toBe('deleted_at')
    expect(table.indexes).toEqual([
      { columns: ['account_id'], name: 'audit_logs_account_idx', unique: false },
      { columns: ['public_id'], name: 'audit_logs_public_id_unique', unique: true },
    ])

    const quick = new TableDefinitionBuilder('quick_users')
      .string('email')
      .unique()
      .build()
    expect(quick.email.unique).toBe(true)

    const forwarded = new TableDefinitionBuilder('forwarded')
      .string('title')
      .timestamp('created_on').defaultNow()
      .timestamp('updated_on').defaultNow()
      .build()
    expect(forwarded.created_on.name).toBe('created_on')
    expect(forwarded.updated_on.name).toBe('updated_on')

    const deleted = new TableDefinitionBuilder('deleted_docs')
      .string('title')
      .softDeletes('removed_at')
      .build()
    expect(deleted.removed_at.name).toBe('removed_at')

    const keyed = new TableDefinitionBuilder('api_keys')
      .string('key')
      .unique(['key'], 'api_keys_key_unique')
      .build()
    expect(keyed.indexes).toEqual([
      { columns: ['key'], name: 'api_keys_key_unique', unique: true },
    ])

    const rekeyed = new TableDefinitionBuilder('rekeyed')
      .string('label')
      .id('primary_id')
      .build()
    expect(rekeyed.primary_id.name).toBe('primary_id')
  })

  it('supports morph helper columns on create-table builders', () => {
    const table = new TableDefinitionBuilder('activities')
      .morphs('subject')
      .uuidMorphs('owner')
      .ulidMorphs('session')
      .snowflakeMorphs('actor')
      .nullableMorphs('commentable')
      .nullableUuidMorphs('auditable')
      .nullableUlidMorphs('traceable')
      .nullableSnowflakeMorphs('operator')
      .build()

    expect(table.subject_type.kind).toBe('string')
    expect(table.subject_type.nullable).toBe(false)
    expect(table.subject_id.kind).toBe('bigInteger')
    expect(table.subject_id.nullable).toBe(false)

    expect(table.owner_type.kind).toBe('string')
    expect(table.owner_id.kind).toBe('uuid')
    expect(table.owner_id.nullable).toBe(false)

    expect(table.session_type.kind).toBe('string')
    expect(table.session_id.kind).toBe('ulid')
    expect(table.session_id.nullable).toBe(false)

    expect(table.actor_type.kind).toBe('string')
    expect(table.actor_id.kind).toBe('snowflake')
    expect(table.actor_id.nullable).toBe(false)

    expect(table.commentable_type.nullable).toBe(true)
    expect(table.commentable_id.kind).toBe('bigInteger')
    expect(table.commentable_id.nullable).toBe(true)

    expect(table.auditable_type.nullable).toBe(true)
    expect(table.auditable_id.kind).toBe('uuid')
    expect(table.auditable_id.nullable).toBe(true)

    expect(table.traceable_type.nullable).toBe(true)
    expect(table.traceable_id.kind).toBe('ulid')
    expect(table.traceable_id.nullable).toBe(true)

    expect(table.operator_type.nullable).toBe(true)
    expect(table.operator_id.kind).toBe('snowflake')
    expect(table.operator_id.nullable).toBe(true)

    expect(table.indexes).toEqual([
      { columns: ['subject_type', 'subject_id'], name: undefined, unique: false },
      { columns: ['owner_type', 'owner_id'], name: undefined, unique: false },
      { columns: ['session_type', 'session_id'], name: undefined, unique: false },
      { columns: ['actor_type', 'actor_id'], name: undefined, unique: false },
      { columns: ['commentable_type', 'commentable_id'], name: undefined, unique: false },
      { columns: ['auditable_type', 'auditable_id'], name: undefined, unique: false },
      { columns: ['traceable_type', 'traceable_id'], name: undefined, unique: false },
      { columns: ['operator_type', 'operator_id'], name: undefined, unique: false },
    ])
  })

  it('supports chained morph helper columns from a create-table column builder', () => {
    const table = new TableDefinitionBuilder('assets')
      .string('label')
      .morphs('attachable')
      .nullableMorphs('commentable')
      .uuidMorphs('owner')
      .nullableUuidMorphs('auditable')
      .ulidMorphs('session')
      .nullableUlidMorphs('traceable')
      .snowflakeMorphs('actor')
      .nullableSnowflakeMorphs('operator')
      .build()

    expect(table.attachable_id.kind).toBe('bigInteger')
    expect(table.commentable_id.nullable).toBe(true)
    expect(table.owner_id.kind).toBe('uuid')
    expect(table.auditable_id.nullable).toBe(true)
    expect(table.session_id.kind).toBe('ulid')
    expect(table.traceable_id.nullable).toBe(true)
    expect(table.actor_id.kind).toBe('snowflake')
    expect(table.operator_id.nullable).toBe(true)
  })

  it('covers every morph helper on the create-table column-builder delegate surface', () => {
    expect(new TableDefinitionBuilder('m1').string('label').morphs('attachable').build().attachable_id.kind).toBe('bigInteger')
    expect(new TableDefinitionBuilder('m2').string('label').nullableMorphs('commentable').build().commentable_id.nullable).toBe(true)
    expect(new TableDefinitionBuilder('m3').string('label').uuidMorphs('owner').build().owner_id.kind).toBe('uuid')
    expect(new TableDefinitionBuilder('a').string('label').nullableUuidMorphs('auditable').build().auditable_id.nullable).toBe(true)
    expect(new TableDefinitionBuilder('b').string('label').ulidMorphs('session').build().session_id.kind).toBe('ulid')
    expect(new TableDefinitionBuilder('c').string('label').nullableUlidMorphs('traceable').build().traceable_id.nullable).toBe(true)
    expect(new TableDefinitionBuilder('d').string('label').snowflakeMorphs('actor').build().actor_id.kind).toBe('snowflake')
    expect(new TableDefinitionBuilder('e').string('label').nullableSnowflakeMorphs('operator').build().operator_id.nullable).toBe(true)
  })

  it('fails closed when attaching a create-table foreign key before declaring the column', () => {
    const builder = new TableDefinitionBuilder('users')

    expect(() => builder.foreign('team_id')).toThrow(
      'Cannot attach a foreign key to unknown column "team_id". Declare the column first.',
    )
  })

  it('covers every explicit create-table foreign builder helper', () => {
    const cascadeTable = new TableDefinitionBuilder('cascade_users')
      .integer('team_id')
      .foreign('team_id')
      .references('id')
      .on('teams')
      .cascadeOnUpdate()
      .build()
    expect(cascadeTable.team_id.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'cascade' })

    const restrictTable = new TableDefinitionBuilder('restrict_users')
      .integer('region_id')
      .foreign('region_id')
      .references('id')
      .on('regions')
      .restrictOnUpdate()
      .build()
    expect(restrictTable.region_id.references).toEqual({
      table: 'regions',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'restrict' })

    const nullTable = new TableDefinitionBuilder('null_users')
      .integer('manager_id')
      .foreign('manager_id')
      .references('id')
      .on('users')
      .nullOnUpdate()
      .build()
    expect(nullTable.manager_id.references).toEqual({
      table: 'users',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'set null' })

    const noActionTable = new TableDefinitionBuilder('no_action_users')
      .integer('account_id')
      .foreign('account_id')
      .references('id')
      .on('accounts')
      .noActionOnUpdate()
      .build()
    expect(noActionTable.account_id.references).toEqual({
      table: 'accounts',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'no action' })

    const nullDeleteTable = new TableDefinitionBuilder('null_delete_users')
      .integer('owner_id')
      .foreign('owner_id')
      .references('id')
      .on('owners')
      .nullOnDelete()
      .build()
    expect(nullDeleteTable.owner_id.references).toEqual({
      table: 'owners',
      column: 'id',
      onDelete: 'set null',
      onUpdate: undefined })

    const noActionDeleteTable = new TableDefinitionBuilder('no_action_delete_users')
      .integer('status_id')
      .foreign('status_id')
      .references('id')
      .on('statuses')
      .noActionOnDelete()
      .build()
    expect(noActionDeleteTable.status_id.references).toEqual({
      table: 'statuses',
      column: 'id',
      onDelete: 'no action',
      onUpdate: undefined })

    const constrainedTable = new TableDefinitionBuilder('constrained_users')
      .integer('team_id')
      .foreign('team_id')
      .constrained('teams')
      .build()
    expect(constrainedTable.team_id.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })

    const inferredConstrainedTable = new TableDefinitionBuilder('inferred_constrained_users')
      .integer('member_id')
      .foreign('member_id')
      .constrained()
      .build()
    expect(inferredConstrainedTable.member_id.references).toEqual({
      table: 'members',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })

    const inferredCategoryTable = new TableDefinitionBuilder('inferred_category_memberships')
      .integer('category_id')
      .foreign('category_id')
      .constrained()
      .build()
    expect(inferredCategoryTable.category_id.references).toEqual({
      table: 'categories',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })

    const restrictDeleteTable = new TableDefinitionBuilder('restrict_delete_users')
      .integer('role_id')
      .foreign('role_id')
      .references('id')
      .on('roles')
      .restrictOnDelete()
      .build()
    expect(restrictDeleteTable.role_id.references).toEqual({
      table: 'roles',
      column: 'id',
      onDelete: 'restrict',
      onUpdate: undefined })
  })

  it('covers the table-mutation builder surface directly', () => {
    const builder = new TableMutationBuilder('users')
    builder.id('user_id').generated().primaryKey()
    builder.autoIncrementId('legacy_id')
    builder.integer('account_id')
    builder.foreignId('team_id').constrained('teams').cascadeOnDelete()
    builder.foreignUuid('account_uuid').constrained('accounts', 'uuid')
    builder.foreignUlid('session_ulid').constrained('sessions')
    builder.foreignSnowflake('actor_snowflake').constrained('actors', 'snowflake_id')
    builder.bigInteger('login_count')
    builder.string('email').notNull().unique()
    builder.string('display_name').nullable()
    builder.text('bio')
    builder.boolean('active').default(true)
    builder.real('score')
    builder.decimal('amount')
    builder.date('starts_on')
    builder.datetime('published_at')
    builder.timestamp('archived_at').defaultNow()
    builder.json('settings')
    builder.blob('payload')
    builder.uuid('public_id')
    builder.ulid('trace_id')
    builder.snowflake('snowflake_id')
    builder.vector('embedding', { dimensions: 4 })
    builder.enum('status_code', ['pending', 'completed'] as const).change()

    builder.dropColumn('legacy_name')
    builder.renameColumn('display_name', 'full_name')
    builder.index(['account_id'], 'users_account_idx')
    builder.unique(['public_id'], 'users_public_id_unique')
    builder.dropIndex('users_account_idx')
    builder.renameIndex('users_public_id_unique', 'users_public_lookup')
    builder.foreign('account_id', 'users_account_id_foreign').references('id').on('accounts')
    builder.dropForeign('users_account_id_foreign')

    expect(builder.table).toBe('users')
    expect(builder.getOperations()).toEqual([
      expect.objectContaining({ kind: 'addColumn', columnName: 'user_id' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'legacy_id' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'account_id' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'team_id' }),
      { kind: 'createForeignKey', columnName: 'team_id', reference: { table: 'teams', column: 'id', onDelete: 'cascade', onUpdate: undefined }, constraintName: undefined },
      expect.objectContaining({ kind: 'addColumn', columnName: 'account_uuid' }),
      { kind: 'createForeignKey', columnName: 'account_uuid', reference: { table: 'accounts', column: 'uuid', onDelete: undefined, onUpdate: undefined }, constraintName: undefined },
      expect.objectContaining({ kind: 'addColumn', columnName: 'session_ulid' }),
      { kind: 'createForeignKey', columnName: 'session_ulid', reference: { table: 'sessions', column: 'id', onDelete: undefined, onUpdate: undefined }, constraintName: undefined },
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor_snowflake' }),
      { kind: 'createForeignKey', columnName: 'actor_snowflake', reference: { table: 'actors', column: 'snowflake_id', onDelete: undefined, onUpdate: undefined }, constraintName: undefined },
      expect.objectContaining({ kind: 'addColumn', columnName: 'login_count' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'email' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'display_name' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'bio' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'active' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'score' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'amount' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'starts_on' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'published_at' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'archived_at' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'settings' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'payload' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'public_id' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'trace_id' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'snowflake_id' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'embedding' }),
      expect.objectContaining({ kind: 'alterColumn', columnName: 'status_code' }),
      { kind: 'dropColumn', columnName: 'legacy_name' },
      { kind: 'renameColumn', fromColumnName: 'display_name', toColumnName: 'full_name' },
      { kind: 'createIndex', index: { columns: ['account_id'], name: 'users_account_idx', unique: false } },
      { kind: 'createIndex', index: { columns: ['public_id'], name: 'users_public_id_unique', unique: true } },
      { kind: 'dropIndex', indexName: 'users_account_idx' },
      { kind: 'renameIndex', fromIndexName: 'users_public_id_unique', toIndexName: 'users_public_lookup' },
      { kind: 'createForeignKey', columnName: 'account_id', reference: { table: 'accounts', column: 'id' }, constraintName: 'users_account_id_foreign' },
      { kind: 'dropForeignKey', constraintName: 'users_account_id_foreign' },
    ])
  })

  it('supports chained foreign key helpers', () => {
    const builder = new TableMutationBuilder('users')

    builder.foreign('team_id').constrained().cascadeOnDelete().nullOnUpdate()
    builder.foreign('ownerId').constrained().noActionOnDelete().noActionOnUpdate()
    builder.foreign('account_id', 'users_account_uuid_foreign').constrained('accounts', 'uuid')
    builder.foreign('manager_id').references('id').on('users').nullOnDelete().cascadeOnUpdate()
    builder.foreign('status').constrained().restrictOnDelete().restrictOnUpdate()

    expect(builder.getOperations()).toEqual([
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'team_id',
        reference: {
          table: 'teams',
          column: 'id',
          onDelete: 'cascade',
          onUpdate: 'set null' } }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'ownerId',
        reference: {
          table: 'owners',
          column: 'id',
          onDelete: 'no action',
          onUpdate: 'no action' } }),
      {
        kind: 'createForeignKey',
        columnName: 'account_id',
        reference: {
          table: 'accounts',
          column: 'uuid' },
        constraintName: 'users_account_uuid_foreign' },
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'manager_id',
        reference: {
          table: 'users',
          column: 'id',
          onDelete: 'set null',
          onUpdate: 'cascade' } }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'status',
        reference: {
          table: 'statuses',
          column: 'id',
          onDelete: 'restrict',
          onUpdate: 'restrict' } }),
    ])
  })

  it('covers the fluent foreignId create-table builder surface directly', () => {
    const table = new TableDefinitionBuilder('memberships')
      .foreignId('team_id').constrained().cascadeOnDelete().nullOnUpdate()
      .foreignUuid('account_uuid').constrained('accounts', 'uuid')
      .foreignUlid('session_ulid').constrained('sessions')
      .foreignSnowflake('actor_snowflake').constrained('actors', 'snowflake_id')
      .foreignId('ownerId').constrained().noActionOnDelete().noActionOnUpdate()
      .foreignId('account_id').constrained('accounts', 'uuid')
      .foreignId('manager_id').references('id').on('users').nullOnDelete().cascadeOnUpdate()
      .foreignId('status').constrained().restrictOnDelete().restrictOnUpdate()
      .foreignId('company_id').references('id').on('companies').cascadeOnDelete()
      .foreignId('region_id').references('id').on('regions').restrictOnUpdate()
      .build()

    expect(table.team_id.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: 'set null' })
    expect(table.account_uuid.kind).toBe('uuid')
    expect(table.account_uuid.references).toEqual({
      table: 'accounts',
      column: 'uuid',
      onDelete: undefined,
      onUpdate: undefined })
    expect(table.session_ulid.kind).toBe('ulid')
    expect(table.session_ulid.references).toEqual({
      table: 'sessions',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(table.actor_snowflake.kind).toBe('snowflake')
    expect(table.actor_snowflake.references).toEqual({
      table: 'actors',
      column: 'snowflake_id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(table.ownerId.references).toEqual({
      table: 'owners',
      column: 'id',
      onDelete: 'no action',
      onUpdate: 'no action' })
    expect(table.account_id.references).toEqual({
      table: 'accounts',
      column: 'uuid',
      onDelete: undefined,
      onUpdate: undefined })
    expect(table.manager_id.references).toEqual({
      table: 'users',
      column: 'id',
      onDelete: 'set null',
      onUpdate: 'cascade' })
    expect(table.status.references).toEqual({
      table: 'statuses',
      column: 'id',
      onDelete: 'restrict',
      onUpdate: 'restrict' })
    expect(table.company_id.references).toEqual({
      table: 'companies',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: undefined })
    expect(table.region_id.references).toEqual({
      table: 'regions',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'restrict' })
  })

  it('covers the foreignId mutation builder surface directly', () => {
    const builder = new TableMutationBuilder('memberships')

    builder.string('label').foreignId('group_id').constrained('groups')
    builder.foreignId('team_id').constrained().cascadeOnDelete().nullOnUpdate()
    builder.foreignUuid('account_uuid').constrained('accounts', 'uuid')
    builder.foreignUlid('session_ulid').constrained('sessions')
    builder.foreignSnowflake('actor_snowflake').constrained('actors', 'snowflake_id')
    builder.foreignId('ownerId').constrained().noActionOnDelete().noActionOnUpdate()
    builder.foreignId('account_id').constrained('accounts', 'uuid')
    builder.foreignId('manager_id').references('id').on('users').nullOnDelete().cascadeOnUpdate()
    builder.foreignId('status').constrained().restrictOnDelete().restrictOnUpdate()
    builder.foreignId('company_id').references('id').on('companies').cascadeOnDelete()
    builder.foreignId('division_id').references('id').on('divisions').restrictOnUpdate()

    expect(builder.getOperations()).toEqual([
      expect.objectContaining({ kind: 'addColumn', columnName: 'label' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'group_id' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'group_id',
        reference: {
          table: 'groups',
          column: 'id',
          onDelete: undefined,
          onUpdate: undefined } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'team_id' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'team_id',
        reference: {
          table: 'teams',
          column: 'id',
          onDelete: 'cascade',
          onUpdate: 'set null' } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'account_uuid' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'account_uuid',
        reference: {
          table: 'accounts',
          column: 'uuid',
          onDelete: undefined,
          onUpdate: undefined } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'session_ulid' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'session_ulid',
        reference: {
          table: 'sessions',
          column: 'id',
          onDelete: undefined,
          onUpdate: undefined } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor_snowflake' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'actor_snowflake',
        reference: {
          table: 'actors',
          column: 'snowflake_id',
          onDelete: undefined,
          onUpdate: undefined } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'ownerId' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'ownerId',
        reference: {
          table: 'owners',
          column: 'id',
          onDelete: 'no action',
          onUpdate: 'no action' } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'account_id' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'account_id',
        reference: {
          table: 'accounts',
          column: 'uuid',
          onDelete: undefined,
          onUpdate: undefined } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'manager_id' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'manager_id',
        reference: {
          table: 'users',
          column: 'id',
          onDelete: 'set null',
          onUpdate: 'cascade' } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'status' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'status',
        reference: {
          table: 'statuses',
          column: 'id',
          onDelete: 'restrict',
          onUpdate: 'restrict' } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'company_id' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'company_id',
        reference: {
          table: 'companies',
          column: 'id',
          onDelete: 'cascade',
          onUpdate: undefined } }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'division_id' }),
      expect.objectContaining({
        kind: 'createForeignKey',
        columnName: 'division_id',
        reference: {
          table: 'divisions',
          column: 'id',
          onDelete: undefined,
          onUpdate: 'restrict' } }),
    ])
  })

  it('supports chained foreignUuid, foreignUlid, and foreignSnowflake mutation helpers from a column builder', () => {
    const builder = new TableMutationBuilder('audit_entries')

    builder.string('label').foreignUuid('user_id').constrained('users')
    builder.string('token').foreignUlid('session_id').constrained('sessions')
    builder.string('actor').foreignSnowflake('actor_id').constrained('actors', 'snowflake_id')

    expect(builder.getOperations()).toEqual([
      expect.objectContaining({ kind: 'addColumn', columnName: 'label' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'user_id' }),
      {
        kind: 'createForeignKey',
        columnName: 'user_id',
        reference: {
          table: 'users',
          column: 'id',
          onDelete: undefined,
          onUpdate: undefined },
        constraintName: undefined },
      expect.objectContaining({ kind: 'addColumn', columnName: 'token' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'session_id' }),
      {
        kind: 'createForeignKey',
        columnName: 'session_id',
        reference: {
          table: 'sessions',
          column: 'id',
          onDelete: undefined,
          onUpdate: undefined },
        constraintName: undefined },
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor_id' }),
      {
        kind: 'createForeignKey',
        columnName: 'actor_id',
        reference: {
          table: 'actors',
          column: 'snowflake_id',
          onDelete: undefined,
          onUpdate: undefined },
        constraintName: undefined },
    ])
  })

  it('supports morph helper columns on table-mutation builders', () => {
    const builder = new TableMutationBuilder('activities')

    builder.morphs('subject')
    builder.uuidMorphs('owner')
    builder.ulidMorphs('session')
    builder.snowflakeMorphs('actor')
    builder.nullableMorphs('commentable')
    builder.nullableUuidMorphs('auditable')
    builder.nullableUlidMorphs('traceable')
    builder.nullableSnowflakeMorphs('operator')

    expect(builder.getOperations()).toEqual([
      expect.objectContaining({ kind: 'addColumn', columnName: 'subject_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'subject_id' }),
      { kind: 'createIndex', index: { columns: ['subject_type', 'subject_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'owner_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'owner_id' }),
      { kind: 'createIndex', index: { columns: ['owner_type', 'owner_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'session_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'session_id' }),
      { kind: 'createIndex', index: { columns: ['session_type', 'session_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor_id' }),
      { kind: 'createIndex', index: { columns: ['actor_type', 'actor_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'commentable_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'commentable_id' }),
      { kind: 'createIndex', index: { columns: ['commentable_type', 'commentable_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'auditable_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'auditable_id' }),
      { kind: 'createIndex', index: { columns: ['auditable_type', 'auditable_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'traceable_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'traceable_id' }),
      { kind: 'createIndex', index: { columns: ['traceable_type', 'traceable_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'operator_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'operator_id' }),
      { kind: 'createIndex', index: { columns: ['operator_type', 'operator_id'], name: undefined, unique: false } },
    ])
  })

  it('supports chained morph helper columns from a mutation column builder', () => {
    const builder = new TableMutationBuilder('activities')

    builder
      .string('label')
      .morphs('attachable')
      .nullableMorphs('commentable')
      .uuidMorphs('owner')
      .nullableUuidMorphs('auditable')
      .ulidMorphs('session')
      .nullableUlidMorphs('traceable')
      .snowflakeMorphs('actor')
      .nullableSnowflakeMorphs('operator')

    expect(builder.getOperations()).toEqual([
      expect.objectContaining({ kind: 'addColumn', columnName: 'label' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'attachable_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'attachable_id' }),
      { kind: 'createIndex', index: { columns: ['attachable_type', 'attachable_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'commentable_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'commentable_id' }),
      { kind: 'createIndex', index: { columns: ['commentable_type', 'commentable_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'owner_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'owner_id' }),
      { kind: 'createIndex', index: { columns: ['owner_type', 'owner_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'auditable_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'auditable_id' }),
      { kind: 'createIndex', index: { columns: ['auditable_type', 'auditable_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'session_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'session_id' }),
      { kind: 'createIndex', index: { columns: ['session_type', 'session_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'traceable_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'traceable_id' }),
      { kind: 'createIndex', index: { columns: ['traceable_type', 'traceable_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'actor_id' }),
      { kind: 'createIndex', index: { columns: ['actor_type', 'actor_id'], name: undefined, unique: false } },
      expect.objectContaining({ kind: 'addColumn', columnName: 'operator_type' }),
      expect.objectContaining({ kind: 'addColumn', columnName: 'operator_id' }),
      { kind: 'createIndex', index: { columns: ['operator_type', 'operator_id'], name: undefined, unique: false } },
    ])
  })

  it('covers every morph helper on the mutation column-builder delegate surface', () => {
    expect(new TableMutationBuilder('m1').string('label').morphs('attachable').getOperations()).toHaveLength(4)
    expect(new TableMutationBuilder('m2').string('label').nullableMorphs('commentable').getOperations()).toHaveLength(4)
    expect(new TableMutationBuilder('m3').string('label').uuidMorphs('owner').getOperations()).toHaveLength(4)
    expect(new TableMutationBuilder('a').string('label').nullableUuidMorphs('auditable').getOperations()).toHaveLength(4)
    expect(new TableMutationBuilder('b').string('label').ulidMorphs('session').getOperations()).toHaveLength(4)
    expect(new TableMutationBuilder('c').string('label').nullableUlidMorphs('traceable').getOperations()).toHaveLength(4)
    expect(new TableMutationBuilder('d').string('label').snowflakeMorphs('actor').getOperations()).toHaveLength(4)
    expect(new TableMutationBuilder('e').string('label').nullableSnowflakeMorphs('operator').getOperations()).toHaveLength(4)
  })

  it('rejects malformed schema identifiers at definition time', () => {
    expect(() => defineTable('   ', {
      id: column.id() })).toThrow('Table name must not be empty.')

    expect(() => defineTable('analytics..users', {
      id: column.id() })).toThrow('Table name must not contain empty identifier segments.')

    expect(() => defineTable('users', {
      'bad-name': column.string() } as never)).toThrow('Column name must be a valid SQL identifier segment.')

    expect(() => defineTable('users', {
      id: column.id(),
      email: column.string('email-address') })).toThrow('Column "email" cannot redefine its name as "email-address". Declare one canonical column name only.')

    expect(() => defineTable('users', {
      teamId: column.foreignId().constrained('public..teams') })).toThrow('Foreign key table must not contain empty identifier segments.')

    expect(() => defineTable('users', {
      teamId: column.foreignId().constrained('teams', 'bad-column') })).toThrow('Foreign key column must be a valid SQL identifier segment.')

    expect(() => defineTable('users', {
      id: column.id() }, {
      indexes: [{ name: 'users.email.unique', columns: ['id'], unique: true }] })).toThrow('Index name must be a valid SQL identifier segment.')

    expect(() => defineTable('users', {
      id: column.id() }, {
      indexes: [{ columns: ['bad-column'], unique: false }] })).toThrow('Index column must be a valid SQL identifier segment.')
  })

  it('keeps table definitions assignable to the shared table contract', () => {
    const users = defineTable('users', {
      id: column.id() })

    expectTypeOf<typeof users>().toMatchTypeOf<TableDefinition>()
  })

  it('covers text columns and explicit primary-key modifiers on non-id columns', () => {
    const docs = defineTable('docs', {
      slug: column.string().primaryKey(),
      body: column.text().nullable(),
      checksum: column.string().generated() })

    expect(docs.slug.primaryKey).toBe(true)
    expect(docs.body.kind).toBe('text')
    expect(docs.body.nullable).toBe(true)
    expect(docs.checksum.generated).toBe(true)
  })

  it('supports function-based foreign-key references', () => {
    const teams = defineTable('teams', {
      id: column.id() })

    const users = defineTable('users', {
      teamId: column.foreignId().references(teams.id.name).on(teams.tableName).cascadeOnUpdate() })

    expect(users.teamId.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: undefined,
      onUpdate: 'cascade' })
  })

  it('covers the direct foreignId column helper surface', () => {
    const memberships = defineTable('memberships', {
      team_id: column.foreignId().constrained().cascadeOnDelete().restrictOnUpdate(),
      category_id: column.foreignId().constrained(),
      ownerId: column.foreignId().constrained().nullOnDelete().noActionOnUpdate(),
      status: column.foreignId().constrained(),
      company_id: column.foreignId().references('uuid').on('companies').noActionOnDelete().nullOnUpdate(),
      role_id: column.foreignId().constrained('roles').restrictOnDelete().cascadeOnUpdate() })

    expect(memberships.team_id.references).toEqual({
      table: 'teams',
      column: 'id',
      onDelete: 'cascade',
      onUpdate: 'restrict' })
    expect(memberships.category_id.references).toEqual({
      table: 'categories',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(memberships.ownerId.references).toEqual({
      table: 'owners',
      column: 'id',
      onDelete: 'set null',
      onUpdate: 'no action' })
    expect(memberships.status.references).toEqual({
      table: 'statuses',
      column: 'id',
      onDelete: undefined,
      onUpdate: undefined })
    expect(memberships.company_id.references).toEqual({
      table: 'companies',
      column: 'uuid',
      onDelete: 'no action',
      onUpdate: 'set null' })
    expect(memberships.role_id.references).toEqual({
      table: 'roles',
      column: 'id',
      onDelete: 'restrict',
      onUpdate: 'cascade' })
  })
})
