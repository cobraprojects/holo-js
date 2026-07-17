import type { DEFAULT_HOLO_PROJECT_PATHS } from '@holo-js/kernel'
import type {
  HoloAppEnv,
} from './types'
import type { HoloConfigRegistry } from './index'

export type HoloConfigMap = object

type HoloConfigMetadataKey = 'all' | 'custom' | 'environment' | 'loadedFiles' | 'warnings'
type HoloCustomConfig<TCustom extends HoloConfigMap> = Omit<
  TCustom,
  HoloConfigMetadataKey
>

export type HoloConfigValues<TCustom extends HoloConfigMap = HoloConfigMap> = Readonly<
  HoloConfigRegistry & HoloCustomConfig<TCustom>
>

export interface LoadedEnvironment {
  readonly name: HoloAppEnv
  readonly values: Readonly<Record<string, string>>
  readonly loadedFiles: readonly string[]
  readonly warnings: readonly string[]
}

export type LoadedHoloConfig<TCustom extends HoloConfigMap = HoloConfigMap> = Omit<
  HoloConfigValues<TCustom>,
  HoloConfigMetadataKey
> & {
  readonly custom: Readonly<TCustom>
  readonly all: HoloConfigValues<TCustom>
  readonly environment: LoadedEnvironment
  readonly loadedFiles: readonly string[]
  readonly warnings: readonly string[]
}

export type ConfigFileName = keyof HoloConfigRegistry | (string & {})

type Primitive = string | number | boolean | bigint | symbol | null | undefined
type NonTraversable = Primitive | readonly unknown[] | ((...args: never[]) => unknown)
type KnownPathKey<T> = Extract<{
  [K in keyof T & string]:
    K extends `${number}`
      ? never
      : [T[K]] extends [undefined]
        ? never
        : K
}[keyof T & string], string>

export type DotPath<T> = T extends NonTraversable
  ? never
  : {
      [K in KnownPathKey<T>]:
        T[K] extends NonTraversable
          ? K
          : K | `${K}.${DotPath<T[K]>}`
    }[KnownPathKey<T>]

export type ValueAtPath<T, TPath extends string>
  = TPath extends `${infer THead}.${infer TTail}`
    ? THead extends keyof T
      ? ValueAtPath<T[THead], TTail>
      : never
    : TPath extends keyof T
      ? T[TPath]
      : never

export type DefineConfigValue<TConfig extends object> = Readonly<TConfig>

export type HoloProjectDefaults = typeof DEFAULT_HOLO_PROJECT_PATHS
