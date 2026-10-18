import type {
  HoloProjectConfig,
  HoloProjectPaths,
} from '@holo-js/kernel'
import type { HoloExceptionsConfig } from '@holo-js/kernel/error-reporting'

export type HoloAppEnv = 'development' | 'production' | 'test'

export interface HoloAppConfig extends HoloProjectConfig {
  name?: string
  key?: string
  url?: string
  timezone?: string
  debug?: boolean
  env?: HoloAppEnv
  plugins?: readonly string[]
  exceptions?: HoloExceptionsConfig
}

export interface NormalizedHoloAppConfig {
  readonly name: string
  readonly key: string
  readonly url: string
  readonly timezone: string
  readonly debug: boolean
  readonly env: HoloAppEnv
  readonly plugins: readonly string[]
  readonly exceptions: Readonly<HoloExceptionsConfig>
  readonly paths: Readonly<HoloProjectPaths>
  readonly models: readonly string[]
  readonly migrations: readonly string[]
  readonly seeders: readonly string[]
}

export * from './type-helpers'
