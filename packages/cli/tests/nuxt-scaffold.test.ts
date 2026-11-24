import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { subset } from 'semver'
import { afterEach, describe, expect, it } from 'vitest'
import { scaffoldProject } from '../src/project/scaffold/framework'

type PackageManifest = {
  readonly dependencies?: Readonly<Record<string, string>>
}

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scaffoldNuxtApp(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-nuxt-scaffold-'))
  roots.push(projectRoot)
  await scaffoldProject(projectRoot, {
    projectName: 'Nuxt App',
    framework: 'nuxt',
    databaseDriver: 'sqlite',
    packageManager: 'bun',
    storageDefaultDisk: 'local',
    optionalPackages: [],
  })
  return projectRoot
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

function installedNuxtManifestPath(): string {
  const nuxtAdapterManifest = fileURLToPath(new URL('../../adapter-nuxt/package.json', import.meta.url))
  return createRequire(nuxtAdapterManifest).resolve('nuxt/package.json')
}

describe('scaffolded Nuxt app', () => {
  it('writes the nuxt.config of the Nuxt starter plus the Holo module', async () => {
    const projectRoot = await scaffoldNuxtApp()

    expect(await readFile(join(projectRoot, 'nuxt.config.ts'), 'utf8')).toBe(`export default defineNuxtConfig({
  compatibilityDate: '2025-07-15',
  modules: ['@holo-js/adapter-nuxt'],
  sourcemap: {
    client: false,
    server: false,
  },
  vite: {
    build: {
      rollupOptions: {
        onwarn(warning, defaultHandler) {
          if (
            warning.message.includes('nuxt:module-preload-polyfill')
            && warning.message.includes('didn\\'t generate a sourcemap')
          ) {
            return
          }

          defaultHandler(warning)
        },
      },
    },
  },
})
`)
  })

  it.each(['vue', 'vue-router'])('declares a %s range within the range the scaffolded Nuxt requires', async (dependency) => {
    const projectRoot = await scaffoldNuxtApp()
    const app = await readManifest(join(projectRoot, 'package.json'))
    const nuxt = await readManifest(installedNuxtManifestPath())

    const appRange = app.dependencies?.[dependency]
    const nuxtRange = nuxt.dependencies?.[dependency]

    expect(appRange).toBeDefined()
    expect(nuxtRange).toBeDefined()
    expect(subset(appRange!, nuxtRange!), `${dependency} ${appRange} must be within Nuxt's ${nuxtRange}`).toBe(true)
  })

  it('does not opt the app into Nitro v3', async () => {
    const projectRoot = await scaffoldNuxtApp()
    const app = await readManifest(join(projectRoot, 'package.json'))

    expect(app.dependencies).not.toHaveProperty('nitro')
  })
})
