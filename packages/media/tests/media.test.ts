import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { beforeEach, describe, expect, expectTypeOf, it, onTestFinished, vi } from 'vitest'
import { createNativeRedisQueue } from '../../queue-redis/tests/support/native-queue'
import { createNativeMediaStorage, storageFiles } from './support/native-storage'
import { configureConfigRuntime, resetConfigRuntime } from '@holo-js/config'
import {
  Storage,
  StorageMetadataUnsupportedError,
  type StorageDisk,
  type StorageFileMetadata,
} from '@holo-js/storage/runtime'
import {
  belongsTo,
  column,
  createConnectionManager,
  createDatabase,
  createDialect,
  DB,
  defineGeneratedTable,
  createSchemaService,
  defineModel,
  configureDB,
  resetDB,
} from '@holo-js/db'
import { createSQLiteAdapter } from '@holo-js/db-sqlite'
import {
  configureQueueRuntime,
  listRegisteredQueueJobs,
  resetQueueRegistry,
  resetQueueRuntime,
  runQueueWorker,
  type QueueAsyncDriver,
  type QueueDriverDispatchResult,
  type QueueDriverFactory,
  type QueueJobEnvelope,
  type QueueJsonValue,
  type QueueReserveInput,
  type QueueReservedJob,
} from '@holo-js/queue'
import { createQueueDbRuntimeOptions } from '../../queue-db/src'
import {
  Media,
  collection,
  conversion,
  createDefaultMediaConversionExecutor,
  dispatchQueuedMediaConversions,
  defineMediaConfig,
  defineMediaModel,
  ensureMediaQueueJobRegistered,
  getMediaConversionExecutor,
  getMediaDefinition,
  getMediaDefinitionForMorphClass,
  getMediaPathGenerator,
  MEDIA_GENERATE_CONVERSIONS_JOB,
  MediaItem,
  normalizeCollectionDefinitions,
  normalizeConversionDefinitions,
  normalizeMediaConfig,
  normalizeMediaDefinition,
  resetMediaPathGenerator,
  resetMediaRuntime,
  requireMediaDefinition,
  requireMediaDefinitionForMorphClass,
  registerMediaDefinition,
  resolveMediaDefinition,
  resolveMediaCollection,
  resolveMediaConversion,
  runMediaGenerateConversionsJob,
  setMediaConversionExecutor,
  setMediaPathGenerator,
  type MediaEnabledEntity,
  type MediaAddResult,
} from '../src'
import type {
  getMediaDefinition as getRegistryMediaDefinition,
  resolveMediaCollection as resolveRegistryMediaCollection,
} from '../src/registry'
import { getContentSize } from '../src/runtime/binary'
import { mediaAdderInternals } from '../src/model/adder'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')
type RuntimeMediaEntity = {
  getMedia(collectionName?: string): Promise<unknown[]>
  getMediaUrls(collectionName?: string, conversionName?: string): Promise<string[]>
  getMediaPaths(collectionName?: string, conversionName?: string): Promise<string[]>
  getFirstMedia(collectionName?: string): Promise<unknown>
  getFirstMediaUrl(collectionName?: string, conversionName?: string): Promise<string | null>
  getFirstMediaPath(collectionName?: string, conversionName?: string): Promise<string | null>
  getFirstTemporaryUrl(collectionName?: string, conversionName?: string): Promise<string | null>
  hasMedia(collectionName?: string): Promise<boolean>
  clearMediaCollection(collectionName?: string): Promise<void>
  regenerateMedia(collectionName?: string, conversions?: string | readonly string[]): Promise<void>
  addMedia(source: Buffer): { toMediaCollection(collectionName?: string): Promise<unknown> }
  addMediaFromUrl(url: string): { toMediaCollection(collectionName?: string): Promise<unknown> }
}

async function expectMediaAdded(
  result: Promise<MediaAddResult>,
): Promise<MediaItem> {
  const upload = await result
  expect(upload.error).toBeNull()
  expect(upload.data).toBeInstanceOf(MediaItem)
  if (!upload.data) {
    throw new Error('Expected media upload to succeed.')
  }

  return upload.data
}

const postsTable = defineGeneratedTable('posts', {
  id: column.id(),
  title: column.string(),
  created_at: column.timestamp().defaultNow(),
  updated_at: column.timestamp().defaultNow(),
})

let storageState: Awaited<ReturnType<typeof createNativeMediaStorage>>

async function bootDatabase(): Promise<void> {
  const db = createDatabase({
    connectionName: 'default',
    adapter: createSQLiteAdapter({}),
    dialect: createDialect('sqlite'),
  })

  onTestFinished(() => db.disconnect())
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

async function createQueueTables(): Promise<void> {
  const schema = createSchemaService(DB.connection())
  await schema.createTable('jobs', (table) => {
    table.string('id').primaryKey()
    table.string('job')
    table.string('connection')
    table.string('queue')
    table.text('payload')
    table.integer('attempts').default(0)
    table.integer('max_attempts').default(1)
    table.bigInteger('available_at')
    table.bigInteger('reserved_at').nullable()
    table.string('reservation_id').nullable()
    table.bigInteger('created_at')
  })
}

async function createTempMediaFile(
  fileName: string,
  contents: string,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'holo-media-'))
  const path = join(directory, fileName)
  await writeFile(path, contents)
  return path
}

async function assertNativeImageConversion(path: string | undefined): Promise<void> {
  if (!path) throw new Error('Expected a persisted image conversion path')
  const bytes = await Storage.disk('public').getBytes(path)
  if (!bytes) throw new Error('Expected persisted image conversion bytes')
  const metadata = await sharp(Buffer.from(bytes)).metadata()
  expect(metadata.format).toBe('jpeg')
  expect(metadata.width).toBe(2)
  expect(metadata.height).toBe(2)
}

async function createImageBuffer(
  format: 'jpeg' | 'png' = 'jpeg',
): Promise<Buffer> {
  const base = sharp({
    create: {
      width: 8,
      height: 6,
      channels: 3,
      background: { r: 220, g: 40, b: 90 },
    },
  })

  return format === 'png'
    ? base.png().toBuffer()
    : base.jpeg().toBuffer()
}

async function* countStreamedBytes(
  chunks: AsyncIterable<Uint8Array>,
  observed: { streamedBytes: number },
): AsyncGenerator<Uint8Array> {
  for await (const chunk of chunks) {
    observed.streamedBytes += chunk.byteLength
    yield chunk
  }
}

function observeDiskReads(overrides: {
  readonly stat?: (path: string) => Promise<StorageFileMetadata | null>
} = {}): { streamedBytes: number, fullReads: number } {
  const observed = { streamedBytes: 0, fullReads: 0 }
  const openDisk = Storage.disk.bind(Storage)
  vi.spyOn(Storage, 'disk').mockImplementation((diskName?: string) => {
    const disk = openDisk(diskName)
    return {
      ...disk,
      stat: overrides.stat ?? (async path => await disk.stat(path)),
      getBytes: async (path: string) => {
        observed.fullReads += 1
        return await disk.getBytes(path)
      },
      readStream: async (path: string, streamOptions?: Parameters<StorageDisk['readStream']>[1]) => {
        const chunks = await disk.readStream(path, streamOptions)
        return chunks ? countStreamedBytes(chunks, observed) : null
      },
    } as StorageDisk
  })
  onTestFinished(() => { vi.restoreAllMocks() })
  return observed
}

function createAnimatedGif(frameCount: number): Buffer {
  const frame = Buffer.from([0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0x00])
  return Buffer.concat([
    Buffer.from('GIF89a', 'ascii'),
    Buffer.from([1, 0, 1, 0, 0, 0, 0]),
    ...Array.from({ length: frameCount }, () => frame),
    Buffer.from([0x3b]),
  ])
}

async function createRemoteMediaServer(handler: RequestListener) {
  const server = createServer(handler)
  await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected an HTTP fixture port')
  onTestFinished(() => new Promise<void>((resolveClosed, reject) => {
    server.close(error => error ? reject(error) : resolveClosed())
    server.closeAllConnections()
  }))
  mediaAdderInternals.setRemoteMediaDownloader(async (url, signal) => await mediaAdderInternals.requestRemoteMedia(
    new URL(`${url.pathname}${url.search}`, `http://media.test:${address.port}`),
    { address: '127.0.0.1', family: 4 },
    signal,
  ))
}

