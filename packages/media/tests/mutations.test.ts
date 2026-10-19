import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storageRuntimeInternals } from '../../core/src/storageRuntime'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { column, configureDB, createConnectionManager, createDatabase, createDialect, createSchemaService, DB, defineGeneratedTable, defineModel, resetDB } from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import { configureStorageRuntime, resetStorageRuntime, Storage, type StorageDisk } from '@holo-js/storage/runtime'
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
    security: { allowUnsafeRawSql: true },
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
      return { contents: Buffer.from('conversion'), fileName: 'thumb.txt' }
    },
  })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  setMediaPathGenerator({ originalPath: () => 'original.txt', conversionPath: () => 'thumb.txt' })
  const post = await ConvertedPost.create({ title: 'Persistence failure' })
  await DB.unsafeExecute({ sql: "CREATE TRIGGER reject_media_insert BEFORE INSERT ON media BEGIN SELECT RAISE(ABORT, 'media insert rejected'); END", unsafe: true })
  await expect(post.addMedia(Buffer.from('original')).toMediaCollection('avatars')).rejects.toThrow('media insert rejected')
  await DB.unsafeExecute({ sql: 'DROP TRIGGER reject_media_insert', unsafe: true })
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

it('removes every conversion already written when a later conversion fails', async () => {
  setMediaConversionExecutor({
    async generate({ conversion: selected }) {
      if (selected.name === 'card') throw new Error('card generation failed')
      return { contents: Buffer.from(selected.name), fileName: `${selected.name}.txt` }
    },
  })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars'), conversion('card').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Later conversion failure' })
  setMediaPathGenerator({ originalPath: () => 'original.txt', conversionPath: ({ generatedFileName }) => generatedFileName ?? 'missing.txt' })

  await expect(post.addMedia(Buffer.from('original')).toMediaCollection('avatars')).rejects.toThrow('card generation failed')
  await expect(Storage.disk('public').exists('original.txt')).resolves.toBe(false)
  await expect(Storage.disk('public').exists('thumb.txt')).resolves.toBe(false)
  expect(await post.getMedia('avatars')).toEqual([])
})

it('keeps the generation failure when cleaning up a written conversion also fails', async () => {
  const primary = new Error('card generation failed after thumb was written')
  let thumbPath = ''
  setMediaConversionExecutor({
    async generate({ conversion: selected }) {
      if (selected.name === 'card') {
        await rm(join(directory, thumbPath), { force: true })
        await mkdir(join(directory, thumbPath), { recursive: true })
        throw primary
      }
      return { contents: Buffer.from(selected.name), fileName: `${selected.name}.txt` }
    },
  })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars'), conversion('card').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Cleanup failure' })
  thumbPath = 'thumb.txt'
  setMediaPathGenerator({ originalPath: () => 'original.txt', conversionPath: ({ generatedFileName }) => generatedFileName ?? 'missing.txt' })

  const failure = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars').catch((error: unknown) => error)

  expect(failure).toBeInstanceOf(AggregateError)
  if (!(failure instanceof AggregateError)) throw new Error('Expected aggregated attachment failure')
  expect(failure.errors[0]).toBe(primary)
  expect(failure.errors[1]).toBeInstanceOf(Error)
  expect(await post.getMedia('avatars')).toEqual([])
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

async function publicStoredPaths(): Promise<string[]> {
  const paths: string[] = []
  let cursor: string | null = null
  do {
    const page = await Storage.disk('public').listFiles('', { cursor, limit: 100 })
    paths.push(...page.paths)
    cursor = page.nextCursor
  } while (cursor)
  return paths.sort()
}

it('removes the new output and keeps the previous conversion when persistence fails after regeneration', async () => {
  let regenerating = false
  setMediaConversionExecutor({
    async generate() {
      return { contents: Buffer.from(regenerating ? 'new-version' : 'old'), fileName: 'thumb.txt' }
    },
  })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Regeneration failure' })
  const item = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  const path = item.record.generated_conversions.thumb!.path
  const pathsBefore = await publicStoredPaths()
  regenerating = true
  await DB.unsafeExecute({ sql: "CREATE TRIGGER reject_media_update BEFORE UPDATE ON media BEGIN SELECT RAISE(ABORT, 'media update rejected'); END", unsafe: true })
  await expect(item.regenerate()).rejects.toThrow('media update rejected')
  await DB.unsafeExecute({ sql: 'DROP TRIGGER reject_media_update', unsafe: true })
  await expect(Storage.disk('public').get(path)).resolves.toBe('old')
  expect(await publicStoredPaths()).toEqual(pathsBefore)
  expect((await post.getFirstMedia('avatars'))!.record.generated_conversions).toEqual(item.record.generated_conversions)
})

