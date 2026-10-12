import type {} from '@nuxt/nitro-server'
import { mkdir, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadNuxt } from '@nuxt/kit'

export async function createNativeNuxt(rootDir: string, runtimeConfig: Record<string, unknown> = {}) {
  await mkdir(join(rootDir, 'node_modules'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../../../../apps/blog-nuxt/node_modules/nuxt'), join(rootDir, 'node_modules/nuxt')).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error
  })
  return await loadNuxt({ cwd: rootDir, ready: false, dev: false, overrides: { modules: [], runtimeConfig } })
}
