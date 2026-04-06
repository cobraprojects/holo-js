import {
  collection,
  normalizeCollectionDefinitions,
  type MediaCollectionBuilder,
  type NormalizedMediaCollectionDefinition,
} from './collections'
import {
  conversion,
  normalizeConversionDefinitions,
  type MediaConversionBuilder,
  type NormalizedMediaConversionDefinition,
} from './conversions'

export interface MediaDefinitionHelpers {
  readonly collection: typeof collection
  readonly conversion: typeof conversion
}

export interface MediaDefinitionInput {
  readonly collections?: readonly MediaCollectionBuilder[]
  readonly conversions?: readonly MediaConversionBuilder[]
}

export interface NormalizedMediaDefinition<
  TCollectionName extends string = string,
  TConversionName extends string = string,
> {
  readonly collections: readonly NormalizedMediaCollectionDefinition<TCollectionName>[]
  readonly conversions: readonly NormalizedMediaConversionDefinition<TConversionName, TCollectionName>[]
  readonly collectionsByName: Readonly<Record<string, NormalizedMediaCollectionDefinition<TCollectionName>>>
  readonly conversionsByName: Readonly<Record<string, NormalizedMediaConversionDefinition<TConversionName, TCollectionName>>>
}

export type MediaDefinitionFactory<TDefinition extends MediaDefinitionInput = MediaDefinitionInput>
  = (helpers: MediaDefinitionHelpers) => TDefinition

export type CollectionNamesOf<TDefinition extends MediaDefinitionInput>
  = TDefinition['collections'] extends readonly (infer TCollection)[]
    ? TCollection extends { readonly name: infer TName extends string } ? TName : never
    : never

export type ConversionNamesOf<TDefinition extends MediaDefinitionInput>
  = TDefinition['conversions'] extends readonly (infer TConversion)[]
    ? TConversion extends { readonly name: infer TName extends string } ? TName : never
    : never

export function resolveMediaDefinition<
  TDefinition extends MediaDefinitionInput,
>(
  input: TDefinition | MediaDefinitionFactory<TDefinition>,
): TDefinition {
  if (typeof input === 'function') {
    return input({ collection, conversion })
  }

  return input
}

export function normalizeMediaDefinition<
  TCollectionName extends string = string,
  TConversionName extends string = string,
>(
  input: MediaDefinitionInput,
): NormalizedMediaDefinition<TCollectionName, TConversionName> {
  const collections = normalizeCollectionDefinitions(
    (input.collections ?? []).map(item => item.definition),
  ) as readonly NormalizedMediaCollectionDefinition<TCollectionName>[]
  const conversions = normalizeConversionDefinitions(
    (input.conversions ?? []).map(item => item.definition),
  ) as readonly NormalizedMediaConversionDefinition<TConversionName, TCollectionName>[]

  const collectionsByName = Object.create(null) as Record<string, NormalizedMediaCollectionDefinition<TCollectionName>>
  for (const definition of collections) {
    if (collectionsByName[definition.name]) {
      throw new Error(`[Holo Media] Duplicate media collection "${definition.name}".`)
    }

    collectionsByName[definition.name] = definition
  }

  const conversionsByName = Object.create(null) as Record<string, NormalizedMediaConversionDefinition<TConversionName, TCollectionName>>
  for (const definition of conversions) {
    if (conversionsByName[definition.name]) {
      throw new Error(`[Holo Media] Duplicate media conversion "${definition.name}".`)
    }

    for (const collectionName of definition.collections) {
      if (!collectionsByName[collectionName]) {
        throw new Error(
          `[Holo Media] Conversion "${definition.name}" references unknown collection "${collectionName}".`,
        )
      }
    }

    conversionsByName[definition.name] = definition
  }

  return Object.freeze({
    collections,
    conversions,
    collectionsByName: Object.freeze(collectionsByName),
    conversionsByName: Object.freeze(conversionsByName),
  })
}
