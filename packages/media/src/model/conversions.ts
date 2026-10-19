import { randomBytes } from 'node:crypto'
import { mimeTypeFromFileName } from '@holo-js/kernel/file-content'
import { Storage } from '@holo-js/storage/runtime'
import type { Entity, TableDefinition } from '@holo-js/db'
import {
  getMediaConversionExecutor,
  getMediaPathGenerator,
  requireMediaDefinition,
  requireMediaDefinitionForMorphClass,
  type MediaConversionExecutorSource,
  type StoredMediaConversion,
} from '../registry'
import {
  getContentSize,
  sanitizeFileName,
  toBinaryContent,
} from '../runtime/binary'
import { Media, type GeneratedMediaConversions } from './Media'
import { type MediaMutation, runMediaMutation, removeStoredFiles } from './mutation'
import { dispatchQueuedMediaConversionsForModel } from '../queue'
import type {
  NormalizedMediaCollectionDefinition,
} from '../definitions/collections'
import type { NormalizedMediaDefinition } from '../definitions/config'

type MediaEntity = Entity<typeof Media.definition.table, typeof Media.definition.relations>
type MediaOwnerEntity = Entity<TableDefinition>
function fallbackCollectionDefinition(
  collectionName: string,
): NormalizedMediaCollectionDefinition {
  return Object.freeze({
    kind: 'collection',
    name: collectionName,
    singleFile: collectionName === 'default',
    acceptedMimeTypes: Object.freeze([]),
    acceptedExtensions: Object.freeze([]),
  })
}

function normalizeRequestedConversions(
  requested?: string | readonly string[],
): readonly string[] | undefined {
  if (typeof requested === 'string') {
    return Object.freeze([requested])
  }

  if (!requested || requested.length === 0) {
    return undefined
  }

  return Object.freeze([...new Set(requested.filter(Boolean))])
}

function resolveCollectionDefinition(
  definition: NormalizedMediaDefinition,
  collectionName: string,
): NormalizedMediaCollectionDefinition {
  return definition.collectionsByName[collectionName] ?? fallbackCollectionDefinition(collectionName)
}

function resolveMatchingConversions(
  definition: NormalizedMediaDefinition,
  collectionName: string,
  requested?: readonly string[],
  options: {
    readonly includeQueued?: boolean
  } = {},
) {
  if (requested?.length) {
    const unknown = requested.filter((name) => {
      return !definition.conversionsByName[name]
    })

    if (unknown.length > 0) {
      throw new Error(`[Holo Media] Unknown media conversion "${unknown[0]}".`)
    }
  }

  const matching = definition.conversions.filter((conversion) => {
    const appliesToCollection = conversion.collections.length === 0
      || conversion.collections.includes(collectionName)

    if (!appliesToCollection) {
      return false
    }

    if (!requested?.length) {
      return true
    }

    return requested.includes(conversion.name)
  })

  if (requested?.length) {
    const missing = requested.filter((name) => {
      return !matching.some(conversion => conversion.name === name)
    })

    if (missing.length > 0) {
      throw new Error(
        `[Holo Media] Conversion "${missing[0]}" is not registered for collection "${collectionName}".`,
      )
    }
  }

  if (options.includeQueued) {
    return matching
  }

  return matching.filter(conversion => !conversion.queued)
}

export function resolveQueuedConversionNames(options: {
  readonly definition: NormalizedMediaDefinition
  readonly collectionName: string
  readonly requestedConversions?: string | readonly string[]
}): readonly string[] {
  const requested = normalizeRequestedConversions(options.requestedConversions)
  return Object.freeze(
    resolveMatchingConversions(
      options.definition,
      options.collectionName,
      requested,
      { includeQueued: true },
    )
      .filter(conversion => conversion.queued)
      .map(conversion => conversion.name),
  )
}

function withUniqueSuffix(path: string): string {
  const token = randomBytes(8).toString('hex')
  const slash = path.lastIndexOf('/')
  const dot = path.lastIndexOf('.')
  return dot > slash + 1
    ? `${path.slice(0, dot)}.${token}${path.slice(dot)}`
    : `${path}.${token}`
}

