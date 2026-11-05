import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, expectTypeOf, it, onTestFinished } from 'vitest'
import { column, defineGeneratedTable, defineModel, resetDB } from '../src'
import { openDatabase } from './support/database'

const drivers = [
  'sqlite',
  ...(process.env.HOLO_POSTGRES_INTEGRATION === '1' ? ['postgres' as const] : []),
  ...(process.env.HOLO_MYSQL_INTEGRATION === '1' ? ['mysql' as const] : []),
] as const

async function createPostsTable(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const name = `soft_posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.string('title')
    table.timestamps()
    table.timestamp('deleted_at').nullable()
  })
  return defineGeneratedTable(name, {
    id: column.id(),
    title: column.string(),
    created_at: column.timestamp().nullable(),
    updated_at: column.timestamp().nullable(),
    deleted_at: column.timestamp().nullable(),
  })
}

describe.each(drivers)('soft deleting a model on %s', (driver) => {
  afterEach(() => {
    resetDB()
  })

  it('holds the deleted-at column as the date a fresh read returns', async () => {
    const Post = defineModel(await createPostsTable(driver), { fillable: ['title'], softDeletes: true })
    const post = await Post.create({ title: 'Draft' })

    await post.delete()

    expectTypeOf(post.deleted_at).toEqualTypeOf<Date | null>()
    expect(post.deleted_at).toBeInstanceOf(Date)
    expect(post.isDirty()).toBe(false)
    const fresh = await Post.withTrashed().findOrFail(post.id)
    expect(fresh.deleted_at).toBeInstanceOf(Date)
    expect(post.deleted_at).toEqual(fresh.deleted_at)
    expect(post.updated_at).toEqual(fresh.updated_at)

    await post.restore()

    expect(post.deleted_at).toBeNull()
    expect((await Post.findOrFail(post.id)).deleted_at).toBeNull()
  })

  it('keeps an explicit cast on the deleted-at column', async () => {
    const Post = defineModel(await createPostsTable(driver), {
      fillable: ['title'],
      softDeletes: true,
      casts: { deleted_at: { get: (value: unknown) => value == null ? null : `at ${new Date(value as string | Date).toISOString()}`, set: (value: unknown) => value } },
    })
    const post = await Post.create({ title: 'Draft' })

    await post.delete()

    const fresh = await Post.withTrashed().findOrFail(post.id)
    expect(typeof post.deleted_at).toBe('string')
    expect(post.deleted_at).toEqual(fresh.deleted_at)
  })
})
