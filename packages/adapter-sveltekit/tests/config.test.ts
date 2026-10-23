import { describe, expect, it } from 'vitest'
import type { Config } from '@sveltejs/kit/vite'
import { withHoloSvelteKit } from '../src/config'

describe('@holo-js/adapter-sveltekit config', () => {
  it('wraps SvelteKit plugin options while preserving user options', () => {
    const config = withHoloSvelteKit({
      extensions: ['.svelte', '.svx'],
      files: {
        assets: 'assets',
        hooks: {
          client: 'src/hooks.client',
        },
      },
    })

    const mergedConfig: Config = config

    expect(mergedConfig.extensions).toEqual(['.svelte', '.svx'])
    expect(mergedConfig.files?.assets).toBe('assets')
    expect(mergedConfig.files?.hooks?.client).toBe('src/hooks.client')
    expect(mergedConfig.files?.hooks?.server).toBe('.holo-js/generated/hooks.server')
    expect(mergedConfig.files?.hooks?.universal).toBe('.holo-js/generated/hooks')
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
      files: {
        hooks: {
          server: 'src/custom-hooks.server',
        },
      },
    })).toThrow('Custom SvelteKit server or universal hook entrypoints are not supported')
  })

  it('uses APP_URL as the public origin when the app does not set paths.origin', () => {
    const previous = process.env.APP_URL
    process.env.APP_URL = 'https://app.example.test'
    try {
      const defaulted: Config = withHoloSvelteKit({})
      const custom: Config = withHoloSvelteKit({ paths: { origin: 'https://custom.example.test' } })
      expect(defaulted.paths).toEqual({ origin: 'https://app.example.test' })
      expect(custom.paths).toEqual({ origin: 'https://custom.example.test' })
    } finally {
      if (previous === undefined) delete process.env.APP_URL
      else process.env.APP_URL = previous
    }
  })

  it('leaves paths.origin unset when no public origin is configured', () => {
    const previous = process.env.APP_URL
    delete process.env.APP_URL
    try {
      const unset: Config = withHoloSvelteKit({})
      expect(unset.paths).toBeUndefined()
    } finally {
      if (previous !== undefined) process.env.APP_URL = previous
    }
  })

  it('keeps the adapter option at the top level of the SvelteKit plugin options', () => {
    const adapter = { name: 'test-adapter', adapt: async () => {} }
    const config = withHoloSvelteKit({ adapter })

    expect(config.adapter).toBe(adapter)
    expect(config).not.toHaveProperty('kit')
  })
})
