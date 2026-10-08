import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageRuntimeInternals } from '../../core/src/storageRuntime'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, DB, defineGeneratedTable, defineModel, resetDB } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { configureStorageRuntime, resetStorageRuntime, Storage } from '@holo-js/storage/runtime'
import { configureQueueRuntime, resetQueueRuntime, resetQueueRegistry } from '@holo-js/queue'
import { createQueueDbRuntimeOptions } from '../../queue-db/src'
import { collection, conversion, defineMediaModel, resetMediaRuntime, setMediaConversionExecutor, setMediaPathGenerator } from '../src'

const postsTable = defineGeneratedTable('posts', {
  id: column.id(),
  title: column.string(),
  created_at: column.timestamp().defaultNow(),
  updated_at: column.timestamp().defaultNow(),
})
const Post = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
  collections: [collection('avatars').disk('public').singleFile()],
})
let directory: string

async function bootDatabase(): Promise<void> {
  const db = createDatabase({
    connectionName: 'default',
    adapter: createSQLiteAdapter({}),
    dialect: createDialect('sqlite'),
  })

  configureDB(createConnectionManager({
    defaultConnection: 'default',
    connections: {
      default: db,
    },
  }))

  const schema = createSchemaService(db)
  await schema.createTable('posts', (table) => {
    table.id()
    table.string('title')
    table.timestamps()
  })

  await schema.createTable('media', (table) => {
    table.id()
    table.uuid('uuid').unique()
    table.string('model_type')
    table.string('model_id')
    table.string('collection_name').default('default')
    table.string('name')
    table.string('file_name')
    table.string('disk')
    table.string('conversions_disk').nullable()
    table.string('mime_type').nullable()
    table.string('extension').nullable()
    table.bigInteger('size')
    table.string('path')
    table.json('generated_conversions').default({})
    table.integer('order_column').default(1)
    table.timestamps()
    table.index(['model_type', 'model_id'])
    table.index(['model_type', 'model_id', 'collection_name'])
  })
}


beforeEach(async () => {
  resetDB()
  resetMediaRuntime()
  resetQueueRegistry()
  await resetQueueRuntime()
  configureQueueRuntime()
  await bootDatabase()
  directory = await mkdtemp(join(tmpdir(), 'holo-media-mutations-'))
  const backend = storageRuntimeInternals.createFileStorageBackend(directory)
  configureStorageRuntime({
    getRuntimeConfig: () => ({ holoStorage: {
      defaultDisk: 'public', diskNames: ['public'], routePrefix: '/storage',
      disks: { public: { name: 'public', driver: 'public', visibility: 'public', root: directory } },
    } }),
    getStorage: () => backend,
  })
})

afterEach(async () => {
  resetStorageRuntime()
  await rm(directory, { recursive: true, force: true })
  await DB.connection().disconnect()
  resetDB()
})

it('retains replacement records and new files when obsolete file cleanup fails after commit', async () => {
  const post = await Post.create({ title: 'Avatar' })
  const first = await post.addMedia({ contents: Buffer.from('first'), fileName: 'first.txt' }).toMediaCollection('avatars')
  await rm(join(directory, first.record.path), { force: true })
  await mkdir(join(directory, first.record.path), { recursive: true })
  await expect(post.addMedia({ contents: Buffer.from('second'), fileName: 'second.txt' }).toMediaCollection('avatars')).rejects.toThrow('committed')
  const current = await post.getMedia('avatars')
  expect(current.map(item => item.fileName)).toEqual(['second.txt'])
  await expect(Storage.disk('public').get(current[0]!.record.path)).resolves.toBe('second')
})

it('compensates attachment and replacement files when the enclosing transaction rolls back', async () => {
  const post = await Post.create({ title: 'Rollback' })
  const first = await post.addMedia({ contents: Buffer.from('first'), fileName: 'first.txt' }).toMediaCollection('avatars')
  let nextPath = ''
  await expect(DB.transaction(async () => {
    const next = await post.addMedia({ contents: Buffer.from('second'), fileName: 'second.txt' }).toMediaCollection('avatars')
    nextPath = next.record.path
    await expect(Storage.disk('public').get(first.record.path)).resolves.toBe('first')
    throw new Error('outer rollback')
  })).rejects.toThrow('outer rollback')
  expect((await post.getMedia('avatars')).map(item => item.fileName)).toEqual(['first.txt'])
  await expect(Storage.disk('public').get(first.record.path)).resolves.toBe('first')
  await expect(Storage.disk('public').exists(nextPath)).resolves.toBe(false)
})

