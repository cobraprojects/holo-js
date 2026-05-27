import { describe, expect, it } from 'vitest'
import type { Config } from '@sveltejs/kit'
import { withHoloSvelteKit } from '../src/config'

describe('@holo-js/adapter-sveltekit config', () => {
  it('wraps SvelteKit config while preserving user options', () => {
    const config = withHoloSvelteKit({
      extensions: ['.svelte', '.svx'],
      kit: {
        alias: {
          $components: './src/components',
        },
        files: {
          assets: 'assets',
          hooks: {
            client: 'src/hooks.client',
          },
        },
      },
    })

    const mergedConfig: Config = config

    expect(mergedConfig.extensions).toEqual(['.svelte', '.svx'])
    expect(mergedConfig.kit?.alias).toEqual({ $components: './src/components' })
    expect(mergedConfig.kit?.files?.assets).toBe('assets')
    expect(mergedConfig.kit?.files?.hooks?.client).toBe('src/hooks.client')
    expect(mergedConfig.kit?.files?.hooks?.server).toBe('.holo-js/generated/hooks.server')
    expect(mergedConfig.kit?.files?.hooks?.universal).toBe('.holo-js/generated/hooks')
  })

  it('appends the Holo preprocessor without duplicating it', () => {
    const customPreprocess = { name: 'custom-preprocess' }
    const config = withHoloSvelteKit({
      preprocess: customPreprocess,
    })
    const wrappedAgain = withHoloSvelteKit(config)

    expect(Array.isArray(config.preprocess)).toBe(true)
    expect(config.preprocess).toEqual([
      customPreprocess,
      expect.objectContaining({ name: 'holo-sveltekit' }),
    ])
    expect(Array.isArray(wrappedAgain.preprocess)).toBe(true)
    expect(wrappedAgain.preprocess).toEqual(config.preprocess)
  })

  it('rejects custom server and universal hook entrypoints', () => {
    expect(() => withHoloSvelteKit({
      kit: {
        files: {
          hooks: {
            server: 'src/custom-hooks.server',
          },
        },
      },
    })).toThrow('Custom SvelteKit server or universal hook entrypoints are not supported')
  })
})
