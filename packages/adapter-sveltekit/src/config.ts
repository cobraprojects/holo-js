import type { Config } from '@sveltejs/kit'
import type { PreprocessorGroup } from 'svelte/compiler'
import {
  HOLO_SVELTE_PREPROCESS_NAME,
  holoSveltePreprocess,
} from './preprocess'

const managedServerHooksPath = '.holo-js/generated/hooks.server'
const managedUniversalHooksPath = '.holo-js/generated/hooks'

function toPreprocessorArray(preprocess: Config['preprocess']): PreprocessorGroup[] {
  if (!preprocess) {
    return []
  }

  return Array.isArray(preprocess) ? [...preprocess] : [preprocess]
}

function hasHoloPreprocess(preprocessors: readonly PreprocessorGroup[]): boolean {
  return preprocessors.some(preprocessor => preprocessor.name === HOLO_SVELTE_PREPROCESS_NAME)
}

function assertNoCustomManagedHooks(config: Config): void {
  const hooks = config.kit?.files?.hooks
  const customServerHook = hooks?.server && hooks.server !== managedServerHooksPath
  const customUniversalHook = hooks?.universal && hooks.universal !== managedUniversalHooksPath
  if (customServerHook || customUniversalHook) {
    throw new Error('[@holo-js/adapter-sveltekit] Custom SvelteKit server or universal hook entrypoints are not supported. Move user hook code to src/hooks.ts and src/hooks.server.ts so Holo can manage the hook bridge.')
  }
}

export function withHoloSvelteKit<TConfig extends Config = Config>(
  config: TConfig = {} as TConfig,
): TConfig {
  assertNoCustomManagedHooks(config)

  const preprocessors = toPreprocessorArray(config.preprocess)
  const mergedPreprocessors = hasHoloPreprocess(preprocessors)
    ? preprocessors
    : [...preprocessors, holoSveltePreprocess()]

  return {
    ...config,
    preprocess: mergedPreprocessors,
    kit: {
      ...(config.kit ?? {}),
      files: {
        ...(config.kit?.files ?? {}),
        hooks: {
          ...(config.kit?.files?.hooks ?? {}),
          server: managedServerHooksPath,
          universal: managedUniversalHooksPath,
        },
      },
    },
  } as TConfig
}