it('compensates original and generated files when attachment persistence fails', async () => {
  setMediaConversionExecutor({
    async generate() {
      await createSchemaService(DB.connection()).dropTable('media')
      return { contents: Buffer.from('conversion'), fileName: 'thumb.txt' }
    },
  })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  setMediaPathGenerator({ originalPath: () => 'original.txt', conversionPath: () => 'thumb.txt' })
  const post = await ConvertedPost.create({ title: 'Persistence failure' })
  await expect(post.addMedia(Buffer.from('original')).toMediaCollection('avatars')).rejects.toThrow()
  await expect(Storage.disk('public').exists('original.txt')).resolves.toBe(false)
  await expect(Storage.disk('public').exists('thumb.txt')).resolves.toBe(false)
  expect(await post.getMedia('avatars')).toEqual([])
})

it('retains committed attachment files and records when queued dispatch fails', async () => {
  configureQueueRuntime({
    config: {
      default: 'database', failed: false,
      connections: { database: { driver: 'database', connection: 'default', table: 'missing_jobs', queue: 'media' } },
    },
    ...createQueueDbRuntimeOptions(),
  })
  const QueuedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars').queued()],
  })
  const post = await QueuedPost.create({ title: 'Queue failure' })
  await expect(post.addMedia({ contents: Buffer.from('original'), fileName: 'original.txt' }).toMediaCollection('avatars')).rejects.toThrow('committed')
  const items = await post.getMedia('avatars')
  expect(items).toHaveLength(1)
  await expect(Storage.disk('public').get(items[0]!.record.path)).resolves.toBe('original')
})

it('retains the outer failure and file compensation failure together', async () => {
  const post = await Post.create({ title: 'Failed compensation' })
  const primary = new Error('outer failure')
  const failure = await DB.transaction(async () => {
    const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
    await rm(join(directory, item.record.path), { force: true })
    await mkdir(join(directory, item.record.path), { recursive: true })
    throw primary
  }).catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error('Expected aggregated mutation failure')
  expect(failure.errors[0]).toBe(primary)
  expect(failure.errors[1]).toBeInstanceOf(Error)
  expect(await post.getMedia('avatars')).toEqual([])
})

it('restores regenerated files when persistence fails after generation', async () => {
  let regenerating = false
  setMediaConversionExecutor({
    async generate() {
      if (regenerating) await createSchemaService(DB.connection()).dropTable('media')
      return { contents: Buffer.from(regenerating ? 'new' : 'old'), fileName: 'thumb.txt' }
    },
  })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Regeneration failure' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  const path = item.record.generated_conversions.thumb!.path
  regenerating = true
  await expect(item.regenerate()).rejects.toThrow()
  await expect(Storage.disk('public').get(path)).resolves.toBe('old')
  expect((await post.getFirstMedia('avatars'))!.record.generated_conversions).toEqual(item.record.generated_conversions)
})

it('retains committed deletion when file cleanup fails and preserves files on outer rollback', async () => {
  const post = await Post.create({ title: 'Deletion' })
  const first = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  await expect(DB.transaction(async () => {
    await first.delete()
    await expect(Storage.disk('public').get(first.record.path)).resolves.toBe('original')
    throw new Error('outer deletion rollback')
  })).rejects.toThrow('outer deletion rollback')
  const restored = (await post.getFirstMedia('avatars'))!
  await rm(join(directory, restored.record.path), { force: true })
  await mkdir(join(directory, restored.record.path), { recursive: true })
  await expect(restored.delete()).rejects.toThrow('committed')
  expect(await post.getMedia('avatars')).toEqual([])
})

