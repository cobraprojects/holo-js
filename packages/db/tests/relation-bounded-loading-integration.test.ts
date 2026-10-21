import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { type Entity, belongsToMany, column, hasMany, latestOfMany, morphToMany, oldestOfMany, scopeRelation, type TableDefinition } from '../src'
import { defineModelFromTable, defineTable } from './support/internal'
import { openDatabase } from './support/database'

function defineBoundedRelationLoadingScenario(driver: 'postgres' | 'mysql') {
  it('limits one-of-many, pivot and chunked eager loads on the real database', async () => {
    const { db, schema } = await openDatabase(driver)
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12)
    const names = {
      users: `bl_users_${suffix}`,
      posts: `bl_posts_${suffix}`,
      roles: `bl_roles_${suffix}`,
      roleUser: `bl_role_user_${suffix}`,
      taggables: `bl_taggables_${suffix}`,
    }
    const qualify = (name: string) => driver === 'postgres'
      ? `public.${name}`
      : `${process.env.HOLO_MYSQL_DATABASE ?? 'mysql'}.${name}`

    try {
      await schema.createTable(names.users, table => {
        table.integer('id').primaryKey()
        table.string('name')
      })
      await schema.createTable(names.posts, table => {
        table.integer('id').primaryKey()
        table.integer('userId')
        table.string('title')
        table.integer('score').nullable()
      })
      await schema.createTable(names.roles, table => {
        table.integer('id').primaryKey()
        table.string('name')
      })
      await schema.createTable(names.roleUser, table => {
        table.integer('id').primaryKey()
        table.integer('userId')
        table.integer('roleId')
        table.boolean('granted')
        table.string('secret')
      })
      await schema.createTable(names.taggables, table => {
        table.integer('id').primaryKey()
        table.integer('tagId')
        table.integer('taggableId')
        table.string('taggableType')
        table.string('note').nullable()
      })

      const users = defineTable(qualify(names.users), { id: column.integer().primaryKey(), name: column.string() })
      const posts = defineTable(qualify(names.posts), {
        id: column.integer().primaryKey(),
        userId: column.integer(),
        title: column.string(),
        score: column.integer().nullable(),
      })
      const roles = defineTable(qualify(names.roles), { id: column.integer().primaryKey(), name: column.string() })
      const roleUser = defineTable(qualify(names.roleUser), {
        id: column.integer().primaryKey(),
        userId: column.integer(),
        roleId: column.integer(),
        granted: column.boolean(),
        secret: column.string(),
      })
      const taggables = defineTable(qualify(names.taggables), {
        id: column.integer().primaryKey(),
        tagId: column.integer(),
        taggableId: column.integer(),
        taggableType: column.string(),
        note: column.string().nullable(),
      })

      await db.table(users).insert([{ id: 1, name: 'Mohamed' }, { id: 2, name: 'Amina' }, { id: 3, name: 'Salma' }])
      await db.table(posts).insert([
        { id: 10, userId: 1, title: 'Post A', score: 1 },
        { id: 11, userId: 1, title: 'Post B', score: 5 },
        { id: 12, userId: 2, title: 'Post C', score: null },
        { id: 13, userId: 2, title: 'Post D', score: null },
      ])
      await db.table(roles).insert([{ id: 100, name: 'Admin' }, { id: 101, name: 'Editor' }])
      await db.table(roleUser).insert([
        { id: 1, userId: 1, roleId: 100, granted: true, secret: 'hidden' },
        { id: 2, userId: 1, roleId: 101, granted: false, secret: 'hidden' },
      ])
      await db.table(taggables).insert([
        { id: 1, tagId: 100, taggableId: 1, taggableType: 'users', note: 'pinned' },
      ])

      const Post = defineModelFromTable(posts)
      const Role = defineModelFromTable(roles)
      const User = defineModelFromTable(users, {
        morphClass: 'users',
        relations: {
          posts: hasMany(() => Post, 'userId'),
          latestPost: latestOfMany(() => Post, 'userId'),
          oldestPost: oldestOfMany(() => Post, 'userId'),
          topScoringPost: latestOfMany(() => Post, 'userId', 'id', 'score'),
          orderedPost: scopeRelation(latestOfMany(() => Post, 'userId'), query => query.orderBy('id', 'desc')),
          roles: belongsToMany(() => Role, roleUser, 'userId', 'roleId').withPivot('granted'),
          tags: morphToMany(() => Role, 'taggable', taggables, 'tagId', 'id', 'id', 'taggableType', 'taggableId').withPivot('note'),
        },
      })

      const loaded = await User.with('latestPost', 'oldestPost', 'topScoringPost', 'orderedPost', 'posts').orderBy('id').get()
      expect(loaded.map(user => user.getRelation<Entity<TableDefinition>>('orderedPost')?.get('title') ?? null))
        .toEqual(['Post B', 'Post D', null])
      expect(loaded.map(user => user.getRelation<Entity<TableDefinition>>('latestPost')?.get('title') ?? null))
        .toEqual(['Post B', 'Post D', null])
      expect(loaded.map(user => user.getRelation<Entity<TableDefinition>>('oldestPost')?.get('title') ?? null))
        .toEqual(['Post A', 'Post C', null])
      expect(loaded.map(user => user.getRelation<Entity<TableDefinition>>('topScoringPost')?.get('title') ?? null))
        .toEqual(['Post B', null, null])
      expect(loaded.map(user => user.getRelation<Entity[]>('posts')?.length)).toEqual([2, 2, 0])

      const [first] = await User.with('roles').where('id', 1).get()
      const roleRows = first!.getRelation<Entity<TableDefinition>[]>('roles')
      expect(roleRows.map(role => Object.keys(role.getRelation<Record<string, unknown>>('pivot')!).sort()))
        .toEqual([['granted', 'roleId', 'userId'], ['granted', 'roleId', 'userId']])

      const tagged = await User.with('tags').where('id', 1).get()
      const tagPivot = tagged[0]!.getRelation<Entity<TableDefinition>[]>('tags')[0]!.getRelation<Record<string, unknown>>('pivot')!
      expect(Object.keys(tagPivot).sort()).toEqual(['note', 'tagId', 'taggableId', 'taggableType'])
    } finally {
      for (const name of Object.values(names)) {
        await schema.dropTable(name)
      }
    }
  })
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('bounded relation loading on postgres', () => {
  defineBoundedRelationLoadingScenario('postgres')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('bounded relation loading on mysql', () => {
  defineBoundedRelationLoadingScenario('mysql')
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('to-query integer keys on postgres', () => {
  defineToQueryIntegerKeysScenario('postgres')
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('to-query integer keys on mysql', () => {
  defineToQueryIntegerKeysScenario('mysql')
})

function defineToQueryIntegerKeysScenario(driver: 'postgres' | 'mysql') {
  it('loads a toQuery integer key list above 256 keys as inline literals on the real database', async () => {
    const { db, schema } = await openDatabase(driver)
    const name = `holo_to_query_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    const qualified = driver === 'postgres' ? name : `${process.env.HOLO_MYSQL_DATABASE ?? 'mysql'}.${name}`
    await schema.createTable(name, table => {
      table.integer('id').primaryKey()
      table.string('name')
    })

    try {
      const users = defineTable(qualified, { id: column.integer().primaryKey(), name: column.string() })
      await db.table(users).insert(Array.from({ length: 300 }, (_, index) => ({ id: index + 1, name: `user ${index + 1}` })))

      const User = defineModelFromTable(users)
      const collection = await User.get()

      expect(await collection.toQuery().get()).toHaveLength(300)
      expect((await collection.toQuery().orderBy('id', 'desc').limit(2).get()).map(user => user.get('id'))).toEqual([300, 299])
    } finally {
      await schema.dropTable(name)
    }
  })
}

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('to-query string keys with number values on postgres', () => {
  it('binds number-valued keys for a string primary key above 256 rows', async () => {
    const { db, schema } = await openDatabase('postgres')
    const name = `holo_to_query_codes_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.string('code').primaryKey()
      table.string('label')
    })

    try {
      const codes = defineTable(name, { code: column.string().primaryKey(), label: column.string() })
      await db.table(codes).insert(Array.from({ length: 300 }, (_, index) => ({ code: `${index + 1}`, label: `code ${index + 1}` })))

      const Code = defineModelFromTable(codes)
      const collection = await Code.get()
      for (const code of collection) {
        code.forceFill({ code: Number(code.get('code')) as never })
      }

      expect(await collection.toQuery().get()).toHaveLength(300)
    } finally {
      await schema.dropTable(name)
    }
  })
})

describe.skipIf(process.env.HOLO_MYSQL_INTEGRATION !== '1')('findMany string keys on mysql', () => {
  it('returns a stored key once when case variants of it fall into different findMany chunks', async () => {
    const { db, schema } = await openDatabase('mysql')
    const name = `holo_find_many_codes_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.string('code').primaryKey()
      table.string('label')
    })

    try {
      const codes = defineTable(`${process.env.HOLO_MYSQL_DATABASE ?? 'mysql'}.${name}`, { code: column.string().primaryKey(), label: column.string() })
      await db.table(codes).insert([{ code: 'Abc', label: 'stored' }])

      const Code = defineModelFromTable(codes)
      const keys = ['Abc', ...Array.from({ length: 255 }, (_, index) => `missing-${index}`), 'abc']

      expect(await Code.findMany(keys)).toHaveLength(1)
    } finally {
      await schema.dropTable(name)
    }
  })
})

describe.skipIf(process.env.HOLO_POSTGRES_INTEGRATION !== '1')('findMany JSON keys on postgres', () => {
  it('returns one row per stored JSON key when equal object keys fall into different findMany chunks', async () => {
    const { db, schema } = await openDatabase('postgres')
    const name = `holo_find_many_docs_${randomUUID().replaceAll('-', '').slice(0, 12)}`
    await schema.createTable(name, table => {
      table.json('key').primaryKey()
      table.string('label')
    })

    try {
      const docs = defineTable(name, { key: column.json<Record<string, number>>().primaryKey(), label: column.string() })
      await db.table(docs).insert([
        { key: { a: 1 }, label: 'stored' },
        ...Array.from({ length: 255 }, (_, index) => ({ key: { b: index }, label: `row ${index}` })),
      ])

      const Doc = defineModelFromTable(docs)
      const keys = [{ a: 1 }, ...Array.from({ length: 255 }, (_, index) => ({ b: index })), { a: 1 }]

      expect(await Doc.findMany(keys as never)).toHaveLength(256)
    } finally {
      await schema.dropTable(name)
    }
  })
})