export async function writeStoredConversions(options: {
  readonly definition: NormalizedMediaDefinition
  readonly collection: NormalizedMediaCollectionDefinition
  readonly source: MediaConversionExecutorSource
  readonly conversionsDisk: string
  readonly requestedConversions?: string | readonly string[]
  readonly includeQueued?: boolean
  readonly unique?: boolean
  readonly mutation: MediaMutation
}): Promise<GeneratedMediaConversions> {
  const requested = normalizeRequestedConversions(options.requestedConversions)
  const matchingConversions = resolveMatchingConversions(
    options.definition,
    options.collection.name,
    requested,
    { includeQueued: options.includeQueued === true },
  )

  const generatedConversions = Object.create(null) as Record<string, StoredMediaConversion>
  const executor = getMediaConversionExecutor()

  for (const conversion of matchingConversions) {
    const generated = await executor.generate({
      source: options.source,
      collection: options.collection,
      conversion,
    })

    if (!generated) {
      continue
    }

    const generatedFileName = sanitizeFileName(generated.fileName ?? options.source.fileName)
    const plannedPath = getMediaPathGenerator().conversionPath({
      uuid: options.source.uuid,
      fileName: options.source.fileName,
      extension: options.source.extension,
      collection: options.collection,
      conversion,
      generatedFileName,
    })
    const path = options.unique ? withUniqueSuffix(plannedPath) : plannedPath
    const disk = generated.disk ?? options.conversionsDisk
    const contents = await toBinaryContent(generated.contents)
    await options.mutation.put(disk, path, contents)
    generatedConversions[conversion.name] = Object.freeze({
      path,
      disk,
      fileName: generatedFileName,
      mimeType: generated.mimeType?.trim() || mimeTypeFromFileName(generatedFileName) || undefined,
      size: getContentSize(contents),
    })
  }

  return Object.freeze(generatedConversions)
}

function obsoleteConversionFiles(
  current: GeneratedMediaConversions,
  next: GeneratedMediaConversions,
  fallbackDisk: string,
): { readonly disk: string, readonly path: string }[] {
  return Object.entries(current)
    .filter(([name, conversion]) => conversion?.path && next[name]?.path !== conversion.path)
    .map(([, conversion]) => ({ disk: conversion.disk ?? fallbackDisk, path: conversion.path }))
}

export async function regenerateMediaEntityConversions(options: {
  readonly media: MediaEntity
  readonly owner?: MediaOwnerEntity
  readonly conversions?: string | readonly string[]
  readonly includeQueued?: boolean
}): Promise<GeneratedMediaConversions> {
  const media = options.media
  const modelType = String(media.get('model_type'))
  const definition = options.owner
    ? requireMediaDefinition(options.owner)
    : requireMediaDefinitionForMorphClass(modelType)
  const collectionName = String(media.get('collection_name'))
  const collection = resolveCollectionDefinition(definition, collectionName)
  const requested = normalizeRequestedConversions(options.conversions)
  const conversionsDisk = String(media.get('conversions_disk') ?? media.get('disk'))
  resolveMatchingConversions(definition, collectionName, requested, {
    includeQueued: options.includeQueued === true,
  })

  const sourceContents = await Storage.disk(String(media.get('disk'))).getBytes(String(media.get('path')))
  if (!sourceContents) {
    throw new Error(
      `[Holo Media] Cannot regenerate conversions for media "${media.get('uuid')}" because the original file is missing.`,
    )
  }

  const mediaId = media.get('id')
  const result = await runMediaMutation({
    committedMessage: '[Holo Media] Regeneration remains committed; post-commit cleanup or conversion dispatch failed.',
    afterRollback: async () => {
      options.owner?.forgetRelation('media')
      await media.refresh()
    },
    write: async mutation => await writeStoredConversions({
      definition,
      collection,
      conversionsDisk,
      requestedConversions: requested,
      includeQueued: options.includeQueued === true,
      unique: true,
      mutation,
      source: {
        uuid: String(media.get('uuid')),
        fileName: String(media.get('file_name')),
        extension: media.get('extension') ?? undefined,
        mimeType: media.get('mime_type') ?? undefined,
        size: sourceContents.byteLength,
        contents: sourceContents,
      },
    }),
    operation: async (_mutation, regenerated) => {
      const locked = await Media.query().where('id', mediaId).lockForUpdate().first()
      if (!locked) {
        throw new Error(`[Holo Media] Cannot regenerate conversions for media "${media.get('uuid')}" because the media row no longer exists.`)
      }

      const current = (locked.get('generated_conversions') ?? {}) as GeneratedMediaConversions
      const nextBase = requested?.length
        ? Object.fromEntries(
            Object.entries(current).filter(([name]) => !requested.includes(name)),
          )
        : {}
      const generatedConversions = Object.freeze({ ...nextBase, ...regenerated })
      media.forceFill({ generated_conversions: generatedConversions })
      await media.save()
      options.owner?.forgetRelation('media')
      return {
        generatedConversions,
        obsolete: obsoleteConversionFiles(current, generatedConversions, conversionsDisk),
      }
    },
    afterCommit: [
      async ({ obsolete }) => { await removeStoredFiles(obsolete) },
      async () => {
        if (options.includeQueued) return
        await dispatchQueuedMediaConversionsForModel({
          mediaId,
          conversionNames: resolveQueuedConversionNames({ definition, collectionName, requestedConversions: requested }),
        }, async () => { await media.refresh() })
      },
    ],
    afterEffects: () => { options.owner?.forgetRelation('media') },
  })
  return result.generatedConversions
}
