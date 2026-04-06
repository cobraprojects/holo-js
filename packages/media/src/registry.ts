import { Entity } from '@holo-js/db'
import { defaultMediaConversionExecutor } from './runtime/image'
import type { StorageContent } from '@holo-js/storage/runtime'
import type {
  MediaDefinitionInput,
  NormalizedMediaDefinition,
} from './definitions/config'
import type { NormalizedMediaCollectionDefinition } from './definitions/collections'
import type {
  MediaConversionFormat,
  NormalizedMediaConversionDefinition,
} from './definitions/conversions'
import type {
  TableDefinition,
} from '@holo-js/db'

type MediaModelDefinitionRef = {
  readonly name: string
  readonly morphClass?: string
}

type MediaModelReferenceLike = {
  readonly definition: MediaModelDefinitionRef
}

export interface StoredMediaConversion {
  readonly path: string
  readonly disk?: string
  readonly fileName?: string
  readonly mimeType?: string
  readonly size?: number
}

export interface MediaConversionExecutorSource {
  readonly uuid: string
  readonly fileName: string
  readonly extension?: string
  readonly mimeType?: string
  readonly size: number
  readonly contents: Exclude<StorageContent, string>
}

export interface MediaConversionExecutorResult {
  readonly contents: Exclude<StorageContent, string>
  readonly fileName?: string
  readonly mimeType?: string
  readonly disk?: string
}

export interface MediaConversionExecutorInput<
  TCollectionName extends string = string,
  TConversionName extends string = string,
> {
  readonly source: MediaConversionExecutorSource
  readonly collection: NormalizedMediaCollectionDefinition<TCollectionName>
  readonly conversion: NormalizedMediaConversionDefinition<TConversionName, TCollectionName>
}

export interface MediaConversionExecutor {
  generate<
    TCollectionName extends string = string,
    TConversionName extends string = string,
  >(
    input: MediaConversionExecutorInput<TCollectionName, TConversionName>,
  ): Promise<MediaConversionExecutorResult | null>
}

export interface MediaOriginalPathInput<
  TCollectionName extends string = string,
> {
  readonly uuid: string
  readonly fileName: string
  readonly extension?: string
  readonly collection: NormalizedMediaCollectionDefinition<TCollectionName>
}

export interface MediaConversionPathInput<
  TCollectionName extends string = string,
  TConversionName extends string = string,
> {
  readonly uuid: string
  readonly fileName: string
  readonly extension?: string
  readonly collection: NormalizedMediaCollectionDefinition<TCollectionName>
  readonly conversion: NormalizedMediaConversionDefinition<TConversionName, TCollectionName>
  readonly generatedFileName?: string
}

export interface MediaPathGenerator {
  originalPath<TCollectionName extends string = string>(
    input: MediaOriginalPathInput<TCollectionName>,
  ): string
  conversionPath<
    TCollectionName extends string = string,
    TConversionName extends string = string,
  >(
    input: MediaConversionPathInput<TCollectionName, TConversionName>,
  ): string
}

const mediaDefinitionRegistry = new WeakMap<object, NormalizedMediaDefinition>()
const mediaDefinitionMorphClassRegistry = new Map<string, NormalizedMediaDefinition>()

function sanitizePathSegment(value: string): string {
  return value
    .trim()
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .join('-')
}

function resolveConversionExtension(
  fileName: string,
  conversionFormat?: MediaConversionFormat,
): string {
  if (conversionFormat) {
    return conversionFormat === 'jpg' ? 'jpg' : conversionFormat
  }

  const extension = fileName.split('.').pop()?.trim().toLowerCase()
  return extension || 'bin'
}

const defaultMediaPathGenerator = Object.freeze({
  originalPath({
    uuid,
    fileName,
  }: MediaOriginalPathInput) {
    return `media/${sanitizePathSegment(uuid)}/original/${sanitizePathSegment(fileName)}`
  },
  conversionPath({
    uuid,
    conversion,
    generatedFileName,
    fileName,
  }: MediaConversionPathInput) {
    const extension = resolveConversionExtension(generatedFileName ?? fileName, conversion.format)
    const safeName = sanitizePathSegment(conversion.name)
    return `media/${sanitizePathSegment(uuid)}/conversions/${safeName}.${extension}`
  },
}) satisfies MediaPathGenerator

