import { randomUUID } from 'node:crypto'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import { afterEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import { DB, column, defineGeneratedTable, defineModel, resetDB } from '../src'
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

function useTokyoAppAt(now: Date, timezone = 'Asia/Tokyo'): void {
  const previousTimeZone = process.env.TZ
  configureConfigRuntime({ app: { timezone } } as never)
  process.env.TZ = 'America/New_York'
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(now)
  onTestFinished(() => {
    vi.useRealTimers()
    resetConfigRuntime()
    if (previousTimeZone === undefined) delete process.env.TZ
    else process.env.TZ = previousTimeZone
  })
}

async function createDatePostsTable(driver: typeof drivers[number]) {
  const { schema } = await openDatabase(driver)
  const name = `date_posts_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  onTestFinished(async () => {
    await schema.dropTable(name)
  })
  await schema.createTable(name, (table) => {
    table.id()
    table.string('title')
    table.date('created_at').nullable()
    table.date('updated_at').nullable()
    table.date('deleted_at').nullable()
  })
  return defineGeneratedTable(name, {
    id: column.id(),
    title: column.string(),
    created_at: column.date().nullable(),
    updated_at: column.date().nullable(),
    deleted_at: column.date().nullable(),
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

  it('holds model timestamps on DATE columns as the calendar date a fresh read returns', async () => {
    useTokyoAppAt(new Date('2026-03-04T20:00:00.123Z'))
    const Post = defineModel(await createDatePostsTable(driver), { fillable: ['title'], softDeletes: true })
    const midnight = new Date('2026-03-04T15:00:00.000Z')
    const fresh = async () => Post.withTrashed().findOrFail(post.id)

    const post = await Post.create({ title: 'Draft' })

    expect(post.created_at).toEqual(midnight)
    expect(post.updated_at).toEqual(midnight)
    expect((await fresh()).created_at).toEqual(midnight)
    expect((await fresh()).updated_at).toEqual(midnight)
    if (driver !== 'sqlite') {
      expect(await Post.whereDate('created_at', '2026-03-05').count()).toBe(1)
      expect(await Post.whereToday('created_at').count()).toBe(1)
      expect(await Post.whereBeforeToday('created_at').count()).toBe(0)
    }
    expect(await Post.where('created_at', post.created_at).count()).toBe(1)
    expect(await Post.whereIn('created_at', [post.created_at]).count()).toBe(1)
    expect(await Post.where('created_at', '<', new Date('2026-03-05T15:00:00.000Z')).count()).toBe(1)
    expect(await Post.where('created_at', '>', midnight).count()).toBe(0)
    expect(await Post.where('created_at', '>=', midnight).count()).toBe(1)
    expect(await Post.whereBetween('created_at', [midnight, new Date('2026-03-05T15:00:00.000Z')]).count()).toBe(1)
    expect((await Post.updateOrCreate({ created_at: post.created_at } as never, { title: 'Same' })).id).toBe(post.id)

    vi.setSystemTime(new Date('2026-03-05T16:00:00.000Z'))
    const nextMidnight = new Date('2026-03-05T15:00:00.000Z')
    post.title = 'Edited'
    await post.save()

    expect(post.created_at).toEqual(midnight)
    expect(post.updated_at).toEqual(nextMidnight)
    expect((await fresh()).updated_at).toEqual(nextMidnight)

    vi.setSystemTime(new Date('2026-03-06T16:00:00.000Z'))
    const deletedMidnight = new Date('2026-03-06T15:00:00.000Z')
    await post.delete()

    expect(post.deleted_at).toEqual(deletedMidnight)
    expect(post.updated_at).toEqual(deletedMidnight)
    expect(post.isDirty()).toBe(false)
    expect((await fresh()).deleted_at).toEqual(deletedMidnight)
    expect((await fresh()).updated_at).toEqual(deletedMidnight)

    vi.setSystemTime(new Date('2026-03-07T16:00:00.000Z'))
    await post.restore()

    expect(post.deleted_at).toBeNull()
    expect(post.updated_at).toEqual(new Date('2026-03-07T15:00:00.000Z'))
    expect((await fresh()).updated_at).toEqual(post.updated_at)
  })

  it('holds a timestamp assigned to a DATE column as the calendar date a fresh read returns', async () => {
    useTokyoAppAt(new Date('2026-03-04T20:00:00.123Z'))
    const Post = defineModel(await createDatePostsTable(driver), { fillable: ['title', 'created_at', 'updated_at'], softDeletes: true })
    const fresh = async () => Post.withTrashed().findOrFail(post.id)

    const post = await Post.create({ title: 'Draft', created_at: '2026-03-05 12:34:56' as never, updated_at: new Date('2026-03-06T20:00:00.000Z') })

    expect(post.created_at).toEqual((await fresh()).created_at)
    expect(post.updated_at).toEqual((await fresh()).updated_at)
    expect(post.updated_at).toEqual(new Date('2026-03-06T15:00:00.000Z'))
    expect(await Post.where('updated_at', post.updated_at).count()).toBe(1)

    post.updated_at = '2026-03-09T01:00:00+09:00' as never
    await post.save()

    expect(post.updated_at).toEqual(new Date('2026-03-08T15:00:00.000Z'))
    expect(post.updated_at).toEqual((await fresh()).updated_at)

    for (const assigned of ['2026-03-08', '2026-03-05T23:34:56', '2026-03-05T23:34', '2026-03-05 23:34', '2026-03-05T23:34:56.123456']) {
      post.created_at = assigned as never
      await post.save()

      expect(post.created_at).toEqual((await fresh()).created_at)
      if (driver !== 'mysql' || assigned === '2026-03-08') {
        expect(await Post.where('created_at', assigned).count()).toBe(1)
        expect((await Post.updateOrCreate({ created_at: assigned } as never, { title: assigned })).id).toBe(post.id)
      }
      if (driver !== 'sqlite') {
        expect(post.created_at).toEqual(assigned === '2026-03-08' ? new Date('2026-03-07T15:00:00.000Z') : new Date('2026-03-04T15:00:00.000Z'))
      }
    }
  })

  it('holds a BC date written to a DATE timestamp as a fresh read returns it', async () => {
    useTokyoAppAt(new Date('2026-03-04T20:00:00.123Z'), 'UTC')
    const Post = defineModel(await createDatePostsTable(driver), { fillable: ['title', 'created_at'] })

    const ancient = new Date('-000001-03-04T12:34:56Z')
    if (driver === 'mysql') {
      await expect(Post.create({ title: 'Ancient', created_at: ancient })).rejects.toThrow()
      return
    }

    const post = await Post.create({ title: 'Ancient', created_at: ancient })

    expect(post.created_at).toEqual((await Post.findOrFail(post.id)).created_at)
  })

  it('resolves a repeated midnight the way a DATE read does', async () => {
    useTokyoAppAt(new Date('2026-11-01T12:00:00.000Z'), 'America/Havana')
    const Post = defineModel(await createDatePostsTable(driver), { fillable: ['title'], softDeletes: true })

    const post = await Post.create({ title: 'Draft' })
    await post.delete()

    const fresh = await Post.withTrashed().findOrFail(post.id)
    expect(post.created_at).toEqual(fresh.created_at)
    expect(post.updated_at).toEqual(fresh.updated_at)
    expect(post.deleted_at).toEqual(fresh.deleted_at)
    expect(post.created_at).toEqual(new Date('2026-11-01T05:00:00.000Z'))
  })

  it('leaves an impossible calendar date for the database to judge', async () => {
    useTokyoAppAt(new Date('2026-03-04T20:00:00.123Z'))
    const table = await createDatePostsTable(driver)
    const Post = defineModel(table, { fillable: ['title', 'created_at'] })

    for (const impossible of ['2025-02-30', '2025-13-01', '2025-02-30T03:04:05Z', '2025-02-28 24:30:00']) {
      if (driver === 'sqlite') {
        const post = await Post.create({ title: impossible, created_at: impossible as never })
        expect((await DB.table(table).where('id', post.id).first())?.created_at).toBe(impossible)
      } else {
        await expect(Post.create({ title: impossible, created_at: impossible as never })).rejects.toThrow()
      }
    }
  })
})
