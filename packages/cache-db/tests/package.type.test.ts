import { describe, expectTypeOf, it } from 'vitest'
import { serializeCacheValue, type CacheDriverContract, type CacheDriverGetResult, type CacheLockContract } from '@holo-js/cache'
import {
  type GeneratedSchemaTable,
  type ModelQueryBuilder,
  belongsTo,
  clearGeneratedTables,
  defineModel,
  registerGeneratedTables,
} from '@holo-js/db'
import {
  DEFAULT_CACHE_DATABASE_LOCK_TABLE,
  DEFAULT_CACHE_DATABASE_TABLE,
  createDatabaseCacheDriver,
  type DatabaseCacheDriverOptions,
} from '../src'
import { tables } from './fixtures/generated-schema'

describe('@holo-js/cache-db typing', () => {
  it('preserves generated-schema model inference for normal user authoring', () => {
    clearGeneratedTables()
    registerGeneratedTables(tables)

    const Team = defineModel('teams', {
      fillable: ['name'],
      timestamps: true,
    })
    const userRelations = {
      team: belongsTo(() => Team, 'team_id'),
    } as const
    type UserRelations = typeof userRelations
    const userScopes = {
      active(query: ModelQueryBuilder<GeneratedSchemaTable<'users'>, UserRelations>) {
        return query.where('status', 'active')
      },
      named(query: ModelQueryBuilder<GeneratedSchemaTable<'users'>, UserRelations>, value: string) {
        return query.where('name', value)
      },
    } as const

    const User = defineModel('users', {
      fillable: ['team_id', 'name', 'status', 'loginCount'],
      timestamps: true,
      scopes: userScopes,
      relations: userRelations,
    })

    type UserQuery = ReturnType<typeof User.query>
    type UserEntityPromise = ReturnType<typeof User.create>
    type UserFirstPromise = ReturnType<UserQuery['first']>

    expectTypeOf<UserEntityPromise>().toMatchTypeOf<Promise<{
      get(key: 'team_id'): number
      get(key: 'name'): string
      get(key: 'status'): string
      get(key: 'loginCount'): number
      get(key: 'created_at'): Date
      get(key: 'updated_at'): Date
    }>>()
    expectTypeOf<UserFirstPromise>().toMatchTypeOf<Promise<{
      get(key: 'team_id'): number
      get(key: 'name'): string
      get(key: 'status'): string
      get(key: 'loginCount'): number
      get(key: 'created_at'): Date
      get(key: 'updated_at'): Date
    } | undefined>>()
    expectTypeOf(User.active).toBeFunction()
    expectTypeOf(User.named).toBeFunction()
    expectTypeOf<ReturnType<typeof User.active>>().toMatchTypeOf<UserQuery>()
    expectTypeOf<ReturnType<typeof User.named>>().toMatchTypeOf<UserQuery>()

    if (false) {
      const query = User.query()

      void User.with('team')
      void query.with('team')
      expectTypeOf(User.definition.relations).toMatchTypeOf<UserRelations>()

      // @ts-expect-error invalid generated-schema scope names should be rejected
      User.inactive()
      // @ts-expect-error invalid generated-schema relation names should be rejected
      User.with('missing')
      // @ts-expect-error invalid generated-schema relation names should be rejected on queries
      query.with('missing')
    }
  })

  it('preserves the public driver contract and callback inference', () => {
    const options = {
      name: 'database',
      connectionName: 'cache',
      table: DEFAULT_CACHE_DATABASE_TABLE,
      lockTable: DEFAULT_CACHE_DATABASE_LOCK_TABLE,
      connection: ':memory:',
    } satisfies DatabaseCacheDriverOptions

    const driver = createDatabaseCacheDriver(options)
    const lock = driver.lock('reports:refresh', 60)

    expectTypeOf(driver).toExtend<CacheDriverContract>()
    expectTypeOf(driver.get).returns.toEqualTypeOf<Promise<CacheDriverGetResult>>()
    expectTypeOf(driver.put).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(driver.add).returns.toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(driver.increment).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(driver.decrement).returns.toEqualTypeOf<Promise<number>>()
    expectTypeOf(lock).toExtend<CacheLockContract>()

    const putPayload = {
      key: 'reports:refresh',
      payload: serializeCacheValue({ total: 1, names: ['Amina'] }),
      expiresAt: Date.now() + 60_000,
    }
    const typedGet: (callback?: () => { refreshed: true } | Promise<{ refreshed: true }>) => Promise<boolean | { refreshed: true }>
      = lock.get
    const typedBlock: (waitSeconds: number, callback?: () => 'done' | Promise<'done'>) => Promise<boolean | 'done'>
      = lock.block

    expectTypeOf(putPayload).toMatchTypeOf<Parameters<typeof driver.put>[0]>()

    void typedGet
    void typedBlock
  })
})
