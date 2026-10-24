import { describe, expect, it } from 'vitest'
import { holoSvelteKitRealtime } from '../src/vite'
import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { addSymlinkedRealtimeFile, browserBuildSecret, buildBrowserBundleWithVite, createSecretRealtimeProject, realtimeProjectLayouts, symlinkedFileError } from '../../../tests/support/realtime-browser-build'

describe('SvelteKit realtime browser build', () => {
  it.each(realtimeProjectLayouts)('keeps handler source out of the browser bundle and its source maps with a %s project', async (layout) => {
    const { root, cleanup } = await createSecretRealtimeProject(layout)
    try {
      const bundle = await buildBrowserBundleWithVite(root, holoSvelteKitRealtime(root))
      expect(bundle).toContain('posts.list')
      expect(bundle).not.toContain(browserBuildSecret)
      expect(bundle).not.toContain('handler: async')
    } finally {
      await cleanup()
    }
  }, 30_000)

  it('refuses a symlinked file inside server/realtime when the plugin starts', async () => {
    const { root, cleanup } = await createSecretRealtimeProject()
    try {
      await addSymlinkedRealtimeFile(root)
      expect(() => holoSvelteKitRealtime(root)).toThrow(symlinkedFileError)
    } finally {
      await cleanup()
    }
  })

  it('refuses a symlinked file added to server/realtime while the dev server runs', async () => {
    const { root, cleanup } = await createSecretRealtimeProject()
    try {
      const plugin = holoSvelteKitRealtime(root) as unknown as {
        configureServer(server: { readonly watcher: EventEmitter }): void
        load(id: string, options?: { readonly ssr?: boolean }): unknown
      }
      const watcher = new EventEmitter()
      plugin.configureServer({ watcher })
      expect(() => plugin.load(join(root, 'app.ts'))).not.toThrow()

      await addSymlinkedRealtimeFile(root)
      watcher.emit('all', 'add', join(root, 'server/realtime/linked.ts'))
      expect(() => plugin.load(join(root, 'app.ts'))).toThrow(symlinkedFileError)
    } finally {
      await cleanup()
    }
  })
})
