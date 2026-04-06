import { installEntityMediaMethods } from './model/entity'
import { ensureMediaQueueJobRegistered } from './queue'

installEntityMediaMethods()
ensureMediaQueueJobRegistered()

export { defineMediaModel } from './defineMediaModel'
export {
  collection,
  normalizeCollectionDefinitions,
  type MediaCollectionBuilder,
  type MediaCollectionDefinition,
  type NormalizedMediaCollectionDefinition,
} from './definitions/collections'
export {
  conversion,
  normalizeConversionDefinitions,
  type MediaConversionBuilder,
  type MediaConversionDefinition,
  type MediaConversionFit,
  type MediaConversionFormat,
  type NormalizedMediaConversionDefinition,
} from './definitions/conversions'
export {
  normalizeMediaDefinition,
  resolveMediaDefinition,
  type CollectionNamesOf,
  type ConversionNamesOf,
  type MediaDefinitionFactory,
  type MediaDefinitionHelpers,
  type MediaDefinitionInput,
  type NormalizedMediaDefinition,
} from './definitions/config'
export { Media } from './model/Media'
export { MediaAdder, type MediaSourceInput } from './model/adder'
export { MediaItem } from './model/item'
export {
  dispatchQueuedMediaConversions,
  ensureMediaQueueJobRegistered,
  MEDIA_GENERATE_CONVERSIONS_JOB,
  runMediaGenerateConversionsJob,
  type MediaGenerateConversionsPayload,
  type MediaGenerateConversionsResult,
} from './queue'
export {
  createDefaultMediaConversionExecutor,
  defaultMediaConversionExecutor,
} from './runtime/image'
export {
  getMediaConversionExecutor,
  getMediaDefinition,
  getMediaDefinitionForMorphClass,
  getMediaPathGenerator,
  registerMediaDefinition,
  requireMediaDefinition,
  requireMediaDefinitionForMorphClass,
  resetMediaPathGenerator,
  resetMediaRuntime,
  resolveMediaCollection,
  resolveMediaConversion,
  setMediaConversionExecutor,
  setMediaPathGenerator,
  type MediaConversionExecutor,
  type MediaConversionExecutorInput,
  type MediaConversionExecutorResult,
  type MediaConversionExecutorSource,
  type MediaConversionPathInput,
  type MediaOriginalPathInput,
  type MediaPathGenerator,
  type StoredMediaConversion,
} from './registry'
export type {
  MediaEnabledEntity,
  MediaEnabledModel,
} from './defineMediaModel'