async function regenerateOverlapping(options: { readonly failA: boolean }) {
  let output = 'output-initial'
  let mimeType = 'text/initial'
  setMediaConversionExecutor({
    async generate() {
      return { contents: Buffer.from(output), fileName: 'thumb.txt', mimeType }
    },
  })
  setMediaPathGenerator({ originalPath: () => 'original.txt', conversionPath: () => 'thumb.txt' })
  const ConvertedPost = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
    collections: [collection('avatars').disk('public')],
    conversions: [conversion('thumb').performOnCollections('avatars')],
  })
  const post = await ConvertedPost.create({ title: 'Overlapping regenerations' })
  const initial = await post.addMedia(Buffer.from('original')).toMediaCollection('avatars')
  const initialPath = initial.record.generated_conversions.thumb!.path

  const written = new Map<string, string>()
  let releaseA: () => void = () => {}
  const aMayCommit = new Promise<void>((resolve) => { releaseA = resolve })
  let aWritten: () => void = () => {}
  const aHasWritten = new Promise<void>((resolve) => { aWritten = resolve })
  const openDisk = Storage.disk.bind(Storage)
  vi.spyOn(Storage, 'disk').mockImplementation((diskName?: string) => {
    const disk = openDisk(diskName)
    return {
      ...disk,
      put: async (path: string, contents: Parameters<StorageDisk['put']>[1]) => {
        const written_ = await disk.put(path, contents)
        const label = Buffer.from(contents as Uint8Array).toString()
        if (label.startsWith('output-')) written.set(label, path)
        if (label === 'output-A') {
          aWritten()
          await aMayCommit
        }
        return written_
      },
    } as StorageDisk
  })

  try {
    if (options.failA) {
      await DB.unsafeExecute({ sql: "CREATE TRIGGER reject_regeneration_a BEFORE UPDATE ON media WHEN NEW.generated_conversions LIKE '%text/a%' BEGIN SELECT RAISE(ABORT, 'regeneration A rejected'); END", unsafe: true })
    }
    const first = (await post.getFirstMedia('avatars'))!
    const second = (await post.getFirstMedia('avatars'))!

    output = 'output-A'
    mimeType = 'text/a'
    const regenerationA = first.regenerate().catch((error: unknown) => error)
    await aHasWritten

    output = 'output-B'
    mimeType = 'text/b'
    await second.regenerate()
    const bPath = second.record.generated_conversions.thumb!.path
    releaseA()
    const aFailure = await regenerationA
    if (options.failA) {
      await DB.unsafeExecute({ sql: 'DROP TRIGGER reject_regeneration_a', unsafe: true })
    }

    return { post, initialPath, bPath, aPath: written.get('output-A'), aFailure }
  } finally {
    vi.restoreAllMocks()
  }
}

it('stores the regeneration that commits last and removes the files it replaced when overlapping regenerations succeed', async () => {
  const { post, initialPath, bPath, aPath } = await regenerateOverlapping({ failA: false })

  const row = (await post.getFirstMedia('avatars'))!.record.generated_conversions.thumb
  expect(row).toMatchObject({ path: aPath, mimeType: 'text/a' })
  await expect(Storage.disk('public').get(aPath!)).resolves.toBe('output-A')
  await expect(Storage.disk('public').exists(bPath)).resolves.toBe(false)
  await expect(Storage.disk('public').exists(initialPath)).resolves.toBe(false)
})

it('removes a failed overlapping regeneration files and keeps the committed output', async () => {
  const { post, bPath, aPath, aFailure } = await regenerateOverlapping({ failA: true })

  expect(aFailure).toBeInstanceOf(Error)
  const row = (await post.getFirstMedia('avatars'))!.record.generated_conversions.thumb
  expect(row).toMatchObject({ path: bPath, mimeType: 'text/b' })
  await expect(Storage.disk('public').get(bPath)).resolves.toBe('output-B')
  await expect(Storage.disk('public').exists(aPath!)).resolves.toBe(false)
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

it('removes regenerated conversion files when an enclosing regeneration rolls back', async () => {
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
  let regeneratedPath = ''
  await expect(DB.transaction(async () => {
    await item.regenerate()
    regeneratedPath = item.record.generated_conversions.thumb!.path
    await expect(Storage.disk('public').get(regeneratedPath)).resolves.toBe('new')
    throw new Error('outer regeneration rollback')
  })).rejects.toThrow('outer regeneration rollback')
  await expect(Storage.disk('public').get(previous.thumb!.path)).resolves.toBe('old')
  await expect(Storage.disk('public').exists(regeneratedPath)).resolves.toBe(false)
  expect(item.record.generated_conversions).toEqual(previous)
  expect((await post.getFirstMedia('avatars'))!.record.generated_conversions).toEqual(previous)
})

it('keeps the previous conversion bytes after repeated regeneration and enclosing rollback', async () => {
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
  let latestPath = ''
  await expect(DB.transaction(async () => {
    contents = 'intermediate conversion'
    await item.regenerate()
    await DB.transaction(async () => {
      contents = 'final conversion'
      await item.regenerate()
    })
    latestPath = item.record.generated_conversions.thumb!.path
    await expect(Storage.disk('public').get(latestPath)).resolves.toBe('final conversion')
    throw new Error('outer repeated regeneration rollback')
  })).rejects.toThrow('outer repeated regeneration rollback')
  await expect(Storage.disk('public').get(previous.thumb!.path)).resolves.toBe('original conversion')
  await expect(Storage.disk('public').exists(latestPath)).resolves.toBe(false)
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