it('preserves deletion files and record when the database operation fails before commit', async () => {
  const post = await Post.create({ title: 'Deletion failure' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  await expect(DB.transaction(async () => {
    await createSchemaService(DB.connection()).dropTable('media')
    await item.delete()
  })).rejects.toThrow()
  await expect(Storage.disk('public').get(item.record.path)).resolves.toBe('original')
  expect((await post.getMedia('avatars')).map(current => current.record.id)).toEqual([item.record.id])
})

it('retains regenerated files and record when obsolete conversion cleanup fails after commit', async () => {
  let regenerating = false
  setMediaConversionExecutor({ async generate() {
    return { contents: Buffer.from(regenerating ? 'new' : 'old'), fileName: regenerating ? 'new.txt' : 'old.txt' }
  } })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  setMediaPathGenerator({ originalPath: () => 'original.txt', conversionPath: ({ generatedFileName, fileName }) => generatedFileName ?? fileName })
  const post = await ConvertedPost.create({ title: 'Cleanup failure' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  const oldPath = item.record.generated_conversions.thumb!.path
  await rm(join(directory, oldPath), { force: true })
  await mkdir(join(directory, oldPath), { recursive: true })
  regenerating = true
  await expect(item.regenerate()).rejects.toThrow('committed')
  const current = (await post.getFirstMedia('avatars'))!
  expect(current.record.generated_conversions.thumb!.fileName).toBe('new.txt')
  await expect(Storage.disk('public').get(current.record.generated_conversions.thumb!.path)).resolves.toBe('new')
})

it('exposes regeneration failure together with failed conversion restoration', async () => {
  let regenerating = false
  const primary = new Error('second conversion failed')
  let thumbPath = ''
  setMediaConversionExecutor({ async generate({ conversion: selected }) {
    if (regenerating && selected.name === 'card') {
      await rm(join(directory, thumbPath), { force: true })
      await mkdir(join(directory, thumbPath), { recursive: true })
      throw primary
    }
    return { contents: Buffer.from(regenerating ? 'new' : 'old'), fileName: `${selected.name}.txt` }
  } })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars'), conversion('card').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Failed restoration' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  const previous = item.record.generated_conversions
  thumbPath = previous.thumb!.path
  regenerating = true
  const failure = await item.regenerate().catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error('Expected aggregated regeneration failure')
  expect(failure.errors[0]).toBe(primary)
  expect(failure.errors[1]).toBeInstanceOf(Error)
  expect((await post.getFirstMedia('avatars'))!.record.generated_conversions).toEqual(previous)
})

it('restores conversion bytes and metadata when enclosing regeneration rolls back', async () => {
  let regenerating = false
  setMediaConversionExecutor({ async generate() {
    return { contents: Buffer.from(regenerating ? 'new' : 'old'), fileName: 'thumb.txt' }
  } })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Outer regeneration' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  const previous = item.record.generated_conversions
  regenerating = true
  await expect(DB.transaction(async () => {
    await item.regenerate()
    await expect(Storage.disk('public').get(previous.thumb!.path)).resolves.toBe('new')
    throw new Error('outer regeneration rollback')
  })).rejects.toThrow('outer regeneration rollback')
  await expect(Storage.disk('public').get(previous.thumb!.path)).resolves.toBe('old')
  expect(item.record.generated_conversions).toEqual(previous)
  expect((await post.getFirstMedia('avatars'))!.record.generated_conversions).toEqual(previous)
})

it('restores original conversion bytes after repeated regeneration and enclosing rollback', async () => {
  let contents = 'original conversion'
  setMediaConversionExecutor({ async generate() {
    return { contents: Buffer.from(contents), fileName: 'thumb.txt' }
  } })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Repeated regeneration' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  const previous = item.record.generated_conversions
  await expect(DB.transaction(async () => {
    contents = 'intermediate conversion'
    await item.regenerate()
    await DB.transaction(async () => {
      contents = 'final conversion'
      await item.regenerate()
    })
    await expect(Storage.disk('public').get(previous.thumb!.path)).resolves.toBe('final conversion')
    throw new Error('outer repeated regeneration rollback')
  })).rejects.toThrow('outer repeated regeneration rollback')
  await expect(Storage.disk('public').get(previous.thumb!.path)).resolves.toBe('original conversion')
  expect(item.record.generated_conversions).toEqual(previous)
  expect((await post.getFirstMedia('avatars'))!.record.generated_conversions).toEqual(previous)
})

it('retains regenerated conversions when queued regeneration dispatch fails after commit', async () => {
  let regenerating = false
  setMediaConversionExecutor({ async generate() {
    return { contents: Buffer.from(regenerating ? 'new' : 'old'), fileName: 'thumb.txt' }
  } })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars'), conversion('card').performOnCollections('avatars').queued()],
  })
  const post = await ConvertedPost.create({ title: 'Regeneration dispatch' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  configureQueueRuntime({
    config: {
      default: 'database', failed: false,
      connections: { database: { driver: 'database', connection: 'default', table: 'missing_jobs', queue: 'media' } },
    },
    ...createQueueDbRuntimeOptions(),
  })
  regenerating = true
  await expect(item.regenerate()).rejects.toThrow('committed')
  const current = (await post.getFirstMedia('avatars'))!
  await expect(Storage.disk('public').get(current.record.generated_conversions.thumb!.path)).resolves.toBe('new')
})