describe('@holo-js/media', () => {
  beforeEach(async () => {
    mediaAdderInternals.resetRemoteMediaTransport()
    resetDB()
    resetQueueRegistry()
    await resetQueueRuntime()
    resetMediaRuntime()
    storageState = await createNativeMediaStorage()
    await bootDatabase()
    configureQueueRuntime()
  })

  it('defines and normalizes immutable media project configuration', () => {
    expect(normalizeMediaConfig()).toEqual({})
    expect(Object.isFrozen(normalizeMediaConfig({ disk: 'public' }))).toBe(true)
    expect(defineMediaConfig({ disk: 's3' })).toEqual({ disk: 's3' })
  })

  it('normalizes media definitions and validates collection references', () => {
    const definition = normalizeMediaDefinition({
      collections: [
        collection('images').acceptsExtensions(['.JPG']).acceptsMimeTypes([' Image/JPEG ']),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').quality(200).format('webp'),
      ],
    })

    expect(definition.collectionsByName.images!.acceptedExtensions).toEqual(['jpg'])
    expect(definition.collectionsByName.images!.acceptedMimeTypes).toEqual(['image/jpeg'])
    expect(definition.conversionsByName.thumb!.quality).toBe(100)

    expect(() => normalizeMediaDefinition({
      collections: [collection('images'), collection('images')],
    })).toThrow('Duplicate media collection')

    expect(() => normalizeMediaDefinition({
      collections: [collection('images')],
      conversions: [conversion('thumb').performOnCollections('missing')],
    })).toThrow('unknown collection "missing"')

    expect(() => normalizeMediaDefinition({
      conversions: [conversion('thumb'), conversion('thumb')],
    })).toThrow('Duplicate media conversion')
  })

  it('covers collection and conversion builder branches', () => {
    const docs = collection('docs')
      .disk(' public ')
      .conversionsDisk(' s3 ')
      .singleFile()
      .onlyKeepLatest(0)
      .acceptsMimeTypes([' Text/Plain ', ''])
      .acceptsExtensions([' .TXT ', ''])
      .maxSize(0)

    expect(docs.definition).toMatchObject({
      diskName: 'public',
      conversionsDiskName: 's3',
      singleFile: true,
      onlyKeepLatest: 1,
      acceptedMimeTypes: ['text/plain'],
      acceptedExtensions: ['txt'],
      maxFileSize: 1,
    })
    expect(normalizeCollectionDefinitions([docs.definition])[0]).toMatchObject({
      disk: 'public',
      conversionsDisk: 's3',
      maxSize: 1,
    })
    expect(normalizeCollectionDefinitions([
      collection('empty').disk(' ').conversionsDisk(' ').definition,
    ])[0]).toMatchObject({
      disk: undefined,
      conversionsDisk: undefined,
    })

    const thumb = conversion('thumb')
      .performOnCollections('images', '' as never)
      .width(0)
      .height(0)
      .fit('cover')
      .format('jpg')
      .quality(0)
      .queued()
      .nonQueued()

    expect(thumb.definition).toMatchObject({
      collections: ['images'],
      width: 1,
      height: 1,
      fit: 'cover',
      format: 'jpg',
      quality: 1,
      queued: false,
    })

    const resolved = resolveMediaDefinition(({ collection: buildCollection }) => ({
      collections: [buildCollection('factory')],
    }))
    expect(resolved.collections?.[0]?.name).toBe('factory')
  })

  it('reports binary content sizes for every supported input', () => {
    expect(getContentSize(Buffer.from('node'))).toBe(4)
    expect(getContentSize(new Uint8Array([1, 2, 3, 4, 5]))).toBe(5)
    expect(getContentSize(new ArrayBuffer(3))).toBe(3)
    expect(getContentSize(new Blob([Buffer.from('blob')]))).toBe(4)
  })

  it('rejects non-finite numeric media definition values', () => {
    const nonFiniteValues = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
    ] as const

    for (const value of nonFiniteValues) {
      expect(() => collection('docs').onlyKeepLatest(value)).toThrow('onlyKeepLatest must be a finite number')
      expect(() => collection('docs').maxSize(value)).toThrow('maxFileSize must be a finite number')
      expect(() => conversion('thumb').width(value)).toThrow('width must be a finite number')
      expect(() => conversion('thumb').height(value)).toThrow('height must be a finite number')
      expect(() => conversion('thumb').quality(value)).toThrow('quality must be a finite number')

      expect(() => normalizeCollectionDefinitions([{
        kind: 'collection',
        name: 'docs',
        singleFile: false,
        onlyKeepLatest: value,
        acceptedMimeTypes: [],
        acceptedExtensions: [],
      }])).toThrow('onlyKeepLatest must be a finite number')

      expect(() => normalizeCollectionDefinitions([{
        kind: 'collection',
        name: 'docs',
        singleFile: false,
        acceptedMimeTypes: [],
        acceptedExtensions: [],
        maxFileSize: value,
      }])).toThrow('maxFileSize must be a finite number')

      expect(() => normalizeConversionDefinitions([{
        kind: 'conversion',
        name: 'thumb',
        collections: [],
        width: value,
        queued: false,
      }])).toThrow('width must be a finite number')

      expect(() => normalizeConversionDefinitions([{
        kind: 'conversion',
        name: 'thumb',
        collections: [],
        height: value,
        queued: false,
      }])).toThrow('height must be a finite number')

      expect(() => normalizeConversionDefinitions([{
        kind: 'conversion',
        name: 'thumb',
        collections: [],
        quality: value,
        queued: false,
      }])).toThrow('quality must be a finite number')
    }
  })

  it('resolves registry fallbacks and path generator overrides', async () => {
    const PlainPost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const post = await PlainPost.create({ title: 'Plain' })

    expect(getMediaDefinition(PlainPost)).toBeUndefined()
    expect(() => requireMediaDefinition(PlainPost)).toThrow('is not configured for media')
    expect(() => requireMediaDefinitionForMorphClass('missing-model')).toThrow('is not configured for media')
    expect(resolveMediaCollection(PlainPost).name).toBe('default')
    expect(resolveMediaCollection(post as never, 'avatars').name).toBe('avatars')
    expect(resolveMediaConversion(PlainPost, 'thumb')).toBeUndefined()

    const manualDefinition = normalizeMediaDefinition({
      collections: [collection('manual')],
    })
    registerMediaDefinition({ definition: { name: 'ManualOnly' } } as never, manualDefinition)
    expect(getMediaDefinitionForMorphClass('ManualOnly')).toBe(manualDefinition)
    expect(requireMediaDefinitionForMorphClass('ManualOnly')).toBe(manualDefinition)

    const RegistryPost = defineMediaModel(defineModel(postsTable, {
      name: 'RegistryPost',
      fillable: ['title'],
    }), {
      collections: [collection('images')],
    })
    const registryCopyPath = `../src/registry.ts?registry-copy=${Date.now()}`
    const registryCopy = await import(registryCopyPath) as {
      getMediaDefinition: typeof getRegistryMediaDefinition
      resolveMediaCollection: typeof resolveRegistryMediaCollection
    }

    expect(registryCopy.getMediaDefinition(RegistryPost as never)).toBe(getMediaDefinition(RegistryPost))
    expect(registryCopy.resolveMediaCollection(RegistryPost as never, 'images').name).toBe('images')

    const generatedDefault = getMediaPathGenerator().conversionPath({
      uuid: 'abc/123',
      fileName: 'hero',
      collection: resolveMediaCollection(PlainPost),
      conversion: conversion('thumb').format('jpg').definition,
    })
    expect(generatedDefault).toBe('media/abc-123/conversions/thumb.jpg')
    expect(getMediaPathGenerator().conversionPath({
      uuid: 'abc/123',
      fileName: '',
      collection: resolveMediaCollection(PlainPost),
      conversion: conversion('raw').definition,
    })).toBe('media/abc-123/conversions/raw.bin')

    setMediaPathGenerator({
      originalPath() {
        return 'custom/original'
      },
      conversionPath() {
        return 'custom/conversion'
      },
    })

    expect(getMediaPathGenerator().originalPath({
      uuid: 'x',
      fileName: 'y',
      collection: resolveMediaCollection(PlainPost),
    })).toBe('custom/original')

    resetMediaPathGenerator()

    expect(getMediaPathGenerator().originalPath({
      uuid: 'x',
      fileName: 'y',
      collection: resolveMediaCollection(PlainPost),
    })).toBe('media/x/original/y')
  })

  it('returns empty media helpers on models without media configuration', async () => {
    const PlainPost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const post = await PlainPost.create({ title: 'Plain' })
    const runtimePost = post as unknown as RuntimeMediaEntity

    expect(await runtimePost.getMedia()).toEqual([])
    expect(await runtimePost.getMediaUrls()).toEqual([])
    expect(await runtimePost.getMediaPaths()).toEqual([])
    expect(await runtimePost.getFirstMedia()).toBeNull()
    expect(await runtimePost.getFirstMediaUrl()).toBeNull()
    expect(await runtimePost.getFirstMediaPath()).toBeNull()
    expect(await runtimePost.getFirstTemporaryUrl()).toBeNull()
    expect(await runtimePost.hasMedia()).toBe(false)
    await expect(runtimePost.clearMediaCollection()).resolves.toBeUndefined()
    await expect(runtimePost.regenerateMedia()).resolves.toBeUndefined()
    await expect(runtimePost.addMedia(Buffer.from('x')).toMediaCollection()).rejects.toThrow('is not configured for media')
    await expect(runtimePost.addMediaFromUrl('https://example.test/image.jpg').toMediaCollection()).rejects.toThrow('is not configured for media')
  })

  it('preserves media model method contracts and wraps static entity-producing results', () => {
    const categoriesTable = defineGeneratedTable('media_test_categories', {
      id: column.id(),
      name: column.string(),
    })
    const relatedPostsTable = defineGeneratedTable('media_test_posts', {
      id: column.id(),
      category_id: column.integer(),
      title: column.string(),
    })
    const Category = defineModel(categoriesTable)
    const RelatedBasePost = defineModel(relatedPostsTable, {
      fillable: ['title', 'category_id'],
      relations: {
        category: belongsTo(() => Category, { foreignKey: 'category_id' }),
      },
    })
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
      ],
    })

    type PostMediaEntity = MediaEnabledEntity<typeof postsTable, 'default' | 'images', 'thumb'>
    const RelatedPost = defineMediaModel(RelatedBasePost, {
      collections: [
        collection('images'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
      ],
    })
    const acceptsPostMediaEntity = (_value: PostMediaEntity | undefined) => {}
    const acceptsMediaEntityMethods = (
      _value: { getFirstMediaPath(collectionName?: 'default' | 'images', conversionName?: 'thumb'): Promise<string | null> } | undefined,
    ) => {}

    const acceptsFindValue = (_value: Parameters<typeof Post.find>[0]) => {}

    acceptsFindValue(1)
    // @ts-expect-error media models must preserve the base model primary-key type.
    acceptsFindValue({})

    const assertUserCallTypes = async () => {
      const firstWherePost = await Post.firstWhere('id', 1)
      const queryFirstPost = await Post.query().first()
      const whereFirstPost = await Post.where('id', 1).first()
      const foundPost = await Post.find(1)
      const foundOrFailPost = await Post.findOrFail(1)
      const firstPost = await Post.first()
      const firstOrFailPost = await Post.firstOrFail()
      const solePost = await Post.sole()
      const createdPost = await Post.create({ title: 'Created' })
      const inferredCreatedPost: Awaited<ReturnType<typeof Post.create>> = createdPost
      const inferredQueryPost: Awaited<ReturnType<ReturnType<typeof Post.query>['first']>> = queryFirstPost
      const updatedPost = await Post.update(1, { title: 'Updated' })
      const restoredPost = await Post.restore(1)
      const queryFoundPost = await Post.query().find(1)
      const queryFoundOrFailPost = await Post.query().findOrFail(1)
      const queryFirstOrFailPost = await Post.query().firstOrFail()
      const querySolePost = await Post.query().sole()
      const page = await Post.paginate()
      const relatedFirstWherePost = await RelatedPost.firstWhere('id', 1)
      const relatedWhereFirstPost = await RelatedPost.where('id', 1).first()
      const relatedWithFirstPost = await RelatedPost.with('category').where('id', 1).first()

      acceptsPostMediaEntity(firstWherePost)
      acceptsPostMediaEntity(queryFirstPost)
      acceptsPostMediaEntity(whereFirstPost)
      acceptsPostMediaEntity(foundPost)
      acceptsPostMediaEntity(foundOrFailPost)
      acceptsPostMediaEntity(firstPost)
      acceptsPostMediaEntity(firstOrFailPost)
      acceptsPostMediaEntity(solePost)
      acceptsPostMediaEntity(createdPost)
      acceptsPostMediaEntity(inferredCreatedPost)
      acceptsPostMediaEntity(inferredQueryPost)
      acceptsPostMediaEntity(updatedPost)
      acceptsPostMediaEntity(restoredPost)
      acceptsPostMediaEntity(queryFoundPost)
      acceptsPostMediaEntity(queryFoundOrFailPost)
      acceptsPostMediaEntity(queryFirstOrFailPost)
      acceptsPostMediaEntity(querySolePost)
      acceptsPostMediaEntity(page.data[0])
      acceptsMediaEntityMethods(relatedFirstWherePost)
      acceptsMediaEntityMethods(relatedWhereFirstPost)
      acceptsMediaEntityMethods(relatedWithFirstPost)
      expectTypeOf(relatedWithFirstPost?.getFirstMediaPath).toEqualTypeOf<
        ((collectionName?: 'default' | 'images', conversionName?: 'thumb') => Promise<string | null>) | undefined
      >()
      const acceptsLoadedCategory = (_value: object | null | undefined) => {}
      acceptsLoadedCategory(relatedWithFirstPost?.category)
    }

    void assertUserCallTypes

    expectTypeOf<Parameters<typeof Post.find>[0]>().toEqualTypeOf<number>()
    expectTypeOf<Parameters<typeof Post.findMany>[0]>().toEqualTypeOf<readonly number[]>()
  })

  it('keeps the undeclared default collection multi-file', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {})
    const post = await Post.create({ title: 'Default Collection' })

    expect(resolveMediaCollection(Post as never).singleFile).toBe(false)

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.txt',
    }).toMediaCollection()

    await post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.txt',
    }).toMediaCollection()

    const items = await post.getMedia()

    expect(items).toHaveLength(2)
    expect(items.map(item => item.fileName)).toEqual(['first.txt', 'second.txt'])
  })

  it('deletes attached media when its model is deleted', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })
    const Post = defineMediaModel(BasePost, {})
    const post = await Post.create({ title: 'Disposable' })
    const first = await expectMediaAdded(post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.txt',
    }).toMediaCollection())
    const second = await expectMediaAdded(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.txt',
    }).toMediaCollection())

    await post.delete()

    expect(await Media.query().count()).toBe(0)
    await expect(Storage.disk(first.record.disk).missing(first.record.path)).resolves.toBe(true)
    await expect(Storage.disk(second.record.disk).missing(second.record.path)).resolves.toBe(true)
  })

  it('runs every defineModel observer lifecycle on media models', async () => {
    const calls: string[] = []
    const observedPostsTable = defineGeneratedTable('observed_posts', {
      id: column.id(),
      title: column.string(),
      deleted_at: column.timestamp().nullable(),
    })
    const schema = createSchemaService(DB.connection())
    await schema.createTable('observed_posts', (table) => {
      table.id()
      table.string('title')
      table.softDeletes()
    })
    const BasePost = defineModel(observedPostsTable, {
      name: 'ObservedPost',
      fillable: ['title'],
      softDeletes: true,
      observers: [{
        retrieved() {
          calls.push('retrieved')
        },
        creating() {
          calls.push('creating')
        },
        created() {
          calls.push('created')
        },
        updating() {
          calls.push('updating')
        },
        updated() {
          calls.push('updated')
        },
        saving() {
          calls.push('saving')
        },
        saved() {
          calls.push('saved')
        },
        deleting() {
          calls.push('deleting')
        },
        trashed() {
          calls.push('trashed')
        },
        forceDeleting() {
          calls.push('forceDeleting')
        },
        forceDeleted() {
          calls.push('forceDeleted')
        },
        restoring() {
          calls.push('restoring')
        },
        restored() {
          calls.push('restored')
        },
        deleted() {
          calls.push('deleted')
        },
        replicating() {
          calls.push('replicating')
        },
      }],
    })
    const Post = defineMediaModel(BasePost, {})
    const created = await Post.create({ title: 'Observed' })
    const post = await Post.findOrFail(created.id)

    post.set('title', 'Updated')
    await post.save()
    post.replicate()
    await post.delete()
    await post.restore()
    await post.forceDelete()

    expect(calls).toEqual([
      'saving',
      'creating',
      'created',
      'saved',
      'retrieved',
      'saving',
      'updating',
      'updated',
      'saved',
      'replicating',
      'deleting',
      'trashed',
      'deleted',
      'restoring',
      'restored',
      'deleting',
      'forceDeleting',
      'forceDeleted',
      'deleted',
    ])
  })

  it('keeps media on soft delete and removes it on force delete', async () => {
    const softPostsTable = defineGeneratedTable('soft_posts', {
      id: column.id(),
      title: column.string(),
      deleted_at: column.timestamp().nullable(),
    })
    const schema = createSchemaService(DB.connection())
    await schema.createTable('soft_posts', (table) => {
      table.id()
      table.string('title')
      table.softDeletes()
    })
    const SoftPost = defineMediaModel(defineModel(softPostsTable, {
      name: 'SoftPost',
      fillable: ['title'],
      softDeletes: true,
    }), {})
    const post = await SoftPost.create({ title: 'Recoverable' })
    const media = await expectMediaAdded(post.addMedia({
      contents: Buffer.from('keep until force delete'),
      fileName: 'recoverable.txt',
    }).toMediaCollection())

    await post.delete()

    expect(await Media.query().count()).toBe(1)
    await expect(Storage.disk(media.record.disk).exists(media.record.path)).resolves.toBe(true)

    await post.forceDelete()

    expect(await Media.query().count()).toBe(0)
    await expect(Storage.disk(media.record.disk).missing(media.record.path)).resolves.toBe(true)
  })

  it('retains model and media deletion when postcommit file cleanup fails', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })
    const Post = defineMediaModel(BasePost, {})
    const post = await Post.create({ title: 'Atomic deletion' })
    const first = await expectMediaAdded(post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.txt',
    }).toMediaCollection())
    const second = await expectMediaAdded(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.txt',
    }).toMediaCollection())
    await storageState.failDelete(second.record.disk, second.record.path)

    await expect(post.delete()).rejects.toThrow('committed')

    await expect(Post.find(post.id)).resolves.toBeUndefined()
    expect(await Media.query().count()).toBe(0)
    await expect(Storage.disk(first.record.disk).exists(first.record.path)).resolves.toBe(false)
    await expect(Storage.disk(second.record.disk).exists(second.record.path)).resolves.toBe(true)
  })

  it('prefers the public disk for implicit attachments when the storage default is private', async () => {
    await storageState.setDefaultDisk('local')

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('misc'),
      ],
    })

    const post = await Post.create({ title: 'Implicit Public Disk' })
    const media = await post
      .addMedia(Buffer.from('original'))
      .usingFileName('photo.jpg')
      .toMediaCollection('misc')

    expect(media.record.disk).toBe('public')
    expect(media.getUrl()).toBeTruthy()
    expect(await Storage.disk('public').exists(media.record.path)).toBe(true)
    expect((await storageFiles('local')).length).toBe(0)
  })

  it('rejects invalid sources and handles ownerless entities', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .acceptsExtensions(['png'])
          .acceptsMimeTypes(['image/png'])
          .maxSize(100),
      ],
    })

    const draft = Post.make({ title: 'Draft' })
    expect(await draft.getFirstMedia('images')).toBeNull()
    expect(await draft.hasMedia('images')).toBe(false)
    await expect(draft.addMedia(Buffer.from('xx')).toMediaCollection('images')).rejects.toThrow('before it has a persisted primary key')

    const post = await Post.create({ title: 'Live' })
    const maxSizeResult = await post.addMedia({
      contents: Buffer.alloc(101),
      fileName: 'hero.png',
    }).toMediaCollection('images')
    expect(maxSizeResult.data).toBeNull()
    expect(maxSizeResult.error?.code).toBe('max_size_exceeded')
    expect(maxSizeResult.error?.collection).toBe('images')
    expect(maxSizeResult.error?.fileName).toBe('hero.png')
    expect(maxSizeResult.error?.maxSize).toBe(100)
    expect(maxSizeResult.error?.actualSize).toBe(101)
    expect(maxSizeResult.error?.status).toBe(422)
    expect(maxSizeResult.error?.message).toBe('The selected file must be 100 bytes or smaller.')

    const invalidMimeResult = await post.addMedia({
      contents: Buffer.from('ok'),
      fileName: 'hero.png',
    }).toMediaCollection('images')
    expect(invalidMimeResult.data).toBeNull()
    expect(invalidMimeResult.error?.code).toBe('invalid_mime_type')
    expect(invalidMimeResult.error?.acceptedMimeTypes).toEqual(['image/png'])

    const invalidExtensionResult = await post.addMedia({
      contents: pngPixel,
      fileName: 'hero.jpg',
    }).toMediaCollection('images')
    expect(invalidExtensionResult.data).toBeNull()
    expect(invalidExtensionResult.error?.code).toBe('invalid_extension')
    expect(invalidExtensionResult.error?.acceptedExtensions).toEqual(['png'])

    const success = await post.addMedia({
      contents: pngPixel,
      fileName: 'hero.png',
    }).toMediaCollection('images')
    expect(success.error).toBeNull()
    expect(success.data).toBeInstanceOf(MediaItem)

    const storedFileCount = (await storageFiles('public')).length
    await expect(post.addMedia({
      contents: pngPixel,
      fileName: 'hero.png',
    }).toMediaCollection('iamges' as never)).rejects.toThrow('Unknown media collection "iamges"')
    expect((await storageFiles('public')).length).toBe(storedFileCount)
  })

  it('records and validates the type detected from file contents instead of names or declarations', async () => {
    const Post = defineMediaModel(defineModel(postsTable, { fillable: ['title'] }), {
      collections: [
        collection('images').disk('public').acceptsMimeTypes(['image/png']),
        collection('spreadsheets').disk('public').acceptsMimeTypes(['text/csv']),
      ],
    })
    const post = await Post.create({ title: 'Detected types' })

    const renamedImage = await post.addMedia({ contents: pngPixel, fileName: 'upload.bin' }).toMediaCollection('images')
    expect(renamedImage.error).toBeNull()
    expect(renamedImage.data?.mimeType).toBe('image/png')

    const spreadsheet = await post.addMedia({ contents: Buffer.from('id,name\n1,Ava'), fileName: 'people.csv' }).toMediaCollection('spreadsheets')
    expect(spreadsheet.error).toBeNull()
    expect(spreadsheet.data?.mimeType).toBe('text/csv')

    for (const [fileName, contents] of [
      ['hero.png', 'not really a picture'],
      ['hero.png', '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><script>alert(1)</script></html>'],
      ['logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'],
    ] as const) {
      const rejected = await post.addMedia(new File([contents], fileName, { type: 'image/png' })).toMediaCollection('images')
      expect(rejected.data, fileName).toBeNull()
      expect(rejected.error?.code, fileName).toBe('invalid_mime_type')
    }
  })

  it('accepts MIME types case-insensitively during validation', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .acceptsExtensions(['png'])
          .acceptsMimeTypes([' Image/PNG ']),
      ],
    })

    const post = await Post.create({ title: 'Case Insensitive' })

    const result = await post.addMedia({
      contents: pngPixel,
      fileName: 'hero.png',
    }).toMediaCollection('images')
    expect(result.data).toBeInstanceOf(MediaItem)
    expect(result.error).toBeNull()
  })

  it('supports different source inputs and adder overrides', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('uploads')
          .disk('public')
          .acceptsExtensions(['txt', 'png'])
          .acceptsMimeTypes(['text/plain', 'image/png']),
      ],
    })

    const post = await Post.create({ title: 'Variants' })
    const path = await createTempMediaFile('notes.txt', 'notes')

    try {
      const fromStringPath = await post
        .addMedia(path)
        .usingName('Custom Name')
        .usingFileName('renamed.txt')
        .onDisk('local')
        .toMediaCollection('uploads')

      const fromPathObject = await post
        .addMedia({ path })
        .toMediaCollection('uploads')

      const fromArrayBuffer = await post
        .addMedia(new TextEncoder().encode('plain').buffer)
        .usingFileName('array.txt')
        .toMediaCollection('uploads')

      const fromBlob = await post
        .addMedia({ contents: new Blob([pngPixel]) })
        .usingFileName('blob.png')
        .toMediaCollection('uploads')

      const fromFile = await post
        .addMedia(new File([pngPixel], 'avatar.png', { type: 'image/png' }))
        .toMediaCollection('uploads')

      expect(fromStringPath.record.name).toBe('Custom Name')
      expect(fromStringPath.fileName).toBe('renamed.txt')
      expect(fromStringPath.getUrl()).toBeNull()
      expect(fromStringPath.getPath()).toBeNull()
      expect(fromPathObject.fileName).toBe('notes.txt')
      expect(fromArrayBuffer.fileName).toBe('array.txt')
      expect(fromBlob.mimeType).toBe('image/png')
      expect(fromBlob.size).toBe(pngPixel.length)
      expect(fromFile.fileName).toBe('avatar.png')
      expect(fromFile.mimeType).toBe('image/png')
      expect(fromFile.size).toBe(pngPixel.length)
      expect(await post.getMedia('uploads')).toHaveLength(5)
    } finally {
      await rm(path.slice(0, path.lastIndexOf('/')), { recursive: true, force: true })
    }
  })

  it('rejects local media paths outside upload directories', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('uploads').disk('public'),
      ],
    })

    const post = await Post.create({ title: 'Unsafe Path' })

    await expect(post.addMedia('/etc/hosts').toMediaCollection('uploads')).rejects.toThrow('allowed upload directory')
  })

  it('attaches media, generates conversions, and exposes direct model helpers', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`converted:${conversion.name}`),
          fileName: `${conversion.name}.${conversion.format ?? 'bin'}`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .acceptsExtensions(['jpg'])
          .onlyKeepLatest(2),
      ],
      conversions: [
        conversion('thumb')
          .performOnCollections('images')
          .format('webp')
          .width(320)
          .height(240),
      ],
    })

    const post = await Post.create({ title: 'Hero' })
    expectTypeOf(post.getFirstMediaUrl('images', 'thumb')).toEqualTypeOf<Promise<string | null>>()
    expectTypeOf(post.getFirstMediaPath('images', 'thumb')).toEqualTypeOf<Promise<string | null>>()
    const mediaRelation = Post.getRepository().getRelationDefinition('media')
    expect(mediaRelation.kind).toBe('morphMany')
    if (mediaRelation.kind === 'morphMany') {
      expect(mediaRelation.related()).toBe(Media)
    }

    const media = await post
      .addMedia({
        contents: Buffer.from('original-image'),
        fileName: 'hero.jpg',
      })
      .toMediaCollection('images')

    expect(media.collectionName).toBe('images')
    expect(media.getUrl()).toContain('https://cdn.test/public/media/')
    expect(media.getUrl('thumb')).toContain('/thumb.webp')
    expect(media.getPath()).toContain('/public/media/')
    expect(media.getTemporaryUrl('thumb')).toContain('https://app.test/storage/')

    expect(await post.hasMedia('images')).toBe(true)
    expect(await post.getMediaUrls('images', 'thumb')).toEqual([media.getUrl('thumb')!])
    expect(await post.getMediaPaths('images', 'thumb')).toEqual([media.getPath('thumb')!])
    expect(await post.getFirstMediaUrl('images')).toBe(media.getUrl())
    expect(await post.getFirstMediaUrl('images', 'thumb')).toBe(media.getUrl('thumb'))
    expect(await post.getFirstMediaPath('images', 'thumb')).toBe(media.getPath('thumb'))
    expect(await post.getFirstTemporaryUrl('images', 'thumb', { expiresIn: 60 })).toBe(media.getTemporaryUrl('thumb', { expiresIn: 60 }))
    expect(media.getEntity().get('collection_name')).toBe('images')
    expect(media.getAvailableConversions()).toEqual(['thumb'])

    const items = await post.getMedia('images')
    expect(items).toHaveLength(1)
    expect(() => resolveMediaCollection(Post, 'missing')).toThrow('Unknown media collection "missing"')
    expect(resolveMediaConversion(Post, 'thumb')?.name).toBe('thumb')
    expect(items[0]?.toJSON().generated_conversions).toMatchObject({
      thumb: {
        disk: 'public',
      },
    })

    const storedPaths = (await storageFiles('public')).sort()
    expect(storedPaths).toHaveLength(2)
    expect(storedPaths[0]).toContain('conversions/thumb.webp')
    expect(storedPaths[1]).toContain('original/hero.jpg')

    expect(await Media.query().count()).toBe(1)

    await post.clearMediaCollection('images')
    expect(await post.hasMedia('images')).toBe(false)
    expect(await Media.query().count()).toBe(0)
    expect((await storageFiles('public')).length).toBe(0)
  })

  it('runs built-in sharp conversions by default', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public').acceptsMimeTypes(['image/png']),
      ],
      conversions: [
        conversion('thumb')
          .performOnCollections('images')
          .format('webp')
          .width(2)
          .height(2)
          .fit('cover'),
      ],
    })

    const post = await Post.create({ title: 'Built-in' })
    const media = await post.addMedia({
      contents: await createImageBuffer('png'),
      fileName: 'hero.png',
    }).toMediaCollection('images')

    expect(getMediaConversionExecutor()).toBeDefined()

    const conversions = media.record.generated_conversions
    const thumbPath = conversions.thumb?.path
    expect(thumbPath).toBeTruthy()

    const thumbBytes = thumbPath
      ? await Storage.disk('public').getBytes(thumbPath)
      : null
    expect(thumbBytes).toBeInstanceOf(Uint8Array)

    const metadata = await sharp(Buffer.from(thumbBytes!)).metadata()
    expect(metadata.format).toBe('webp')
    expect(metadata.width).toBe(2)
    expect(metadata.height).toBe(2)
  })

  it('cleans up the stored original when conversion generation fails', async () => {
    setMediaConversionExecutor({
      async generate() {
        throw new Error('conversion failed')
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Failed Conversion Cleanup' })

    await expect(post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')).rejects.toThrow('conversion failed')

    expect((await storageFiles('public')).length).toBe(0)
    expect(await Media.query().count()).toBe(0)
  })

  it('covers the default sharp executor output branches', async () => {
    const executor = createDefaultMediaConversionExecutor()
    const image = await createImageBuffer()

    expect(await executor.generate({
      source: {
        uuid: 'plain-text',
        fileName: 'notes',
        extension: undefined,
        mimeType: undefined,
        size: 4,
        contents: Buffer.from('note'),
      },
      collection: collection('docs').definition,
      conversion: conversion('skip').definition,
    })).toBeNull()

    const formats = [
      ['jpg', 'jpg'],
      ['png', 'png'],
      ['avif', 'avif'],
      ['webp', 'webp'],
    ] as const

    for (const [format, extension] of formats) {
      const result = await executor.generate({
        source: {
          uuid: `source-${format}`,
          fileName: 'hero.jpg',
          extension: 'jpg',
          mimeType: 'image/jpeg',
          size: image.byteLength,
          contents: format === 'jpg' ? new Uint8Array(image) : image,
        },
        collection: collection('images').definition,
        conversion: conversion(format)
          .format(format)
          .width(2)
          .quality(70)
          .fit(format === 'jpg' ? undefined as never : 'inside')
          .definition,
      })

      expect(result?.fileName).toBe(`hero.${extension}`)
      expect(result?.mimeType).toBeTruthy()
    }

    const containResult = await executor.generate({
      source: {
        uuid: 'contain-source',
        fileName: 'hero.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        size: image.byteLength,
        contents: image,
      },
      collection: collection('images').definition,
      conversion: conversion('contain').format('jpeg').width(2).fit('contain').definition,
    })

    expect(containResult?.fileName).toBe('hero.jpeg')

    const avifDefaultQuality = await executor.generate({
      source: {
        uuid: 'avif-default',
        fileName: 'hero.jpg',
        extension: 'jpg',
        mimeType: 'image/jpeg',
        size: image.byteLength,
        contents: image,
      },
      collection: collection('images').definition,
      conversion: conversion('avif-default').format('avif').width(2).definition,
    })

    expect(avifDefaultQuality?.fileName).toBe('hero.avif')

    const svgResult = await executor.generate({
      source: {
        uuid: 'svg-source',
        fileName: '',
        extension: 'svg',
        mimeType: 'image/svg+xml',
        size: 64,
        contents: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4" fill="red"/></svg>'),
      },
      collection: collection('images').definition,
      conversion: conversion('fallback').definition,
    })

    expect(svgResult?.fileName).toBe('media.png')

    await expect(executor.generate({
      source: {
        uuid: 'broken-image',
        fileName: 'broken.png',
        extension: 'png',
        mimeType: 'image/png',
        size: 7,
        contents: Buffer.from('broken!'),
      },
      collection: collection('images').definition,
      conversion: conversion('broken').definition,
    })).rejects.toThrow('Failed to generate conversion')
  })

  it('supports single-file collections and replaces the previous file', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const firstPath = (await storageFiles('public'))[0]
    expect(firstPath).toContain('first.jpg')

    await post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')

    const storedPaths = (await storageFiles('public'))
    expect(storedPaths).toHaveLength(1)
    expect(storedPaths[0]).toContain('second.jpg')
    expect(await post.getMedia('avatars')).toHaveLength(1)
  })

  it('restores single-file storage when a replacement transaction rolls back', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
    })

    const post = await Post.create({ title: 'Avatar Rollback' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const firstPath = (await storageFiles('public'))[0]
    expect(firstPath).toContain('first.jpg')

    await expect(DB.transaction(async () => {
      await post.addMedia({
        contents: Buffer.from('second'),
        fileName: 'second.jpg',
      }).toMediaCollection('avatars')

      throw new Error('rollback media replacement')
    })).rejects.toThrow('rollback media replacement')

    const storedPaths = (await storageFiles('public'))
    expect(storedPaths).toEqual([firstPath])
    expect(await Storage.disk('public').get(firstPath!)).toBe('first')

    const media = await post.getMedia('avatars')
    expect(media).toHaveLength(1)
    expect(media[0]?.record.path).toBe(firstPath)
  })

  it('retains committed replacement when queued dispatch fails outside transactions', async () => {
    const queueHarness = await createNativeRedisQueue()
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: queueHarness.redisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
      conversions: [
        conversion('thumb').performOnCollections('avatars').queued(),
      ],
    })

    const post = await Post.create({ title: 'Avatar Queue Failure' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const firstPath = (await storageFiles('public'))[0]
    expect(firstPath).toContain('first.jpg')

    await queueHarness.failWrites()

    await expect(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')).rejects.toThrow('committed')

    const media = await post.getMedia('avatars')
    expect(media).toHaveLength(1)
    expect(media[0]?.fileName).toBe('second.jpg')
    expect(await Storage.disk('public').exists(firstPath!)).toBe(false)
    expect(await Storage.disk('public').get(media[0]!.record.path)).toBe('second')
  })

  it('preserves the existing single-file media when replacement conversion fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`generated:${conversion.name}`),
          fileName: `${conversion.name}.webp`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
      conversions: [
        conversion('thumb').performOnCollections('avatars').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const firstPath = (await storageFiles('public'))[0]
    setMediaConversionExecutor({
      async generate() {
        throw new Error('conversion failed')
      },
    })

    await expect(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')).rejects.toThrow('conversion failed')

    expect(await post.getMedia('avatars')).toHaveLength(1)
    expect(await Storage.disk('public').exists(firstPath!)).toBe(true)
  })

  it('retains committed single-file media when deleting the previous file fails', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const existing = await post.getFirstMedia('avatars')
    expect(existing).not.toBeNull()
    await storageState.failDelete('public', existing!.record.path)

    await expect(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')).rejects.toThrow('committed')

    const items = await post.getMedia('avatars')
    expect(items).toHaveLength(1)
    expect(items[0]?.fileName).toBe('second.jpg')

    const storedPaths = (await storageFiles('public'))
    expect(storedPaths).toHaveLength(2)
    expect(storedPaths.some(path => path.includes('second.jpg'))).toBe(true)
  })

  it('retains committed replacement when later legacy file cleanup fails', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })
    const modelType = post.getRepository().definition.morphClass
    const modelId = String(post.get('id'))
    const legacyRows = [
      { uuid: 'avatar-1', fileName: 'first.txt', order: 1 },
      { uuid: 'avatar-2', fileName: 'second.txt', order: 2 },
    ]

    for (const row of legacyRows) {
      const path = `media/${row.uuid}/original/${row.fileName}`
      await Storage.disk('public').put(path, Buffer.from(row.fileName))
      await Media.create({
        uuid: row.uuid,
        model_type: modelType,
        model_id: modelId,
        collection_name: 'avatars',
        name: row.fileName,
        file_name: row.fileName,
        disk: 'public',
        conversions_disk: 'public',
        mime_type: 'text/plain',
        extension: 'txt',
        size: row.fileName.length,
        path,
        generated_conversions: {} as never,
        order_column: row.order,
      })
    }

    await storageState.failDelete('public', 'media/avatar-2/original/second.txt')

    await expect(post.addMedia({
      contents: Buffer.from('replacement'),
      fileName: 'replacement.txt',
    }).toMediaCollection('avatars')).rejects.toThrow('committed')

    const items = await post.getMedia('avatars')
    expect(items.map(item => item.fileName)).toEqual(['replacement.txt'])
    expect(await Storage.disk('public').exists('media/avatar-1/original/first.txt')).toBe(false)
    expect(await Storage.disk('public').exists('media/avatar-2/original/second.txt')).toBe(true)
    expect((await storageFiles('public')).some(path => path.includes('replacement.txt'))).toBe(true)
  })

  it('retains new conversions when committed replacement cleanup fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`generated:${conversion.name}`),
          fileName: `${conversion.name}.webp`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('avatars').disk('public').singleFile(),
      ],
      conversions: [
        conversion('thumb').performOnCollections('avatars').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Avatar' })

    await post.addMedia({
      contents: Buffer.from('first'),
      fileName: 'first.jpg',
    }).toMediaCollection('avatars')

    const existing = await post.getFirstMedia('avatars')
    expect(existing).not.toBeNull()
    await storageState.failDelete('public', existing!.record.path)

    await expect(post.addMedia({
      contents: Buffer.from('second'),
      fileName: 'second.jpg',
    }).toMediaCollection('avatars')).rejects.toThrow('committed')

    const storedPaths = (await storageFiles('public'))
    expect(storedPaths).toHaveLength(3)
    expect(storedPaths.some(path => path.includes('second.jpg'))).toBe(true)
    const current = await post.getFirstMedia('avatars')
    expect(current?.fileName).toBe('second.jpg')
    expect(await Storage.disk('public').exists(current!.record.generated_conversions!.thumb!.path)).toBe(true)
  })

  it('retains committed deletion when conversion file cleanup fails', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').format('webp'),
      ],
    })

    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('thumb'),
          fileName: 'thumb.webp',
          mimeType: 'image/webp',
        }
      },
    })

    const post = await Post.create({ title: 'Avatar' })
    const media = await post.addMedia({
      contents: Buffer.from('original'),
      fileName: 'first.jpg',
    }).toMediaCollection('images')

    const thumbPath = media.record.generated_conversions.thumb?.path
    expect(thumbPath).toBeTruthy()
    await storageState.failDelete('public', thumbPath!)

    await expect(media.delete()).rejects.toThrow('committed')

    expect(await Storage.disk('public').exists(media.record.path)).toBe(false)
    expect(await Storage.disk('public').exists(thumbPath!)).toBe(true)
    expect(await Media.query().count()).toBe(0)
  })

  it('retains committed latest media when overflow cleanup fails', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('gallery').disk('public').onlyKeepLatest(1),
      ],
    })

    const post = await Post.create({ title: 'Gallery' })
    const modelType = post.getRepository().definition.morphClass
    const modelId = String(post.get('id'))
    const originals = [
      {
        uuid: 'gallery-1',
        name: 'one',
        fileName: 'one.txt',
        order: 1,
        conversionsDisk: 'public',
        generatedConversions: {
          missing: {
            path: 'media/gallery-1/conversions/missing.txt',
          },
          skipped: {} as never,
        } as never,
      },
      {
        uuid: 'gallery-2',
        name: 'two',
        fileName: 'two.txt',
        order: 2,
        conversionsDisk: null as never,
        generatedConversions: null as never,
      },
      { uuid: 'gallery-3', name: 'three', fileName: 'three.txt', order: 3, conversionsDisk: 'public', generatedConversions: {} as never },
    ]

    for (const original of originals) {
      const path = `media/${original.uuid}/original/${original.fileName}`
      await Storage.disk('public').put(path, Buffer.from(original.name))
      await DB.table('media').insert({
        uuid: original.uuid,
        model_type: modelType,
        model_id: modelId,
        collection_name: 'gallery',
        name: original.name,
        file_name: original.fileName,
        disk: 'public',
        conversions_disk: original.conversionsDisk,
        mime_type: 'text/plain',
        extension: 'txt',
        size: 1,
        path,
        generated_conversions: original.generatedConversions === null ? 'null' : original.generatedConversions,
        order_column: original.order,
      })
    }

    await storageState.failDelete('public', `media/gallery-2/original/two.txt`)

    await expect(
      post.addMedia({ contents: Buffer.from('4'), fileName: 'four.txt' }).toMediaCollection('gallery'),
    ).rejects.toThrow('committed')

    const items = await post.getMedia('gallery')
    expect(items.map(item => item.fileName)).toEqual(['four.txt'])
    expect(await Storage.disk('public').exists('media/gallery-1/original/one.txt')).toBe(false)
    expect(await Storage.disk('public').exists('media/gallery-2/original/two.txt')).toBe(true)
    expect(await Storage.disk('public').exists('media/gallery-3/original/three.txt')).toBe(false)
    expect((await storageFiles('public')).some(path => path.includes('four.txt'))).toBe(true)
  })

  it('cleans up uploaded files when conversion generation fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        if (conversion.name === 'thumb') {
          return {
            contents: Buffer.from('thumb'),
            fileName: 'thumb.webp',
            mimeType: 'image/webp',
          }
        }

        throw new Error('conversion failed')
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('uploads').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('uploads').format('webp'),
        conversion('card').performOnCollections('uploads').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Upload' })

    await expect(post.addMedia({
      contents: Buffer.from('orphan'),
      fileName: 'orphan.txt',
    }).toMediaCollection('uploads')).rejects.toThrow('conversion failed')

    expect((await storageFiles('public')).length).toBe(0)
  })

  it('handles conversion executor edge cases and media item fallbacks', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        if (conversion.name === 'skip') {
          return null
        }

        return {
          contents: new Blob([Buffer.from('variant')]),
          fileName: 'variant',
          disk: 'public',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('skip').performOnCollections('images'),
        conversion('broken').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Broken' })
    const media = await post.addMedia({
      contents: Buffer.from('original'),
      fileName: 'image.txt',
    }).toMediaCollection('images')

    expect(media.getUrl('skip' as never)).toBeNull()
    expect(media.getPath('skip' as never)).toBeNull()
    expect(media.getPath('broken')).toBe(`/public/${media.record.generated_conversions.broken!.path}`)
    expect(media.getUrl('broken')).toContain('https://cdn.test/public/media/')
    expect(media.getTemporaryUrl('skip' as never)).toBeNull()
    expect(media.getTemporaryUrl('broken')).toContain('signature=')

    const manual = await Media.create({
      uuid: 'manual',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'images',
      name: 'manual',
      file_name: 'manual.txt',
      disk: 'broken',
      conversions_disk: null as never,
      mime_type: null as never,
      extension: null as never,
      size: 1,
      path: 'manual/original.txt',
      generated_conversions: {
        broken: {
          path: 'manual/conversion.txt',
        },
        skipped: {} as never,
      } as never,
      order_column: 99,
    })

    const detachedItem = new MediaItem(manual)
    expect(detachedItem.record.file_name).toBe('manual.txt')
    expect(detachedItem.toJSON().file_name).toBe('manual.txt')
    expect(detachedItem.getUrl()).toBeNull()
    expect(detachedItem.getPath()).toBeNull()
    expect(detachedItem.getTemporaryUrl()).toBeNull()

    await expect(detachedItem.delete()).rejects.toThrow('committed')
    expect(await Media.find(manual.id)).toBeUndefined()

    const publicManual = await Media.create({
      uuid: 'manual-2',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'images',
      name: 'manual-2',
      file_name: 'manual-2.txt',
      disk: 'public',
      conversions_disk: 's3',
      mime_type: 'text/plain',
      extension: 'txt',
      size: 1,
      path: 'manual-2/original.txt',
      generated_conversions: {
        fallback: {
          path: 'manual-2/fallback.txt',
        },
      } as never,
      order_column: 100,
    })

    const conversionDiskItem = new MediaItem(publicManual)
    expect(conversionDiskItem.getPath('fallback' as never)).toBe('/s3/manual-2/fallback.txt')

    const { id: _omittedId, created_at: _omittedCreatedAt, updated_at: _omittedUpdatedAt, ...manualAttributes } = publicManual.toAttributes()
    const absoluteUrlMedia = await Media.create({
      ...manualAttributes,
      uuid: 'absolute-url',
      disk: 'absolute',
      path: 'absolute/original.txt',
      generated_conversions: {},
    })
    const relativeUrlMedia = await Media.create({
      ...manualAttributes,
      uuid: 'relative-url',
      disk: 'relative',
      path: 'relative/original.txt',
      generated_conversions: {},
    })
    expect(new MediaItem(absoluteUrlMedia).getPath()).toBe('/assets/absolute/original.txt')
    expect(new MediaItem(relativeUrlMedia).getPath()).toBe('/assets/relative/original.txt')
  })

  it('treats string sources as local paths and never downloads them', async () => {
    let requests = 0
    await createRemoteMediaServer((_request, response) => {
      requests += 1
      response.end(pngPixel)
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public')],
    })

    const post = await Post.create({ title: 'String source' })
    await expect(post.addMedia('https://example.test/photo.png').toMediaCollection('images'))
      .rejects.toThrow('Use addMediaFromUrl() to download a URL.')
    await expect(post.addMedia({ url: 'https://example.test/photo.png' } as never).toMediaCollection('images'))
      .rejects.toThrow('Use addMediaFromUrl() to download a URL.')
    expect(requests).toBe(0)
    expect(await post.getMedia('images')).toEqual([])
  })

  it('attaches files already on a storage disk and leaves the source in place', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public')],
    })

    await Storage.disk('local').put('uploads/photo.png', pngPixel)
    const post = await Post.create({ title: 'From disk' })

    const media = await expectMediaAdded(
      post.addMediaFromDisk('uploads/photo.png', 'local')
        .usingName('Disk Photo')
        .toMediaCollection('images'),
    )

    expect(media.record.disk).toBe('public')
    expect(media.fileName).toBe('photo.png')
    expect(media.record.name).toBe('Disk Photo')
    expect(media.mimeType).toBe('image/png')
    expect(await Storage.disk('local').exists('uploads/photo.png')).toBe(true)
    expect(Buffer.from(await Storage.disk('public').getBytes(media.record.path) ?? [])).toEqual(pngPixel)

    await expect(post.addMediaFromDisk('uploads/missing.png', 'local').toMediaCollection('images'))
      .rejects.toThrow('"uploads/missing.png" was not found on disk "local"')
  })

  it('rejects oversize disk files from their metadata without reading the body', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public').maxSize(1024)],
    })

    await Storage.disk('local').put('uploads/large.bin', Buffer.alloc(2 * 1024 * 1024, 1))
    const observed = observeDiskReads()
    const post = await Post.create({ title: 'Oversize disk file' })

    const result = await post.addMediaFromDisk('uploads/large.bin', 'local').toMediaCollection('images')

    expect(result.data).toBeNull()
    expect(result.error?.code).toBe('max_size_exceeded')
    expect(result.error?.actualSize).toBe(2 * 1024 * 1024)
    expect(observed).toEqual({ streamedBytes: 0, fullReads: 0 })
  })

  it('stops streaming an oversize disk file once it passes the limit when metadata is unavailable', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public').maxSize(1024)],
    })

    await Storage.disk('local').put('uploads/large.bin', Buffer.alloc(1024 * 1024, 1))
    const observed = observeDiskReads({
      stat: async () => {
        throw new StorageMetadataUnsupportedError()
      },
    })
    const post = await Post.create({ title: 'Unknown size disk file' })

    const result = await post.addMediaFromDisk('uploads/large.bin', 'local').toMediaCollection('images')

    expect(result.error?.code).toBe('max_size_exceeded')
    expect(observed.fullReads).toBe(0)
    expect(observed.streamedBytes).toBeGreaterThan(0)
    expect(observed.streamedBytes).toBeLessThanOrEqual(64 * 1024)
  })

  it('stops streaming a disk file whose stored metadata understates its size', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public').maxSize(1024)],
    })

    await Storage.disk('local').put('uploads/large.bin', Buffer.alloc(1024 * 1024, 1))
    const observed = observeDiskReads({
      stat: async () => ({ size: 512, mimeType: null }),
    })
    const post = await Post.create({ title: 'Stale size disk file' })

    const result = await post.addMediaFromDisk('uploads/large.bin', 'local').toMediaCollection('images')

    expect(result.error?.code).toBe('max_size_exceeded')
    expect(observed.fullReads).toBe(0)
    expect(observed.streamedBytes).toBeLessThanOrEqual(64 * 1024)
  })

  it('attaches disk files that fit the collection limit', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public').maxSize(1024)],
    })

    await Storage.disk('local').put('uploads/small.png', pngPixel)
    const post = await Post.create({ title: 'Small disk file' })
    const media = await expectMediaAdded(post.addMediaFromDisk('uploads/small.png', 'local').toMediaCollection('images'))

    expect(Buffer.from(await Storage.disk('public').getBytes(media.record.path) ?? [])).toEqual(pngPixel)
  })

  it('stores collections without a disk on the configured media disk', async () => {
    configureConfigRuntime({ app: { timezone: 'UTC' }, media: { disk: 'local' } } as never)
    onTestFinished(() => resetConfigRuntime())

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images')],
    })

    const post = await Post.create({ title: 'Configured disk' })
    const media = await expectMediaAdded(post.addMedia(pngPixel).toMediaCollection('images'))

    expect(media.record.disk).toBe('local')
    expect(await Storage.disk('local').exists(media.record.path)).toBe(true)
  })

  it('abandons remote downloads that run longer than thirty seconds', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public')],
    })

    const post = await Post.create({ title: 'Slow remote' })
    let downloadSignal: AbortSignal | undefined
    let downloadStarted: () => void = () => {}
    const started = new Promise<void>((resolveStarted) => {
      downloadStarted = resolveStarted
    })
    mediaAdderInternals.setRemoteMediaDownloader((_url, signal) => {
      downloadSignal = signal
      downloadStarted()
      return new Promise<Response>(() => {})
    })

    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })

    const upload = post.addMediaFromUrl('https://example.test/slow.png').toMediaCollection('images')
    const assertion = expect(upload).rejects.toThrow('must finish within 30 seconds')
    await started
    await vi.advanceTimersByTimeAsync(29_999)
    expect(downloadSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    await assertion
    expect(downloadSignal?.aborted).toBe(true)
  })

  it('closes a stalled remote response when the download deadline passes', async () => {
    let closeServerResponse: () => void = () => {}
    const serverResponseClosed = new Promise<void>((resolveClosed) => {
      closeServerResponse = resolveClosed
    })
    let respond: () => void = () => {}
    const serverResponded = new Promise<void>((resolveResponded) => {
      respond = resolveResponded
    })
    await createRemoteMediaServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'image/png', 'content-length': '4096' })
      response.write(pngPixel)
      response.on('close', () => closeServerResponse())
      respond()
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public')],
    })

    const post = await Post.create({ title: 'Stalled remote' })
    vi.useFakeTimers()
    onTestFinished(() => { vi.useRealTimers() })

    const upload = post.addMediaFromUrl('https://example.test/stalled.png').toMediaCollection('images')
    const assertion = expect(upload).rejects.toThrow('must finish within 30 seconds')
    await serverResponded
    await vi.advanceTimersByTimeAsync(30_000)

    await assertion
    await serverResponseClosed
  })

  it('generates image conversions before opening the database write transaction', async () => {
    const scopes: string[] = []
    setMediaConversionExecutor({
      async generate({ conversion }) {
        scopes.push(DB.connection().getScope().kind)
        return {
          contents: Buffer.from(conversion.name),
          fileName: `${conversion.name}.txt`,
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public')],
      conversions: [conversion('thumb').performOnCollections('images')],
    })

    const post = await Post.create({ title: 'Transaction scope' })
    const media = await expectMediaAdded(post.addMedia(await createImageBuffer()).toMediaCollection('images'))

    expect(scopes).toEqual(['root'])
    expect(media.getAvailableConversions()).toEqual(['thumb'])
  })

  it('rejects image conversions whose decoded size exceeds the upload pixel limit', async () => {
    const oversized = await sharp({
      create: {
        width: 7001,
        height: 5715,
        channels: 3,
        background: { r: 20, g: 40, b: 60 },
      },
    }).jpeg().toBuffer()

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public')],
      conversions: [conversion('thumb').performOnCollections('images')],
    })

    const post = await Post.create({ title: 'Oversized' })
    await expect(post.addMedia(oversized).toMediaCollection('images'))
      .rejects.toThrow('Failed to generate conversion "thumb"')
    expect(await post.getMedia('images')).toEqual([])
    expect(await storageFiles('public')).toEqual([])
  })

  it('rejects animated image conversions with more frames than the upload limit', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [collection('images').disk('public')],
      conversions: [conversion('thumb').performOnCollections('images')],
    })

    const post = await Post.create({ title: 'Too many frames' })
    await expect(post.addMedia(createAnimatedGif(1_000)).toMediaCollection('images')).resolves.toMatchObject({ error: null })
    await expect(post.addMedia(createAnimatedGif(1_001)).toMediaCollection('images'))
      .rejects.toThrow('Failed to generate conversion "thumb"')
    expect(await post.getMedia('images')).toHaveLength(1)
  })

  it('supports remote uploads and selective regeneration', async () => {
    const imageBytes = await createImageBuffer()
    await createRemoteMediaServer((request, response) => {
      if (!request.url?.includes('no-header')) response.setHeader('content-type', 'image/jpeg')
      response.end(imageBytes)
    })

    let revision = 'v1'

    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`${revision}:${conversion.name}`),
          fileName: `${conversion.name}.txt`,
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
        collection('downloads').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
        conversion('card').performOnCollections('images'),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote' })
      const media = await post
        .addMediaFromUrl('https://example.test/remote.jpg')
        .usingName('Remote Hero')
        .toMediaCollection('images')

      expect(media.record.name).toBe('Remote Hero')
      expect(media.fileName).toBe('remote.jpg')
      expect(media.getAvailableConversions()).toEqual(['thumb', 'card'])

      const thumbPath = media.record.generated_conversions.thumb?.path
      const cardPath = media.record.generated_conversions.card?.path
      expect(thumbPath).toBeTruthy()
      expect(cardPath).toBeTruthy()
      const resolvedThumbPath = thumbPath as string
      const resolvedCardPath = cardPath as string
      expect(await Storage.disk('public').get(resolvedThumbPath)).toBe('v1:thumb')
      expect(await Storage.disk('public').get(resolvedCardPath)).toBe('v1:card')

      revision = 'v2'
      await media.regenerate('thumb')

      expect(await Storage.disk('public').get(resolvedThumbPath)).toBe('v2:thumb')
      expect(await Storage.disk('public').get(resolvedCardPath)).toBe('v1:card')

      revision = 'v3'
      await post.regenerateMedia('images', 'card')

      expect(await Storage.disk('public').get(resolvedCardPath)).toBe('v3:card')

      await expect(post.regenerateMedia('images', 'missing' as never)).rejects.toThrow('Unknown media conversion')

      const download = await post
        .addMediaFromUrl('https://example.test')
        .toMediaCollection('downloads')

      expect(download.fileName).toBe('media.bin')
      await expect(post.regenerateMedia('downloads', 'thumb' as never)).rejects.toThrow('not registered for collection')

      await expect(post.addMediaFromUrl('%%%%').toMediaCollection('downloads')).rejects.toThrow('valid absolute URLs')

      const renamedRemoteImage = await post
        .addMediaFromUrl('https://example.test/override')
        .usingFileName('override.png')
        .toMediaCollection('downloads')

      expect(renamedRemoteImage.mimeType).toBe('image/jpeg')

      const headerless = await post
        .addMediaFromUrl('https://example.test/no-header')
        .usingFileName('headerless.bin')
        .toMediaCollection('downloads')

      expect(headerless.mimeType).toBe('image/jpeg')

      revision = 'v4'
      await media.regenerate()

      expect(await Storage.disk('public').get(resolvedThumbPath)).toBe('v4:thumb')
      expect(await Storage.disk('public').get(resolvedCardPath)).toBe('v4:card')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('restores overwritten conversion storage when regeneration transaction rolls back', async () => {
    let revision = 'v1'

    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`${revision}:${conversion.name}`),
          fileName: `${conversion.name}.txt`,
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Rollback Conversion' })
    const media = await post.addMedia({
      contents: Buffer.from('image'),
      fileName: 'image.jpg',
    }).toMediaCollection('images')
    const thumbPath = media.record.generated_conversions.thumb?.path
    expect(thumbPath).toBeTruthy()

    revision = 'v2'
    await expect(DB.transaction(async () => {
      const [transactionMedia] = await post.getMedia('images')
      await transactionMedia!.regenerate('thumb')
      expect(await Storage.disk('public').get(thumbPath!)).toBe('v2:thumb')

      throw new Error('rollback conversion regeneration')
    })).rejects.toThrow('rollback conversion regeneration')

    await media.getEntity().refresh()
    expect(media.record.generated_conversions.thumb?.path).toBe(thumbPath)
    expect(await Storage.disk('public').get(thumbPath!)).toBe('v1:thumb')
  })

  it('rejects oversized remote uploads before buffering the response body', async () => {
    await createRemoteMediaServer((_request, response) => {
      response.setHeader('content-length', '1537')
      response.setHeader('content-type', 'image/jpeg')
      response.writeHead(200)
      response.flushHeaders()
      response.end(Buffer.alloc(1537))
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .maxSize(1536),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote Limit' })

      const result = await post.addMediaFromUrl('https://example.test/oversized.jpg').toMediaCollection('images')
      expect(result.data).toBeNull()
      expect(result.error?.message).toBe('The selected file must be 1.5 KB or smaller.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects remote uploads that target local hosts or redirects', async () => {
    let requests = 0
    await createRemoteMediaServer((_request, response) => {
      requests += 1
      response.writeHead(302, { location: 'http://127.0.0.1/private.jpg' })
      response.end()
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote SSRF' })
      await expect(post.addMediaFromUrl('not a url').toMediaCollection('images')).rejects.toThrow('valid absolute URLs')
      await expect(post.addMediaFromUrl('ftp://example.test/private.jpg').toMediaCollection('images')).rejects.toThrow('use http or https')
      await expect(post.addMediaFromUrl('https://user:secret@example.test/private.jpg').toMediaCollection('images')).rejects.toThrow('must not include credentials')
      const blockedHosts = [
        'localhost',
        'app.localhost',
        '0.0.0.1',
        '10.0.0.1',
        '127.0.0.1',
        '169.254.1.1',
        '172.16.0.1',
        '192.168.0.1',
        '224.0.0.1',
        '[::1]',
        '[::]',
        '[fc00::1]',
        '[fd00::1]',
        '[fe80::1]',
        '[febf::1]',
        '[ff02::1]',
        '[::ffff:127.0.0.1]',
      ]
      for (const host of blockedHosts) {
        await expect(post.addMediaFromUrl(`http://${host}/private.jpg`).toMediaCollection('images'))
          .rejects.toThrow('local or private hosts')
      }
      await expect(post.addMediaFromUrl('https://example.test/redirect.jpg').toMediaCollection('images')).rejects.toThrow('do not follow redirects')
      expect(requests).toBe(1)

    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('pins remote media HTTP requests to the validated address', async () => {
    const server = createServer((_request, response) => {
      response.setHeader('content-type', 'text/plain')
      response.setHeader('set-cookie', ['one=1', 'two=2'])
      response.end('remote media')
    })
    await new Promise<void>(resolveListening => server.listen(0, '127.0.0.1', resolveListening))
    const address = server.address()
    if (!address || typeof address === 'string') {
      throw new Error('Expected an assigned HTTP test port.')
    }

    const url = new URL(`http://media.test:${address.port}/image.txt`)
    const response = await mediaAdderInternals.requestRemoteMedia(url, {
      address: '127.0.0.1',
      family: 4,
    })
    expect(await response.text()).toBe('remote media')
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(response.headers.getSetCookie()).toEqual(['one=1', 'two=2'])
    await new Promise<void>((resolveClosed, reject) => server.close(error => error ? reject(error) : resolveClosed()))
    await expect(mediaAdderInternals.requestRemoteMedia(url, {
      address: '127.0.0.1',
      family: 4,
    })).rejects.toThrow()


  })

  it('enforces the default remote upload byte limit when collection max size is not configured', async () => {
    await createRemoteMediaServer((_request, response) => {
      response.setHeader('content-type', 'image/jpeg')
      response.write(Buffer.alloc(10 * 1024 * 1024))
      response.end(Buffer.from([1]))
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote Default Limit' })
      const result = await post.addMediaFromUrl('https://example.test/default-limit.jpg').toMediaCollection('images')
      expect(result.data).toBeNull()
      expect(result.error?.message).toBe('The selected file must be 10 MB or smaller.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('rejects oversized remote uploads without content-length before buffering the response body', async () => {
    await createRemoteMediaServer((_request, response) => {
      response.setHeader('content-type', 'image/jpeg')
      response.write(Buffer.from([1, 2]))
      response.end(Buffer.from([3, 4]))
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .maxSize(2),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote Stream Limit' })

      const result = await post.addMediaFromUrl('https://example.test/oversized-stream.jpg').toMediaCollection('images')
      expect(result.data).toBeNull()
      expect(result.error?.message).toBe('The selected file must be 2 bytes or smaller.')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('persists bounded chunked HTTP uploads with their downloaded bytes', async () => {
    await createRemoteMediaServer((_request, response) => {
      response.setHeader('content-type', 'image/jpeg')
      response.write(Buffer.from([1]))
      response.end(Buffer.from([2]))
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images')
          .disk('public')
          .maxSize(4),
      ],
    })

    try {
      const post = await Post.create({ title: 'Remote Stream Success' })
      const media = await post.addMediaFromUrl('https://example.test/streamed.jpg').toMediaCollection('images')

      expect(media.size).toBe(2)
      expect(media.mimeType).toBeNull()
      expect(Array.from(await Storage.disk(media.record.disk).getBytes(media.record.path) ?? [])).toEqual([1, 2])
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('skips queued conversions during inline generation and regeneration before async workers process them', async () => {
    const queueHarness = await createNativeRedisQueue()
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: queueHarness.redisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued' })
    const media = await post.addMedia({
      contents: await createImageBuffer(),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')

    expect(media.getAvailableConversions()).toEqual(['card'])
    for (const name of ['card']) await assertNativeImageConversion(media.record.generated_conversions[name]?.path)
    expect(await queueHarness.jobs()).toHaveLength(1)

    await media.regenerate()
    expect(await queueHarness.jobs()).toHaveLength(2)
    expect(listRegisteredQueueJobs().map(job => job.name)).toContain(MEDIA_GENERATE_CONVERSIONS_JOB)
  })

  it('dispatches queued conversions and refreshes the media item when the sync queue runs immediately', async () => {
    ensureMediaQueueJobRegistered()

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Sync' })
    const media = await post.addMedia({
      contents: await createImageBuffer(),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
    for (const name of ['card', 'thumb']) await assertNativeImageConversion(media.record.generated_conversions[name]?.path)
    await assertNativeImageConversion(media.record.generated_conversions.thumb?.path)

    await media.regenerate()
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
    for (const name of ['card', 'thumb']) await assertNativeImageConversion(media.record.generated_conversions[name]?.path)
  })

  it('refreshes queued conversions after commit when the default sync queue runs inside a transaction', async () => {
    ensureMediaQueueJobRegistered()

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Sync Transaction' })
    const media = await DB.transaction(async () => {
      return await post.addMedia({
        contents: await createImageBuffer(),
        fileName: 'hero.jpg',
      }).toMediaCollection('images')
    })
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
    for (const name of ['card', 'thumb']) await assertNativeImageConversion(media.record.generated_conversions[name]?.path)
    await assertNativeImageConversion(media.record.generated_conversions.thumb?.path)
  })

  it('queues media conversion jobs for async workers and applies the queued conversion when the worker runs', async () => {
    const queueHarness = await createNativeRedisQueue()
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: queueHarness.redisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Async' })
    const media = await post.addMedia({
      contents: await createImageBuffer(),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')
    expect(media.getAvailableConversions()).toEqual(['card'])
    for (const name of ['card']) await assertNativeImageConversion(media.record.generated_conversions[name]?.path)
    expect(await queueHarness.jobs()).toHaveLength(1)
    expect((await queueHarness.jobs())[0]).toMatchObject({
      name: MEDIA_GENERATE_CONVERSIONS_JOB,
      connection: 'redis',
      queue: 'media',
      payload: {
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      },
    })

    const result = await runQueueWorker({
      connection: 'redis',
      once: true,
    })

    expect(result).toMatchObject({
      processed: 1,
      released: 0,
      failed: 0,
      stoppedBecause: 'once',
    })

    await media.getEntity().refresh()
    expect(media.getAvailableConversions()).toEqual(['card', 'thumb'])
    for (const name of ['card', 'thumb']) await assertNativeImageConversion(media.record.generated_conversions[name]?.path)
    await assertNativeImageConversion(media.record.generated_conversions.thumb?.path)
  })

  it('commits media attachments inside DB transactions before queued conversions are enqueued after commit', async () => {
    await createQueueTables()
    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'media',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued In Transaction' })
    const media = await DB.transaction(async () => {
      return await post.addMedia({
        contents: await createImageBuffer(),
        fileName: 'hero.jpg',
      }).toMediaCollection('images')
    })
    expect(media.getAvailableConversions()).toEqual(['card'])
    for (const name of ['card']) await assertNativeImageConversion(media.record.generated_conversions[name]?.path)
    expect(await DB.table('jobs').get()).toHaveLength(1)
  }, 500)

  it('rejects media transactions when post-commit queued conversion dispatch fails', async () => {
    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'media',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Failure' })

    await expect(DB.transaction(async () => {
      return await post.addMedia({
        contents: await createImageBuffer(),
        fileName: 'hero.jpg',
      }).toMediaCollection('images')
    })).rejects.toThrow('committed')

    expect(await DB.table('media').get()).toHaveLength(1)
  })

  it('does not enqueue queued conversions when the surrounding media transaction rolls back', async () => {
    await createQueueTables()
    configureQueueRuntime({
      config: {
        default: 'database',
        failed: false,
        connections: {
          database: {
            driver: 'database',
            connection: 'default',
            table: 'jobs',
            queue: 'media',
          },
        },
      },
      ...createQueueDbRuntimeOptions(),
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Queued Rollback' })
    let originalPath: string | undefined
    let conversionPath: string | undefined

    await expect(DB.transaction(async () => {
      const media = await post.addMedia({
        contents: await createImageBuffer(),
        fileName: 'hero.jpg',
      }).toMediaCollection('images')
      originalPath = media.record.path
      conversionPath = media.record.generated_conversions.card?.path

      throw new Error('rollback now')
    })).rejects.toThrow('rollback now')

    expect(await DB.table('media').get()).toHaveLength(0)
    expect(await DB.table('jobs').get()).toHaveLength(0)
    expect(originalPath).toBeTypeOf('string')
    expect(conversionPath).toBeTypeOf('string')
    expect(await Storage.disk('public').exists(originalPath!)).toBe(false)
    expect(await Storage.disk('public').exists(conversionPath!)).toBe(false)
  })

  it('reports queued conversion worker failures for unknown conversions and missing originals', async () => {
    const queueHarness = await createNativeRedisQueue()
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: queueHarness.redisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
      ],
    })

    const post = await Post.create({ title: 'Queued Failures' })
    const media = await post.addMedia({
      contents: await createImageBuffer(),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')
    await queueHarness.clear()
    const failures: Error[] = []

    await dispatchQueuedMediaConversions({
      mediaId: media.record.id,
      conversionNames: ['missing'],
    })

    const unknownResult = await runQueueWorker({
      connection: 'redis',
      once: true,
      onJobFailed(event) {
        failures.push(event.error)
      },
    })

    expect(unknownResult.failed).toBe(1)
    expect(failures[0]?.message).toContain('Unknown media conversion')

    await Storage.disk('public').delete(media.record.path)

    await dispatchQueuedMediaConversions({
      mediaId: media.record.id,
      conversionNames: ['thumb'],
    })

    const missingOriginalResult = await runQueueWorker({
      connection: 'redis',
      once: true,
      onJobFailed(event) {
        failures.push(event.error)
      },
    })

    expect(missingOriginalResult.failed).toBe(1)
    expect(failures[1]?.message).toContain('original file is missing')
  })

  it('treats missing media rows as a no-op queued conversion job', async () => {

    await expect(runMediaGenerateConversionsJob({
      mediaId: 999_999,
      conversionNames: ['thumb'],
    })).resolves.toEqual({
      status: 'missing-media',
      conversionNames: [],
    })
  })

  it('treats empty queued conversion names as a no-op for existing media rows', async () => {

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('card').width(2).height(2).performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Empty Conversion Names' })
    const media = await post.addMedia({
      contents: await createImageBuffer(),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')
    const generatedConversions = media.record.generated_conversions

    await expect(runMediaGenerateConversionsJob({
      mediaId: media.record.id,
      conversionNames: ['   ', ''],
    })).resolves.toEqual({
      status: 'processed',
      conversionNames: [],
    })

    const unchanged = await Media.findOrFail(media.record.id)
    expect(unchanged.get('generated_conversions')).toEqual(generatedConversions)
  })

  it('defers the exported queued conversion helper until the surrounding transaction commits', async () => {
    const queueHarness = await createNativeRedisQueue()
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: queueHarness.redisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
      ],
    })

    const post = await Post.create({ title: 'Queued Helper Commit' })
    const media = await post.addMedia({
      contents: await createImageBuffer(),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')

    expect(await queueHarness.jobs()).toHaveLength(1)
    await queueHarness.clear()

    await DB.transaction(async () => {
      await dispatchQueuedMediaConversions({
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      })

      expect(await queueHarness.jobs()).toHaveLength(0)
    })

    expect(await queueHarness.jobs()).toHaveLength(1)
    expect((await queueHarness.jobs())[0]).toMatchObject({
      name: MEDIA_GENERATE_CONVERSIONS_JOB,
      payload: {
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      },
    })
  })

  it('does not dispatch the exported queued conversion helper when the surrounding transaction rolls back', async () => {
    const queueHarness = await createNativeRedisQueue()
    configureQueueRuntime({
      config: {
        default: 'redis',
        connections: {
          redis: {
            driver: 'redis',
            queue: 'media',
          },
        },
      },
      redisConfig: queueHarness.redisConfig,
      driverFactories: [queueHarness.factory],
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').width(2).height(2).performOnCollections('images').queued(),
      ],
    })

    const post = await Post.create({ title: 'Queued Helper Rollback' })
    const media = await post.addMedia({
      contents: await createImageBuffer(),
      fileName: 'hero.jpg',
    }).toMediaCollection('images')

    expect(await queueHarness.jobs()).toHaveLength(1)
    await queueHarness.clear()

    await expect(DB.transaction(async () => {
      await dispatchQueuedMediaConversions({
        mediaId: media.record.id,
        conversionNames: ['thumb'],
      })

      expect(await queueHarness.jobs()).toHaveLength(0)
      throw new Error('rollback helper dispatch')
    })).rejects.toThrow('rollback helper dispatch')

    expect(await queueHarness.jobs()).toHaveLength(0)
  })

  it('covers media queue helper validation, normalization, and idempotent registration', async () => {
    ensureMediaQueueJobRegistered()
    ensureMediaQueueJobRegistered()
    expect(listRegisteredQueueJobs().filter(job => job.name === MEDIA_GENERATE_CONVERSIONS_JOB)).toHaveLength(1)

    await expect(dispatchQueuedMediaConversions({
      mediaId: 'media-1',
      conversionNames: ['   ', ''],
    })).resolves.toBeUndefined()

    await expect(runMediaGenerateConversionsJob({
      mediaId: 'media-1',
      conversionNames: ['thumb'],
    })).resolves.toEqual({
      status: 'missing-media',
      conversionNames: [],
    })

    await expect(runMediaGenerateConversionsJob({
      mediaId: Number.NaN,
      conversionNames: ['thumb'],
    })).rejects.toThrow('finite media identifier')

    await expect(runMediaGenerateConversionsJob({
      mediaId: '   ',
      conversionNames: ['thumb'],
    })).rejects.toThrow('non-empty media identifier')

    await expect(runMediaGenerateConversionsJob({
      mediaId: 999_998,
      conversionNames: [' thumb ', 'thumb', ' card '],
    })).resolves.toEqual({
      status: 'missing-media',
      conversionNames: [],
    })
  })

  it('regenerates legacy conversions that fall back to the media disk', async () => {
    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('legacy-thumb'),
          fileName: 'thumb.txt',
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images'),
      ],
    })

    const post = await Post.create({ title: 'Legacy' })
    await Storage.disk('public').put('media/legacy/original/legacy.jpg', Buffer.from('original'))
    await Storage.disk('public').put('media/legacy/conversions/thumb.txt', Buffer.from('outdated'))

    const legacy = await Media.create({
      uuid: 'legacy',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'images',
      name: 'legacy',
      file_name: 'legacy.jpg',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: 'image/jpeg',
      extension: 'jpg',
      size: 8,
      path: 'media/legacy/original/legacy.jpg',
      generated_conversions: {
        thumb: {
          path: 'media/legacy/conversions/thumb.txt',
        },
      } as never,
      order_column: 1,
    })

    await new MediaItem(legacy).regenerate('thumb')

    expect(
      await Storage.disk('public').get('media/legacy/conversions/thumb.txt'),
    ).toBe('legacy-thumb')
  })

  it('keeps existing conversions when regeneration fails', async () => {
    setMediaConversionExecutor({
      async generate({ conversion }) {
        return {
          contents: Buffer.from(`generated:${conversion.name}`),
          fileName: `${conversion.name}.webp`,
          mimeType: 'image/webp',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
      conversions: [
        conversion('thumb').performOnCollections('images').format('webp'),
      ],
    })

    const post = await Post.create({ title: 'Regenerate' })
    const media = await post.addMedia({
      contents: Buffer.from('original'),
      fileName: 'image.txt',
    }).toMediaCollection('images')

    const thumbPath = media.record.generated_conversions.thumb?.path
    expect(thumbPath).toBeTruthy()
    expect(await Storage.disk('public').exists(thumbPath!)).toBe(true)

    setMediaConversionExecutor({
      async generate() {
        throw new Error('conversion failed')
      },
    })

    await expect(media.regenerate('thumb')).rejects.toThrow('conversion failed')
    expect(await Storage.disk('public').exists(thumbPath!)).toBe(true)
    expect(media.getEntity().get('generated_conversions').thumb?.path).toBe(thumbPath)
  })

  it('fails remote uploads when the download is unsuccessful', async () => {
    await createRemoteMediaServer((_request, response) => {
      response.writeHead(404)
      response.end('missing')
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('images').disk('public'),
      ],
    })

    try {
      const post = await Post.create({ title: 'Broken Remote' })
      await expect(post.addMediaFromUrl('https://example.test/missing.jpg').toMediaCollection('images')).rejects.toThrow('Failed to download media')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('keeps only the latest items when configured', async () => {
    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('gallery').disk('public').onlyKeepLatest(2),
      ],
    })

    const post = await Post.create({ title: 'Gallery' })

    await post.addMedia({ contents: Buffer.from('1'), fileName: 'one.txt' }).toMediaCollection('gallery')
    await post.addMedia({ contents: Buffer.from('2'), fileName: 'two.txt' }).toMediaCollection('gallery')
    await post.addMedia({ contents: Buffer.from('3'), fileName: 'three.txt' }).toMediaCollection('gallery')

    const items = await post.getMedia('gallery')
    expect(items).toHaveLength(2)
    expect(items.map(item => item.fileName)).toEqual(['two.txt', 'three.txt'])
  })

  it('regenerates detached media rows using fallback collection definitions', async () => {
    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('global'),
          fileName: 'global.txt',
          mimeType: 'text/plain',
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      conversions: [
        conversion('global'),
      ],
    })

    const post = await Post.create({ title: 'Detached' })
    await Storage.disk('public').put('ghost/original.txt', Buffer.from('original'))
    await Storage.disk('public').put('ghost/old.txt', Buffer.from('old'))

    const ghost = await Media.create({
      uuid: 'ghost',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'ghost',
      name: 'ghost',
      file_name: 'ghost.txt',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: 'text/plain',
      extension: 'txt',
      size: 8,
      path: 'ghost/original.txt',
      generated_conversions: {
        old: {
          path: 'ghost/old.txt',
        },
        skipped: {} as never,
      } as never,
      order_column: 500,
    })

    const item = new MediaItem(ghost)
    await item.regenerate()

    expect(item.getAvailableConversions()).toEqual(['global'])
    expect(await Storage.disk('public').exists('media/ghost/conversions/global.txt')).toBe(true)
  })

  it('covers default disk, null metadata, and item fallback branches', async () => {
    setMediaConversionExecutor({
      async generate() {
        return {
          contents: Buffer.from('variant'),
        }
      },
    })

    const BasePost = defineModel(postsTable, {
      fillable: ['title'],
    })

    const Post = defineMediaModel(BasePost, {
      collections: [
        collection('misc'),
      ],
      conversions: [
        conversion('copy').performOnCollections('misc'),
      ],
    })

    const post = await Post.create({ title: 'Misc' })
    const media = await post
      .addMedia(Buffer.from('original'))
      .usingFileName('raw')
      .toMediaCollection('misc')
    const blankName = await post
      .addMedia({
        contents: Buffer.from('blank'),
        fileName: '   ',
      })
      .toMediaCollection('misc')
    const implicitContentsName = await post
      .addMedia({
        contents: Buffer.from('implicit'),
      })
      .toMediaCollection('misc')
    const defaultName = await post
      .addMedia(Buffer.from('default'))
      .toMediaCollection('misc')

    expect(media.record.disk).toBe('public')
    expect(media.record.conversions_disk).toBe('public')
    expect(media.record.mime_type).toBeNull()
    expect(media.record.extension).toBeNull()
    expect(media.getPath('copy')).toContain('/public/')
    expect(blankName.fileName).toBe('media.bin')
    expect(implicitContentsName.fileName).toBe('media.bin')
    expect(defaultName.fileName).toBe('media.bin')

    await DB.table('media').insert({
      uuid: 'manual-3',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'misc',
      name: 'manual-3',
      file_name: 'manual-3.txt',
      disk: 'public',
      conversions_disk: null,
      mime_type: null,
      extension: null,
      size: 1,
      path: 'manual-3/original.txt',
      generated_conversions: 'null',
      order_column: 101,
    })
    const noConversions = await Media.where('uuid', 'manual-3').firstOrFail()
    expect(noConversions.get('generated_conversions')).toBeNull()

    await Storage.disk('public').put('manual-3/original.txt', Buffer.from('manual-3'))
    expect(new MediaItem(noConversions).getAvailableConversions()).toEqual([])
    await expect(new MediaItem(noConversions).regenerate('copy')).resolves.toBeInstanceOf(MediaItem)
    await new MediaItem(noConversions).delete()

    await DB.table('media').insert({
      uuid: 'manual-3-delete',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'misc',
      name: 'manual-3-delete',
      file_name: 'manual-3-delete.txt',
      disk: 'public',
      conversions_disk: null,
      mime_type: null,
      extension: null,
      size: 1,
      path: 'manual-3-delete/original.txt',
      generated_conversions: 'null',
      order_column: 101,
    })
    const nullDelete = await Media.where('uuid', 'manual-3-delete').firstOrFail()
    expect(nullDelete.get('generated_conversions')).toBeNull()

    await new MediaItem(nullDelete).delete()

    const diskFallback = await Media.create({
      uuid: 'manual-4',
      model_type: post.getRepository().definition.morphClass,
      model_id: String(post.get('id')),
      collection_name: 'misc',
      name: 'manual-4',
      file_name: 'manual-4.txt',
      disk: 'public',
      conversions_disk: null as never,
      mime_type: 'text/plain',
      extension: 'txt',
      size: 1,
      path: 'manual-4/original.txt',
      generated_conversions: {
        plain: {
          path: 'manual-4/plain.txt',
        },
      } as never,
      order_column: 102,
    })

    expect(new MediaItem(diskFallback).getPath('plain' as never)).toContain('/public/')

    await expect(media.regenerate('unknown' as never)).rejects.toThrow('Unknown media conversion')
    await expect(new MediaItem(diskFallback).regenerate('copy')).rejects.toThrow('original file is missing')
  })

})
