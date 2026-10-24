import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { holoSvelteKitRealtime } from '../src/vite'
import { browserBuildSecret, buildBrowserBundleWithVite, createSecretRealtimeProject } from '../../../tests/support/realtime-browser-build'

describe('SvelteKit realtime browser build', () => {
  it('keeps handler source out of the browser bundle and its source maps', async () => {
    const root = await createSecretRealtimeProject()
    try {
      const bundle = await buildBrowserBundleWithVite(root, holoSvelteKitRealtime(root))
      expect(bundle).toContain('posts.list')
      expect(bundle).not.toContain(browserBuildSecret)
      expect(bundle).not.toContain('handler: async')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
