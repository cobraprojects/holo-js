import { describe, expect, it } from 'vitest'
import { moduleInternals } from '../src/module'
import { browserBuildSecret, buildBrowserBundleWithVite, createSecretRealtimeProject, realtimeProjectLayouts } from '../../../tests/support/realtime-browser-build'

describe('Nuxt realtime browser build', () => {
  it.each(realtimeProjectLayouts)('keeps handler source out of the browser bundle and its source maps with a %s project', async (layout) => {
    const { root, cleanup } = await createSecretRealtimeProject(layout)
    try {
      const bundle = await buildBrowserBundleWithVite(root, moduleInternals.createRealtimeDefinitionVitePlugin(root))
      expect(bundle).toContain('posts.list')
      expect(bundle).not.toContain(browserBuildSecret)
      expect(bundle).not.toContain('handler: async')
    } finally {
      await cleanup()
    }
  }, 30_000)
})
