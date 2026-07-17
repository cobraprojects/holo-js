import type {
  HoloProjectConfig,
  HoloProjectPaths,
} from '@holo-js/kernel'

export type HoloAppEnv = 'development' | 'production' | 'test'

export interface HoloAppConfig extends HoloProjectConfig {
  name?: string
  key?: string
  url?: string
  debug?: boolean
  env?: HoloAppEnv
  plugins?: readonly string[]
}

export interface NormalizedHoloAppConfig {
  readonly name: string
  readonly key: string
  readonly url: string
  readonly debug: boolean
  readonly env: HoloAppEnv
  readonly plugins: readonly string[]
  readonly paths: Readonly<HoloProjectPaths>
  readonly models: readonly string[]
  readonly migrations: readonly string[]
  readonly seeders: readonly string[]
}

export * from './type-helpers'
