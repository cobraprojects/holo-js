import { copyFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineConfig } from 'tsup'

const outDir = process.env.HOLO_BUILD_OUT_DIR ?? 'dist'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    config: 'src/config.ts',
    client: 'src/client.ts',
    'next/client': 'src/next/client.ts',
    'next/server': 'src/next/server.ts',
    'sveltekit/client': 'src/sveltekit/client.ts',
    'sveltekit/server': 'src/sveltekit/server.ts',
    nuxt: 'src/nuxt.ts',
    'nuxt/server': 'src/nuxt/server.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  external: ['#imports', 'next/navigation.js', 'next/server.js', 'react', 'svelte', 'svelte/reactivity'],
  outDir,
  outExtension: () => ({ js: '.mjs' }),
  async onSuccess() {
    await copyFile(join(outDir, 'index.mjs'), join(outDir, 'index'))

    const nextServerPath = join(outDir, 'next/server.mjs')
    const nextServer = await readFile(nextServerPath, 'utf8')
    await writeFile(join(outDir, 'next/server.edge.mjs'), nextServer)

    const rewrittenNextServer = nextServer
      .replace('var sourceAuthRuntimePath = "../index";', '')
      .replace('return await import(sourceAuthRuntimePath);', 'return await import("../index.mjs");')

    await writeFile(nextServerPath, rewrittenNextServer)
  },
  esbuildOptions(options) {
    options.logLevel = 'warning'
  },
})
