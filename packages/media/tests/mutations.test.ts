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
