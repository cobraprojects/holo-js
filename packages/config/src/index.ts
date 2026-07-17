import type { NormalizedHoloRedisConfig } from '@holo-js/kernel'
import type { NormalizedHoloAppConfig } from './types'

export interface HoloConfigRegistry {
  app: NormalizedHoloAppConfig
  redis: NormalizedHoloRedisConfig
}

export {
  DEFAULT_APP_NAME,
  normalizeAppConfig,
  normalizeAppEnv,
  holoAppDefaults,
} from './defaults'
export {
  config,
  configureConfigRuntime,
  createConfigAccessors,
  resetConfigRuntime,
  useConfig,
} from './access'
export {
  configureEnvRuntime,
  env,
  isEnvPlaceholder,
  loadEnvironment,
  resolveAppEnvironment,
  resolveEnvironmentFileOrder,
  resolveEnvPlaceholders,
} from './env'
export {
  clearConfigCache,
  defineAppConfig,
  defineConfig,
  loaderInternals,
  loadConfigDirectory,
  resolveConfigCachePath,
  writeConfigCache,
} from './loader'
export {
  composeRegisteredConfig,
  configRegistryInternals,
  registerConfigNormalizer,
  resetConfigNormalizers,
} from './registry'
export type {
  HoloConfigNormalizer,
  HoloConfigNormalizerContext,
} from './registry'
export type {
  ConfigFileName,
  DefineConfigValue,
  DotPath,
  LoadedEnvironment,
  LoadedHoloConfig,
  NormalizedHoloAppConfig,
  HoloAppConfig,
  HoloAppEnv,
  HoloConfigMap,
  HoloConfigValues,
  ValueAtPath,
} from './types'
