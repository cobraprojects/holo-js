import { Storage } from '@holo-js/storage/runtime'
import {
  getMediaConversionExecutor,
  getMediaPathGenerator,
  requireMediaDefinition,
  requireMediaDefinitionForMorphClass,
  type MediaConversionExecutorSource,
  type StoredMediaConversion,
} from '../registry'
import {
  inferMimeType,
  getContentSize,
  sanitizeFileName,
  toBinaryContent,
} from '../runtime/binary'
import type { GeneratedMediaConversions, Media } from './Media'
import type {
  NormalizedMediaCollectionDefinition,
} from '../definitions/collections'
import type { NormalizedMediaDefinition } from '../definitions/config'
import type {
  Entity,
  TableDefinition,
} from '@holo-js/db'

type MediaEntity = Entity<typeof Media.definition.table>
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

export async function generateStoredConversions(options: {
  readonly definition: NormalizedMediaDefinition
  readonly collection: NormalizedMediaCollectionDefinition
  readonly source: MediaConversionExecutorSource
  readonly conversionsDisk: string
  readonly requestedConversions?: string | readonly string[]
  readonly includeQueued?: boolean
}): Promise<GeneratedMediaConversions> {
  const requested = normalizeRequestedConversions(options.requestedConversions)
  const matchingConversions = resolveMatchingConversions(
    options.definition,
    options.collection.name,
    requested,
    { includeQueued: options.includeQueued === true },
  )

  if (matchingConversions.length === 0) {
    return Object.freeze({})
  }

  const generatedConversions = Object.create(null) as Record<string, StoredMediaConversion>
  const executor = getMediaConversionExecutor()

  try {
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
      const conversionPath = getMediaPathGenerator().conversionPath({
        uuid: options.source.uuid,
        fileName: options.source.fileName,
        extension: options.source.extension,
        collection: options.collection,
        conversion,
        generatedFileName,
      })
      const targetDisk = generated.disk ?? options.conversionsDisk
      const conversionMimeType = inferMimeType(generatedFileName, generated.mimeType)
      const conversionContents = await toBinaryContent(generated.contents)

      await Storage.disk(targetDisk).put(conversionPath, conversionContents)
      generatedConversions[conversion.name] = Object.freeze({
        path: conversionPath,
        disk: targetDisk,
        fileName: generatedFileName,
        mimeType: conversionMimeType,
        size: getContentSize(conversionContents),
      })
    }
  } catch (error) {
    await deleteStoredConversions(
      generatedConversions as GeneratedMediaConversions,
      options.conversionsDisk,
    )
    throw error
  }

  return Object.freeze(generatedConversions)
}

async function deleteStoredConversions(
  conversions: GeneratedMediaConversions,
  _fallbackDisk: string,
): Promise<void> {
  for (const conversion of Object.values(conversions)) {
    await Storage.disk(conversion.disk).delete(conversion.path)
  }
}

async function deleteObsoleteConversions(
  current: GeneratedMediaConversions,
  next: GeneratedMediaConversions,
  fallbackDisk: string,
  requested?: readonly string[],
): Promise<void> {
  for (const [name, conversion] of Object.entries(current)) {
    if (requested?.length && !requested.includes(name)) {
      continue
    }

    if (!conversion?.path) {
      continue
    }

    const nextConversion = next[name]
    if (
      nextConversion?.path === conversion.path
      && nextConversion.disk === (conversion.disk ?? fallbackDisk)
    ) {
      continue
    }

    await Storage.disk(conversion.disk ?? fallbackDisk).delete(conversion.path)
  }
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
  const current = (media.get('generated_conversions') ?? {}) as GeneratedMediaConversions
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

  const nextBase = requested?.length
    ? Object.fromEntries(
        Object.entries(current).filter(([name]) => !requested.includes(name)),
      )
    : {}

  const regenerated = await generateStoredConversions({
    definition,
    collection,
    conversionsDisk,
    requestedConversions: requested,
    includeQueued: options.includeQueued === true,
    source: {
      uuid: String(media.get('uuid')),
      fileName: String(media.get('file_name')),
      extension: media.get('extension') ?? undefined,
      mimeType: media.get('mime_type') ?? undefined,
      size: sourceContents.byteLength,
      contents: sourceContents,
    },
  })

  const generatedConversions = Object.freeze({
    ...nextBase,
    ...regenerated,
  }) as GeneratedMediaConversions

  media.forceFill({
    generated_conversions: generatedConversions,
  } as never)
  await media.save()
  await deleteObsoleteConversions(current, generatedConversions, conversionsDisk, requested)
  options.owner?.forgetRelation('media')

  return generatedConversions
}