let mediaPathGenerator: MediaPathGenerator = defaultMediaPathGenerator
let mediaConversionExecutor: MediaConversionExecutor | undefined

function resolveDefinition(
  target: MediaModelReferenceLike | Entity<TableDefinition>,
): MediaModelDefinitionRef & object {
  if (target instanceof Entity) {
    return target.getRepository().definition as MediaModelDefinitionRef & object
  }

  return target.definition as MediaModelDefinitionRef & object
}

export function registerMediaDefinition(
  target: MediaModelReferenceLike,
  definition: NormalizedMediaDefinition,
): NormalizedMediaDefinition {
  const resolvedTarget = resolveDefinition(target)
  mediaDefinitionRegistry.set(resolvedTarget, definition)
  mediaDefinitionMorphClassRegistry.set(resolvedTarget.morphClass ?? resolvedTarget.name, definition)
  return definition
}

export function getMediaDefinition(
  target: MediaModelReferenceLike | Entity<TableDefinition>,
): NormalizedMediaDefinition | undefined {
  return mediaDefinitionRegistry.get(resolveDefinition(target))
}

export function requireMediaDefinition(
  target: MediaModelReferenceLike | Entity<TableDefinition>,
): NormalizedMediaDefinition {
  const definition = getMediaDefinition(target)
  if (!definition) {
    const model = resolveDefinition(target)
    throw new Error(
      `[Holo Media] Model "${model.name}" is not configured for media. Wrap it with defineMediaModel().`,
    )
  }

  return definition
}

export function getMediaDefinitionForMorphClass(
  morphClass: string,
): NormalizedMediaDefinition | undefined {
  return mediaDefinitionMorphClassRegistry.get(morphClass)
}

export function requireMediaDefinitionForMorphClass(
  morphClass: string,
): NormalizedMediaDefinition {
  const definition = getMediaDefinitionForMorphClass(morphClass)
  if (!definition) {
    throw new Error(
      `[Holo Media] Model "${morphClass}" is not configured for media. Wrap it with defineMediaModel().`,
    )
  }

  return definition
}

export function resolveMediaCollection(
  target: MediaModelReferenceLike | Entity<TableDefinition>,
  collectionName = 'default',
): NormalizedMediaCollectionDefinition {
  const definition = getMediaDefinition(target)
  if (!definition) {
    return Object.freeze({
      kind: 'collection',
      name: collectionName,
      singleFile: false,
      acceptedMimeTypes: Object.freeze([]),
      acceptedExtensions: Object.freeze([]),
    })
  }

  return definition.collectionsByName[collectionName] ?? Object.freeze({
    kind: 'collection',
    name: collectionName,
    singleFile: false,
    acceptedMimeTypes: Object.freeze([]),
    acceptedExtensions: Object.freeze([]),
  })
}

export function resolveMediaConversion(
  target: MediaModelReferenceLike | Entity<TableDefinition>,
  conversionName: string,
): NormalizedMediaConversionDefinition | undefined {
  return getMediaDefinition(target)?.conversionsByName[conversionName]
}

export function setMediaPathGenerator(generator: MediaPathGenerator): void {
  mediaPathGenerator = generator
}

export function resetMediaPathGenerator(): void {
  mediaPathGenerator = defaultMediaPathGenerator
}

export function getMediaPathGenerator(): MediaPathGenerator {
  return mediaPathGenerator
}

export function setMediaConversionExecutor(
  executor?: MediaConversionExecutor,
): void {
  mediaConversionExecutor = executor
}

export function getMediaConversionExecutor(): MediaConversionExecutor {
  return mediaConversionExecutor ?? defaultMediaConversionExecutor
}

export function resetMediaRuntime(): void {
  mediaPathGenerator = defaultMediaPathGenerator
  mediaConversionExecutor = undefined
}

export type { MediaDefinitionInput }
