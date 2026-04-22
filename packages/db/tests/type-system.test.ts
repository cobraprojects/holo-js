import { describe, expectTypeOf, it } from 'vitest'
import type { PoolConfig } from 'pg'
import type { PoolOptions } from 'mysql2/promise'
import {
  HasUlids,
  TableDefinitionBuilder,
  belongsToMany,
  belongsTo,
  column,
  createCursorPaginator,
  createPaginator,
  createSimplePaginator,
  defineModel,
  hasMany,
  morphTo,
  unsafeSql,
  type TableQueryBuilder,
  type CursorPaginatedResult,
  type Entity,
  type InferInsert,
  type InferSelect,
  type InferUpdate,
  type MySQLAdapterOptions,
  type ModelCollection,
  type ModelQueryBuilder,
  type PaginatedResult,
  type PostgresAdapterOptions,
  type SimplePaginatedResult } from '../src'
import type { AnyModelDefinition, BelongsToRelationDefinition, ModelRelationPath } from '../src/model/types'
import { defineModelFromTable, defineTable } from './support/internal'

type IsEqual<A, B>
  = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2)
    ? true
    : false

type Assert<T extends true> = T

describe('type system contracts', () => {
  it('infers schema select, insert, and update payloads from one schema definition', () => {
    const users = defineTable('users', {
      id: column.id(),
      public_id: column.ulid(),
      name: column.string(),
      active: column.boolean().default(true),
      settings: column.json<{ locale: string, beta: boolean }>(),
      deleted_at: column.timestamp().nullable() })

    type UserSelect = InferSelect<typeof users>
    type UserInsert = InferInsert<typeof users>
    type UserUpdate = InferUpdate<typeof users>

    const selectId: Assert<IsEqual<UserSelect['id'], number>> = true
    const selectPublicId: Assert<IsEqual<UserSelect['public_id'], string>> = true
    const selectName: Assert<IsEqual<UserSelect['name'], string>> = true
    const selectActive: Assert<IsEqual<UserSelect['active'], boolean>> = true
    const selectSettings: Assert<IsEqual<UserSelect['settings'], { locale: string, beta: boolean }>> = true
    const selectDeletedAt: Assert<IsEqual<UserSelect['deleted_at'], Date | null>> = true

    const insertPublicId: Assert<IsEqual<UserInsert['public_id'], string>> = true
    const insertName: Assert<IsEqual<UserInsert['name'], string>> = true
    const insertSettings: Assert<IsEqual<UserInsert['settings'], { locale: string, beta: boolean }>> = true
    const insertDeletedAt: Assert<IsEqual<UserInsert['deleted_at'], Date | null>> = true
    const insertActive: Assert<IsEqual<UserInsert['active'], boolean | undefined>> = true
    const insertId: Assert<IsEqual<UserInsert['id'], number | undefined>> = true

    const updatePublicId: Assert<IsEqual<UserUpdate['public_id'], string | undefined>> = true
    const updateDeletedAt: Assert<IsEqual<UserUpdate['deleted_at'], Date | null | undefined>> = true

    void selectId
    void selectPublicId
    void selectName
    void selectActive
    void selectSettings
    void selectDeletedAt
    void insertPublicId
    void insertName
    void insertSettings
    void insertDeletedAt
    void insertActive
    void insertId
    void updatePublicId
    void updateDeletedAt
  })

  it('infers every logical column family with the expected TypeScript surface', () => {
    const examples = defineTable('examples', {
      id: column.id(),
      integerValue: column.integer(),
      bigIntegerValue: column.bigInteger(),
      stringValue: column.string(),
      textValue: column.text(),
      booleanValue: column.boolean(),
      realValue: column.real(),
      decimalValue: column.decimal(),
      dateValue: column.date(),
      datetimeValue: column.datetime(),
      timestampValue: column.timestamp(),
      jsonValue: column.json<{ enabled: boolean, tags: string[] }>(),
      blobValue: column.blob(),
      uuidValue: column.uuid(),
      ulidValue: column.ulid(),
      snowflakeValue: column.snowflake(),
      vectorValue: column.vector({ dimensions: 3 }),
      enumValue: column.enum(['draft', 'published'] as const) })

    type ExampleSelect = InferSelect<typeof examples>
    type ExampleInsert = InferInsert<typeof examples>
    type ExampleUpdate = InferUpdate<typeof examples>

    const selectInteger: Assert<IsEqual<ExampleSelect['integerValue'], number>> = true
    const selectBigInteger: Assert<IsEqual<ExampleSelect['bigIntegerValue'], number>> = true
    const selectString: Assert<IsEqual<ExampleSelect['stringValue'], string>> = true
    const selectText: Assert<IsEqual<ExampleSelect['textValue'], string>> = true
    const selectBoolean: Assert<IsEqual<ExampleSelect['booleanValue'], boolean>> = true
    const selectReal: Assert<IsEqual<ExampleSelect['realValue'], number>> = true
    const selectDecimal: Assert<IsEqual<ExampleSelect['decimalValue'], string>> = true
    const selectDate: Assert<IsEqual<ExampleSelect['dateValue'], Date>> = true
    const selectDatetime: Assert<IsEqual<ExampleSelect['datetimeValue'], Date>> = true
    const selectTimestamp: Assert<IsEqual<ExampleSelect['timestampValue'], Date>> = true
    const selectJson: Assert<IsEqual<ExampleSelect['jsonValue'], { enabled: boolean, tags: string[] }>> = true
    const selectBlob: Assert<IsEqual<ExampleSelect['blobValue'], Uint8Array>> = true
    const selectUuid: Assert<IsEqual<ExampleSelect['uuidValue'], string>> = true
    const selectUlid: Assert<IsEqual<ExampleSelect['ulidValue'], string>> = true
    const selectSnowflake: Assert<IsEqual<ExampleSelect['snowflakeValue'], string>> = true
    const selectVector: Assert<IsEqual<ExampleSelect['vectorValue'], readonly number[]>> = true
    const selectEnum: Assert<IsEqual<ExampleSelect['enumValue'], 'draft' | 'published'>> = true

    const insertDecimal: Assert<IsEqual<ExampleInsert['decimalValue'], string>> = true
    const insertBlob: Assert<IsEqual<ExampleInsert['blobValue'], Uint8Array>> = true
    const insertVector: Assert<IsEqual<ExampleInsert['vectorValue'], readonly number[]>> = true
    const insertEnum: Assert<IsEqual<ExampleInsert['enumValue'], 'draft' | 'published'>> = true
    const optionalId: Assert<IsEqual<ExampleInsert['id'], number | undefined>> = true

    const updateDecimal: Assert<IsEqual<ExampleUpdate['decimalValue'], string | undefined>> = true
    const updateBlob: Assert<IsEqual<ExampleUpdate['blobValue'], Uint8Array | undefined>> = true
    const updateVector: Assert<IsEqual<ExampleUpdate['vectorValue'], readonly number[] | undefined>> = true
    const updateEnum: Assert<IsEqual<ExampleUpdate['enumValue'], 'draft' | 'published' | undefined>> = true

    void selectInteger
    void selectBigInteger
    void selectString
    void selectText
    void selectBoolean
    void selectReal
    void selectDecimal
    void selectDate
    void selectDatetime
    void selectTimestamp
    void selectJson
    void selectBlob
    void selectUuid
    void selectUlid
    void selectSnowflake
    void selectVector
    void selectEnum
    void insertDecimal
    void insertBlob
    void insertVector
    void insertEnum
    void optionalId
    void updateDecimal
    void updateBlob
    void updateVector
    void updateEnum
  })

  it('carries fluent create-table builder column types through the chain', () => {
    const table = new TableDefinitionBuilder('users')
      .id()
      .string('email')
      .foreignUuid('account_uuid').constrained('accounts', 'uuid')
      .foreignUlid('session_ulid').constrained('sessions')
      .foreignSnowflake('actor_snowflake').constrained('actors', 'snowflake_id')
      .enum('status', ['pending', 'completed'] as const)
      .timestamps()
      .softDeletes()
      .build()

    type TableSelect = InferSelect<typeof table>
    type TableInsert = InferInsert<typeof table>

    const selectId: Assert<IsEqual<TableSelect['id'], number>> = true
    const selectEmail: Assert<IsEqual<TableSelect['email'], string>> = true
    const selectAccountUuid: Assert<IsEqual<TableSelect['account_uuid'], string>> = true
    const selectSessionUlid: Assert<IsEqual<TableSelect['session_ulid'], string>> = true
    const selectActorSnowflake: Assert<IsEqual<TableSelect['actor_snowflake'], string>> = true
    const selectStatus: Assert<IsEqual<TableSelect['status'], 'pending' | 'completed'>> = true
    const selectCreatedAt: Assert<IsEqual<TableSelect['created_at'], Date>> = true
    const selectUpdatedAt: Assert<IsEqual<TableSelect['updated_at'], Date>> = true
    const selectDeletedAt: Assert<IsEqual<TableSelect['deleted_at'], Date | null>> = true
    const insertId: Assert<IsEqual<TableInsert['id'], number | undefined>> = true
    const insertEmail: Assert<IsEqual<TableInsert['email'], string>> = true
    const insertAccountUuid: Assert<IsEqual<TableInsert['account_uuid'], string>> = true
    const insertSessionUlid: Assert<IsEqual<TableInsert['session_ulid'], string>> = true
    const insertActorSnowflake: Assert<IsEqual<TableInsert['actor_snowflake'], string>> = true
    const insertStatus: Assert<IsEqual<TableInsert['status'], 'pending' | 'completed'>> = true

    void selectId
    void selectEmail
    void selectAccountUuid
    void selectSessionUlid
    void selectActorSnowflake
    void selectStatus
    void selectCreatedAt
    void selectUpdatedAt
    void selectDeletedAt
    void insertId
    void insertEmail
    void insertAccountUuid
    void insertSessionUlid
    void insertActorSnowflake
    void insertStatus
  })

  it('infers morph helper columns through the create-table builder', () => {
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

    type TableSelect = InferSelect<typeof table>

    const subjectType: Assert<IsEqual<TableSelect['subject_type'], string>> = true
    const subjectId: Assert<IsEqual<TableSelect['subject_id'], number>> = true
    const ownerId: Assert<IsEqual<TableSelect['owner_id'], string>> = true
    const sessionId: Assert<IsEqual<TableSelect['session_id'], string>> = true
    const actorId: Assert<IsEqual<TableSelect['actor_id'], string>> = true
    const commentableType: Assert<IsEqual<TableSelect['commentable_type'], string | null>> = true
    const commentableId: Assert<IsEqual<TableSelect['commentable_id'], number | null>> = true
    const auditableId: Assert<IsEqual<TableSelect['auditable_id'], string | null>> = true
    const traceableId: Assert<IsEqual<TableSelect['traceable_id'], string | null>> = true
    const operatorId: Assert<IsEqual<TableSelect['operator_id'], string | null>> = true

    void subjectType
    void subjectId
    void ownerId
    void sessionId
    void actorId
    void commentableType
    void commentableId
    void auditableId
    void traceableId
    void operatorId
  })

  it('types model statics, entities, scopes, and pagination results', () => {
    const users = defineTable('users', {
      id: column.id(),
      public_id: column.ulid().unique(),
      team_id: column.integer(),
      name: column.string(),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
      deleted_at: column.timestamp().nullable() })

    const teams = defineTable('teams', {
      id: column.id(),
      name: column.string() })

    const Team = defineModelFromTable(teams)
    const User = defineModelFromTable<typeof users, {
      recent: (query: ModelQueryBuilder<typeof users>, days: number) => ModelQueryBuilder<typeof users>
    }>(users, {
      traits: [HasUlids<typeof users>({ columns: ['public_id'] })],
      softDeletes: true,
      timestamps: true,
      pendingAttributes: {
        name: 'pending' },
      scopes: {
        recent(query: ModelQueryBuilder<typeof users>, days: number) {
          return query.where('created_at', '>=', days)
        } } as const,
      relations: {
        team: belongsTo(() => Team, 'team_id') } })
    const RelatedUser = defineModelFromTable(users, {
      relations: {
        team: belongsTo(() => Team, 'team_id') } })

    type UserEntity = Entity<typeof users>
    type UserRelations = typeof User.definition.relations
    type RelatedUserRelations = typeof RelatedUser.definition.relations
    type FindReturn = Awaited<ReturnType<typeof User.find>>
    type QueryGetReturn = Awaited<ReturnType<ReturnType<typeof User.query>['get']>>
    type PaginateReturn = Awaited<ReturnType<ReturnType<typeof User.query>['paginate']>>
    type SimplePaginateReturn = Awaited<ReturnType<ReturnType<typeof User.query>['simplePaginate']>>
    type CursorPaginateReturn = Awaited<ReturnType<ReturnType<typeof User.query>['cursorPaginate']>>
    // load/loadMissing are now generic — test them inline in the if(false) block below
    type CollectionFreshReturn = Awaited<ReturnType<ModelCollection<typeof users, UserRelations>['fresh']>>
    type CollectionToQueryReturn = ReturnType<ModelCollection<typeof users, UserRelations>['toQuery']>
    type CountReturn = Awaited<ReturnType<ReturnType<typeof User.query>['count']>>
    type AvgReturn = Awaited<ReturnType<ReturnType<typeof User.query>['avg']>>
    type MinReturn = Awaited<ReturnType<ReturnType<typeof User.query>['min']>>
    type MaxReturn = Awaited<ReturnType<ReturnType<typeof User.query>['max']>>
    type WithCountReturn = ReturnType<typeof User.withCount>
    type WithExistsReturn = ReturnType<typeof User.withExists>
    type WithSumReturn = ReturnType<typeof User.withSum>
    type GroupedReturn = ReturnType<ReturnType<typeof User.query>['groupBy']>
    type CreatePayload = Parameters<typeof User.create>[0]
    type MakePayload = NonNullable<Parameters<typeof User.make>[0]>
    expectTypeOf<FindReturn>().toEqualTypeOf<UserEntity | undefined>()
    expectTypeOf<QueryGetReturn>().toMatchTypeOf<ModelCollection<typeof users, UserRelations>>()
    expectTypeOf<QueryGetReturn>().toMatchTypeOf<readonly UserEntity[]>()
    expectTypeOf<PaginateReturn>().toMatchTypeOf<PaginatedResult<UserEntity>>()
    expectTypeOf<SimplePaginateReturn>().toMatchTypeOf<SimplePaginatedResult<UserEntity>>()
    expectTypeOf<CursorPaginateReturn>().toMatchTypeOf<CursorPaginatedResult<UserEntity>>()
    expectTypeOf<CollectionFreshReturn>().toEqualTypeOf<ModelCollection<typeof users, UserRelations>>()
    expectTypeOf<CollectionToQueryReturn>().toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
    expectTypeOf<CountReturn>().toEqualTypeOf<number>()
    expectTypeOf<AvgReturn>().toEqualTypeOf<number | null>()
    expectTypeOf<MinReturn>().toEqualTypeOf<number | null>()
    expectTypeOf<MaxReturn>().toEqualTypeOf<number | null>()
    expectTypeOf<WithCountReturn>().toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
    expectTypeOf<WithExistsReturn>().toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
    expectTypeOf<WithSumReturn>().toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
    expectTypeOf<GroupedReturn>().toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
    const createName: Assert<IsEqual<CreatePayload['name'], string>> = true
    const createTeamId: Assert<IsEqual<CreatePayload['team_id'], number>> = true
    const createId: Assert<IsEqual<CreatePayload['id'], number | undefined>> = true
    const createCreatedAt: Assert<IsEqual<CreatePayload['created_at'], Date>> = true
    const makeName: Assert<IsEqual<MakePayload['name'], string | undefined>> = true
    expectTypeOf(User.recent).toBeFunction()
    expectTypeOf(User.definition.pendingAttributes).toMatchTypeOf<Partial<InferInsert<typeof users>>>()
    const paginated = createPaginator<UserEntity>([], {
      total: 0,
      perPage: 15,
      currentPage: 1,
      lastPage: 1,
      from: null,
      to: null,
      hasMorePages: false })
    const simplePaginated = createSimplePaginator<UserEntity>([], {
      perPage: 15,
      currentPage: 1,
      from: null,
      to: null,
      hasMorePages: false })
    const cursorPaginated = createCursorPaginator<UserEntity>([], {
      perPage: 15,
      nextCursor: null,
      prevCursor: null })

    expectTypeOf(paginated.data).toEqualTypeOf<readonly UserEntity[]>()
    expectTypeOf(simplePaginated.data).toEqualTypeOf<readonly UserEntity[]>()
    expectTypeOf(cursorPaginated.data).toEqualTypeOf<readonly UserEntity[]>()
    expectTypeOf(paginated.meta.pageName).toEqualTypeOf<string>()
    expectTypeOf(cursorPaginated.cursorName).toEqualTypeOf<string>()
    expectTypeOf(paginated.items()).toEqualTypeOf<readonly UserEntity[]>()
    expectTypeOf(simplePaginated.getPageName()).toEqualTypeOf<string>()
    expectTypeOf(cursorPaginated.nextCursorToken()).toEqualTypeOf<string | null>()
    void createName
    void createTeamId
    void createId
    void createCreatedAt
    void makeName

    if (false) {
      const entity = undefined as unknown as Entity<typeof users, RelatedUserRelations>
      const collection = undefined as unknown as ModelCollection<typeof users, RelatedUserRelations>
      const query = RelatedUser.query()

      expectTypeOf(RelatedUser.with('team')).toMatchTypeOf<ModelQueryBuilder<typeof users, RelatedUserRelations>>()
      expectTypeOf(query.with('team')).toMatchTypeOf<ModelQueryBuilder<typeof users, RelatedUserRelations>>()
      expectTypeOf(query.with('team.members')).toMatchTypeOf<ModelQueryBuilder<typeof users, RelatedUserRelations>>()
      expectTypeOf(entity.id).toEqualTypeOf<number>()
      expectTypeOf(entity.name).toEqualTypeOf<string>()
      expectTypeOf(entity.public_id).toEqualTypeOf<string>()
      expectTypeOf(entity.created_at).toEqualTypeOf<Date>()
      expectTypeOf(entity.deleted_at).toEqualTypeOf<Date | null>()
      void query.where('name', '=', 'A')
      void query.orderBy('created_at')
      expectTypeOf(entity.load('team')).toMatchTypeOf<Promise<Entity<typeof users, RelatedUserRelations>>>()
      expectTypeOf(collection.load('team')).toMatchTypeOf<Promise<ModelCollection<typeof users, RelatedUserRelations>>>()

      // @ts-expect-error invalid relation names should be rejected on model statics
      RelatedUser.with('missing')
      // @ts-expect-error invalid relation names should be rejected on query builders
      query.with('missing')
      // @ts-expect-error invalid model column names should be rejected on query builders
      query.where('missing', '=', 1)
      // @ts-expect-error invalid model order-by column names should be rejected on query builders
      query.orderBy('missing')
      // @ts-expect-error invalid entity property names should be rejected
      void entity.missing
      // @ts-expect-error invalid relation names should be rejected on entities
      entity.load('missing')
      // @ts-expect-error invalid relation names should be rejected on collections
      collection.load('missing')
    }
  })

  it('narrows table-query result types from selected columns', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      active: column.boolean(),
      created_at: column.timestamp() })

    if (false) {
      const builder = undefined as unknown as TableQueryBuilder<typeof users>
      const narrowed = builder.select('id', 'name')
      const activeOnly = builder.select('active')
      const cached = builder.cache(300)
      const widened = builder.select('id').addSelect('name')
      const aliased = builder.select('name as displayName')
      const grouped = builder
        .select('name')
        .addSelectCount('total')
        .addSelectSum('totalScore', 'id')
        .groupBy('name')
      const groupedRows = grouped.get()

      expectTypeOf(narrowed.get()).toEqualTypeOf<Promise<Array<{ id: number, name: string }>>>()
      expectTypeOf(narrowed.first()).toEqualTypeOf<Promise<{ id: number, name: string } | undefined>>()
      expectTypeOf(narrowed.paginate()).toEqualTypeOf<Promise<PaginatedResult<{ id: number, name: string }>>>()
      expectTypeOf(cached.get()).toEqualTypeOf<Promise<Array<{ id: number, name: string, active: boolean, created_at: Date }>>>()
      expectTypeOf(narrowed.pluck('id')).toEqualTypeOf<Promise<number[]>>()
      expectTypeOf(activeOnly.value('active')).toEqualTypeOf<Promise<boolean | undefined>>()
      expectTypeOf(aliased.get()).toEqualTypeOf<Promise<Array<Record<string, unknown>>>>()
      expectTypeOf(groupedRows).toMatchTypeOf<Promise<Array<{ name: string, total: number, totalScore: number | null }>>>()
      void cached
      void widened
      void aliased
      void grouped
      void groupedRows

      // @ts-expect-error invalid typed table column should be rejected
      builder.where('missing', '=', 1)
      // @ts-expect-error invalid typed table ordering column should be rejected
      builder.orderBy('missing')
      // @ts-expect-error invalid typed table select column should be rejected
      builder.select('missing')
      // @ts-expect-error narrowed row should not expose omitted columns
      narrowed.pluck('active')
    }
  })

  it('rejects invalid model keys at compile time', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp() })

    defineModelFromTable(users, {
      fillable: ['name'],
      pendingAttributes: {
        name: 'ok' } })

    defineModelFromTable(users, {
      // @ts-expect-error invalid fillable key should be rejected
      fillable: ['missing'] })

    defineModelFromTable(users, {
      pendingAttributes: {
        // @ts-expect-error invalid pending attribute key should be rejected
        missing: 'value' } })
  })

  it('types static model helpers, relation aggregates, and pivot APIs with exact keys', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      settings: column.json<{ tags: string[] }>(),
      embedding: column.vector({ dimensions: 3 }),
      created_at: column.timestamp(),
      updated_at: column.timestamp(),
    })
    const posts = defineTable('posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string(),
      score: column.integer(),
    })
    const roles = defineTable('roles', {
      id: column.id(),
      name: column.string(),
      weight: column.integer(),
    })
    const roleUsers = defineTable('role_user', {
      user_id: column.integer(),
      role_id: column.integer(),
      approved: column.boolean(),
      granted_at: column.timestamp(),
    })

    const Role = defineModelFromTable(roles)
    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'user_id'),
        roles: belongsToMany(() => Role, roleUsers, 'user_id', 'role_id'),
      },
    })

    type UserRelations = typeof User.definition.relations

    if (false) {
      const query = User.query()
      const entity = undefined as unknown as Entity<typeof users, UserRelations>
      const collection = undefined as unknown as ModelCollection<typeof users, UserRelations>
      const rolesRelation = User.definition.relations.roles
      const valuePromise = User.value('name')
      const valueOrFailPromise = User.valueOrFail('name')
      const soleValuePromise = User.soleValue('name')
      const valueResult: Assert<IsEqual<Awaited<typeof valuePromise>, string | undefined>> = true
      const valueOrFailResult: Assert<IsEqual<Awaited<typeof valueOrFailPromise>, string>> = true
      const soleValueResult: Assert<IsEqual<Awaited<typeof soleValuePromise>, string>> = true

      expectTypeOf(User.select('id', 'name')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.addSelect('created_at')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.groupBy('name')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.where('settings->profile->region', 'eu')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.whereJsonContains('settings->tags', 'beta')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.whereVectorSimilarTo('embedding', [0.1, 0.2, 0.3], 0.4)).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.firstWhere('name', 'Amina')).toEqualTypeOf<Promise<Entity<typeof users, UserRelations> | undefined>>()
      expectTypeOf(User.sum('id')).toEqualTypeOf<Promise<number>>()
      expectTypeOf(User.avg('id')).toEqualTypeOf<Promise<number | null>>()
      expectTypeOf(User.min('id')).toEqualTypeOf<Promise<number | null>>()
      expectTypeOf(User.max('id')).toEqualTypeOf<Promise<number | null>>()
      expectTypeOf(User.chunkById(10, () => undefined, 'id')).toEqualTypeOf<Promise<void>>()
      expectTypeOf(User.chunkByIdDesc(10, () => undefined, 'id')).toEqualTypeOf<Promise<void>>()
      expectTypeOf(User.withSum('posts', 'score')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.withAvg('posts', 'score')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.withMin('roles', 'weight')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.withMax('roles', 'weight')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.whereRelation('posts', 'title', 'Hello')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.orWhereRelation('roles', 'name', 'admin')).toEqualTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(entity.loadSum('posts', 'score')).toEqualTypeOf<Promise<Entity<typeof users, UserRelations>>>()
      expectTypeOf(entity.loadAvg('posts', 'score')).toEqualTypeOf<Promise<Entity<typeof users, UserRelations>>>()
      expectTypeOf(entity.loadMin('roles', 'weight')).toEqualTypeOf<Promise<Entity<typeof users, UserRelations>>>()
      expectTypeOf(entity.loadMax('roles', 'weight')).toEqualTypeOf<Promise<Entity<typeof users, UserRelations>>>()
      expectTypeOf(collection.loadSum('posts', 'score')).toEqualTypeOf<Promise<ModelCollection<typeof users, UserRelations>>>()
      expectTypeOf(collection.loadAvg('posts', 'score')).toEqualTypeOf<Promise<ModelCollection<typeof users, UserRelations>>>()
      expectTypeOf(collection.loadMin('roles', 'weight')).toEqualTypeOf<Promise<ModelCollection<typeof users, UserRelations>>>()
      expectTypeOf(collection.loadMax('roles', 'weight')).toEqualTypeOf<Promise<ModelCollection<typeof users, UserRelations>>>()
      void User.increment('id')
      void User.decrement('id')
      void rolesRelation.withPivot('approved', 'granted_at')
      void rolesRelation.wherePivot('approved', '=', true)
      void rolesRelation.orderByPivot('granted_at')
      void valueResult
      void valueOrFailResult
      void soleValueResult
      void query.whereSub('id', 'in', Post.query())
      void query.orWhereSub('id', 'in', Post.query())
      void query.whereInSub('id', Post.query())
      void query.whereNotInSub('id', Post.query())

      // @ts-expect-error invalid static select column should be rejected
      User.select('missing')
      // @ts-expect-error invalid static addSelect column should be rejected
      User.addSelect('missing')
      // @ts-expect-error invalid static groupBy column should be rejected
      User.groupBy('missing')
      // @ts-expect-error invalid static JSON path root should be rejected
      User.whereJsonContains('missing->tags', 'beta')
      // @ts-expect-error invalid shorthand JSON path root should be rejected
      User.where('missing->tags', 'beta')
      // @ts-expect-error invalid vector column should be rejected
      User.whereVectorSimilarTo('missing', [0.1, 0.2, 0.3], 0.4)
      // @ts-expect-error invalid firstWhere column should be rejected
      User.firstWhere('missing', 1)
      // @ts-expect-error invalid value column should be rejected
      User.value('missing')
      // @ts-expect-error invalid valueOrFail column should be rejected
      User.valueOrFail('missing')
      // @ts-expect-error invalid soleValue column should be rejected
      User.soleValue('missing')
      // @ts-expect-error invalid sum column should be rejected
      User.sum('missing')
      // @ts-expect-error invalid avg column should be rejected
      User.avg('missing')
      // @ts-expect-error invalid min column should be rejected
      User.min('missing')
      // @ts-expect-error invalid max column should be rejected
      User.max('missing')
      // @ts-expect-error invalid increment column should be rejected
      User.increment('missing')
      // @ts-expect-error invalid decrement column should be rejected
      User.decrement('missing')
      // @ts-expect-error invalid chunkById column should be rejected
      User.chunkById(10, () => undefined, 'missing')
      // @ts-expect-error invalid chunkByIdDesc column should be rejected
      User.chunkByIdDesc(10, () => undefined, 'missing')
      // @ts-expect-error invalid related aggregate column should be rejected
      User.withSum('posts', 'missing')
      // @ts-expect-error invalid related aggregate column should be rejected
      User.withMax('roles', 'missing')
      // @ts-expect-error invalid relation filter column should be rejected
      User.whereRelation('posts', 'missing', 'Hello')
      // @ts-expect-error invalid relation filter column should be rejected
      User.orWhereRelation('roles', 'missing', 'admin')
      // @ts-expect-error invalid entity aggregate column should be rejected
      entity.loadSum('posts', 'missing')
      // @ts-expect-error invalid collection aggregate column should be rejected
      collection.loadMax('roles', 'missing')
      // @ts-expect-error invalid pivot column should be rejected
      rolesRelation.wherePivot('missing', '=', true)
      // @ts-expect-error invalid pivot ordering column should be rejected
      rolesRelation.orderByPivot('missing')
      // @ts-expect-error invalid whereSub column should be rejected
      query.whereSub('missing', 'in', Post.query())
      // @ts-expect-error invalid whereInSub column should be rejected
      query.whereInSub('missing', Post.query())
    }
  })

  it('makes unsafe raw statements visibly distinct in the type system', () => {
    const statement = unsafeSql('select * from users where id = ?', [1])

    expectTypeOf(statement.unsafe).toEqualTypeOf<true>()

    const acceptUnsafe = (_statement: { unsafe: true, sql: string }) => undefined
    acceptUnsafe(statement)

    // @ts-expect-error raw SQL statements must be explicitly marked unsafe
    acceptUnsafe({ sql: 'select 1' })
  })

  it('resolves typed relation properties through with() and load() eager loading', () => {
    const users = defineTable('users', {
      id: column.id(),
      name: column.string(),
      created_at: column.timestamp(),
    })
    const posts = defineTable('posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string(),
    })
    const comments = defineTable('comments', {
      id: column.id(),
      post_id: column.integer(),
      body: column.text(),
    })
    const profiles = defineTable('profiles', {
      id: column.id(),
      user_id: column.integer(),
      bio: column.text(),
    })

    const Comment = defineModelFromTable(comments)
    const Profile = defineModelFromTable(profiles)
    const Post = defineModelFromTable(posts, {
      relations: {
        comments: hasMany(() => Comment, 'post_id'),
      },
    })
    const User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'user_id'),
        profile: belongsTo(() => Profile, 'user_id'),
      },
    })

    type UserRelations = typeof User.definition.relations

    if (false) {
      // --- with() on query builder produces typed relation properties ---
      const query = User.query().with('posts')
      type WithPostsResult = Awaited<ReturnType<typeof query.first>>
      type PostsProperty = NonNullable<WithPostsResult>['posts']
      const postsArray: Assert<IsEqual<PostsProperty, Entity<typeof posts, typeof Post.definition.relations>[]>> = true
      void postsArray

      // --- nested with() for dot-path resolves nested relations ---
      const nestedQuery = User.query().with('posts.comments')
      type NestedResult = NonNullable<Awaited<ReturnType<typeof nestedQuery.first>>>
      type NestedPosts = NestedResult['posts']
      type NestedPostItem = NestedPosts[number]
      type NestedComments = NestedPostItem['comments']
      const commentsArray: Assert<IsEqual<NestedComments, Entity<typeof comments>[]>> = true
      void commentsArray

      // --- belongsTo (to-one) resolves as T | null ---
      const profileQuery = User.query().with('profile')
      type ProfileResult = NonNullable<Awaited<ReturnType<typeof profileQuery.first>>>
      type ProfileProperty = ProfileResult['profile']
      const profileNullable: Assert<IsEqual<ProfileProperty, Entity<typeof profiles> | null>> = true
      void profileNullable

      // --- column access still works alongside loaded relations ---
      type WithPostsEntity = NonNullable<WithPostsResult>
      const nameType: Assert<IsEqual<WithPostsEntity['name'], string>> = true
      const idType: Assert<IsEqual<WithPostsEntity['id'], number>> = true
      void nameType
      void idType

      // --- load() on entity returns this & loaded relations ---
      const entity = undefined as unknown as Entity<typeof users, UserRelations>
      type LoadResult = Awaited<ReturnType<typeof entity.load<readonly ['posts']>>>
      type LoadedPosts = LoadResult['posts']
      const loadedPostsArray: Assert<IsEqual<LoadedPosts, Entity<typeof posts, typeof Post.definition.relations>[]>> = true
      void loadedPostsArray

      // --- loadMissing() on entity returns this & loaded relations ---
      type LoadMissingResult = Awaited<ReturnType<typeof entity.loadMissing<readonly ['profile']>>>
      type LoadMissingProfile = LoadMissingResult['profile']
      const loadMissingProfile: Assert<IsEqual<LoadMissingProfile, Entity<typeof profiles> | null>> = true
      void loadMissingProfile

      // --- load() supports dotted paths for nested eager loading ---
      type NestedLoadResult = Awaited<ReturnType<typeof entity.load<readonly ['posts.comments']>>>
      type NestedLoadPosts = NestedLoadResult['posts']
      type NestedLoadPostItem = NestedLoadPosts[number]
      type NestedLoadComments = NestedLoadPostItem['comments']
      const nestedLoadComments: Assert<IsEqual<NestedLoadComments, Entity<typeof comments>[]>> = true
      void nestedLoadComments

      // --- with() on static model ---
      expectTypeOf(User.with('posts')).toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()
      expectTypeOf(User.with('posts.comments')).toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()

      // --- invalid nested paths are rejected at compile time ---
      // @ts-expect-error invalid nested relation name should be rejected on with()
      User.with('posts.missing')
      // @ts-expect-error invalid nested relation name should be rejected on query builder with()
      User.query().with('posts.missing')
      // @ts-expect-error invalid nested relation name should be rejected on load()
      entity.load('posts.missing')
      // @ts-expect-error invalid root relation name should still be rejected
      User.with('missing.anything')

      // --- all three static with() forms produce typed eager loads ---
      // variadic
      const staticVariadic = User.with('posts')
      type StaticVariadicResult = NonNullable<Awaited<ReturnType<typeof staticVariadic.first>>>
      const staticVariadicPosts: Assert<IsEqual<StaticVariadicResult['posts'], Entity<typeof posts, typeof Post.definition.relations>[]>> = true
      void staticVariadicPosts

      // constraint form
      const staticConstraint = User.with('posts', _q => _q)
      type StaticConstraintResult = NonNullable<Awaited<ReturnType<typeof staticConstraint.first>>>
      const staticConstraintPosts: Assert<IsEqual<StaticConstraintResult['posts'], Entity<typeof posts, typeof Post.definition.relations>[]>> = true
      void staticConstraintPosts

      // object form — preserves TLoaded but does not add new typed relations
      // (keys of a Partial record are unsound for inference from widened variables)
      const staticObject = User.with({ posts: _q => _q })
      expectTypeOf(staticObject).toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()

      // query builder forms match
      const qbConstraint = User.query().with('profile', _q => _q)
      type QbConstraintResult = NonNullable<Awaited<ReturnType<typeof qbConstraint.first>>>
      const qbConstraintProfile: Assert<IsEqual<QbConstraintResult['profile'], Entity<typeof profiles> | null>> = true
      void qbConstraintProfile

      // object form on query builder also preserves but does not add
      const qbObject = User.query().with({ profile: _q => _q, posts: _q => _q })
      expectTypeOf(qbObject).toMatchTypeOf<ModelQueryBuilder<typeof users, UserRelations>>()

      // --- toJSON() includes loaded relations in serialized form ---
      const withPostsQuery = User.query().with('posts')
      type WithPostsForJSON = NonNullable<Awaited<ReturnType<typeof withPostsQuery.first>>>
      type WithPostsJSON = ReturnType<WithPostsForJSON['toJSON']>
      // columns are present
      const jsonName: Assert<IsEqual<WithPostsJSON['name'], string>> = true
      // loaded relation is serialized as ModelRecord[], not Entity[]
      type PostJSON = WithPostsJSON['posts'][number]
      const jsonPostTitle: Assert<IsEqual<PostJSON['title'], string>> = true
      const jsonPostId: Assert<IsEqual<PostJSON['id'], number>> = true
      void jsonName
      void jsonPostTitle
      void jsonPostId

      // --- nested toJSON() serializes nested relations ---
      const nestedQ = User.query().with('posts.comments')
      type NestedEntity = NonNullable<Awaited<ReturnType<typeof nestedQ.first>>>
      type NestedJSON = ReturnType<NestedEntity['toJSON']>
      type NestedPostJSON = NestedJSON['posts'][number]
      const nestedPostTitle: Assert<IsEqual<NestedPostJSON['title'], string>> = true
      type NestedCommentJSON = NestedPostJSON['comments'][number]
      const nestedCommentBody: Assert<IsEqual<NestedCommentJSON['body'], string>> = true
      void nestedPostTitle
      void nestedCommentBody

      // --- to-one relation serializes as ModelRecord | null ---
      const profileQ = User.query().with('profile')
      type ProfileEntity = NonNullable<Awaited<ReturnType<typeof profileQ.first>>>
      type ProfileJSON = ReturnType<ProfileEntity['toJSON']>
      type ProfileValue = ProfileJSON['profile']
      // to-one: serialized as ModelRecord | null, check the non-null branch
      const jsonProfileBio: Assert<IsEqual<NonNullable<ProfileValue>['bio'], string>> = true
      void jsonProfileBio
    }
  })

  it('supports self-referential eager-load paths', () => {
    const categories = defineTable('categories', {
      id: column.id(),
      parent_id: column.integer().nullable(),
      name: column.string(),
    })
    type CategoryDefinition = {
      readonly definition: Omit<AnyModelDefinition, 'relations' | 'table'> & {
        readonly table: typeof categories
        readonly relations: CategoryRelations
      }
    }
    type CategoryRelations = {
      readonly parent: BelongsToRelationDefinition<CategoryDefinition>
    }

    if (false) {
      type CategoryPath = ModelRelationPath<CategoryRelations>
      const rootPath: Assert<IsEqual<Extract<'parent', CategoryPath>, 'parent'>> = true
      const nestedPath: Assert<IsEqual<Extract<'parent.parent', CategoryPath>, 'parent.parent'>> = true
      const deepNestedPath: Assert<IsEqual<Extract<'parent.parent.parent.parent.parent.parent.parent.parent.parent.parent.parent.parent', CategoryPath>, 'parent.parent.parent.parent.parent.parent.parent.parent.parent.parent.parent.parent'>> = true
      void rootPath
      void nestedPath
      void deepNestedPath

      // @ts-expect-error invalid tail after deep self-referential nesting should still be rejected
      const invalidDeepPath: CategoryPath = 'parent.parent.parent.parent.parent.parent.parent.parent.parent.parent.parent.missing'
      void invalidDeepPath
    }
  })

  it('preserves eager-load typing for widened arrays and keeps morphTo nesting opaque', () => {
    const users = defineTable('users', {
      id: column.id(),
      profile_id: column.integer().nullable(),
      name: column.string(),
    })
    const posts = defineTable('posts', {
      id: column.id(),
      user_id: column.integer(),
      title: column.string(),
    })
    const profiles = defineTable('profiles', {
      id: column.id(),
      bio: column.text(),
    })
    const images = defineTable('images', {
      id: column.id(),
      imageable_type: column.string(),
      imageable_id: column.integer(),
      url: column.string(),
    })

    const Profile = defineModelFromTable(profiles)
    const Post = defineModelFromTable(posts)
    const User = defineModelFromTable(users, {
      relations: {
        posts: hasMany(() => Post, 'user_id'),
        profile: belongsTo(() => Profile, 'profile_id'),
      },
    })
    const Image = defineModelFromTable(images, {
      relations: {
        imageable: morphTo('imageable', 'imageable_type', 'imageable_id'),
      },
    })

    type UserRelations = typeof User.definition.relations

    if (false) {
      const widenedRelations = ['posts', 'profile'] as ModelRelationPath<UserRelations>[]

      const widenedQuery = User.query().with(...widenedRelations)
      type WidenedQueryResult = NonNullable<Awaited<ReturnType<typeof widenedQuery.first>>>
      const widenedQueryPosts: Assert<IsEqual<WidenedQueryResult['posts'][number]['title'], string>> = true
      const widenedQueryProfile: Assert<IsEqual<NonNullable<WidenedQueryResult['profile']>['bio'], string>> = true
      void widenedQueryPosts
      void widenedQueryProfile

      const user = undefined as unknown as Entity<typeof users, UserRelations>
      const widenedLoad = user.load(...widenedRelations)
      type WidenedLoadResult = Awaited<typeof widenedLoad>
      const widenedLoadPosts: Assert<IsEqual<WidenedLoadResult['posts'][number]['title'], string>> = true
      const widenedLoadProfile: Assert<IsEqual<NonNullable<WidenedLoadResult['profile']>['bio'], string>> = true
      void widenedLoadPosts
      void widenedLoadProfile

      const morphNestedQuery = Image.query().with('imageable.posts')
      type MorphNestedImageable = NonNullable<Awaited<ReturnType<typeof morphNestedQuery.first>>>['imageable']
      const morphNestedRootOnly: Assert<IsEqual<MorphNestedImageable, Entity | null>> = true
      void morphNestedRootOnly
    }
  })

  it('preserves inferred driver config extensions for split postgres and mysql adapters', () => {
    const postgresConfig = {
      host: 'localhost',
      max: 10,
      statement_timeout: 5000,
    } satisfies PoolConfig

    const mysqlConfig = {
      host: 'localhost',
      connectionLimit: 10,
      enableKeepAlive: true,
    } satisfies PoolOptions

    const postgresOptions: PostgresAdapterOptions<typeof postgresConfig> = {
      config: postgresConfig,
      createPool(config) {
        expectTypeOf(config).toEqualTypeOf<typeof postgresConfig | undefined>()
        return {
          query: async () => ({ rows: [] }),
          connect: async () => ({
            query: async () => ({ rows: [] }),
          }),
          end: async () => {},
        }
      },
    }

    const mysqlOptions: MySQLAdapterOptions<typeof mysqlConfig> = {
      config: mysqlConfig,
      createPool(config) {
        expectTypeOf(config).toEqualTypeOf<typeof mysqlConfig>()
        return {
          query: async () => [[], []] as const,
          getConnection: async () => ({
            query: async () => [[], []] as const,
          }),
          end: async () => {},
        }
      },
    }

    expectTypeOf(postgresOptions.config).toEqualTypeOf<typeof postgresConfig | undefined>()
    expectTypeOf(mysqlOptions.config).toEqualTypeOf<typeof mysqlConfig | undefined>()
  })
})
