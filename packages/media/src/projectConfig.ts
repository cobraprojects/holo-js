export interface HoloMediaConfig {
  readonly [key: string]: unknown
}

declare module '@holo-js/config' {
  interface HoloConfigRegistry {
    media: Readonly<HoloMediaConfig>
  }
}

export function normalizeMediaConfig(config: HoloMediaConfig = {}): Readonly<HoloMediaConfig> {
  return Object.freeze({ ...config })
}

export function defineMediaConfig<TConfig extends HoloMediaConfig>(config: TConfig): Readonly<TConfig> {
  return Object.freeze({ ...config })
}

registerConfigNormalizer<HoloMediaConfig, Readonly<HoloMediaConfig>>({
  name: 'media',
  normalize: normalizeMediaConfig,
})
import type {} from '@holo-js/config'
import { registerConfigNormalizer } from '@holo-js/config/registry'
