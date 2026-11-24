import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

type NuxtConfig = {
  readonly compatibilityDate?: string
  readonly modules?: readonly string[]
}

async function loadNuxtConfig(projectRoot: string): Promise<NuxtConfig> {
  const configRoot = await mkdtemp(join(tmpdir(), 'holo-nuxt-config-'))
  roots.push(configRoot)
  const configPath = join(configRoot, 'nuxt.config.ts')
  await copyFile(join(projectRoot, 'nuxt.config.ts'), configPath)
  const globals = globalThis as typeof globalThis & { defineNuxtConfig?: (config: NuxtConfig) => NuxtConfig }
  globals.defineNuxtConfig = config => config
  try {
    const module = await import(pathToFileURL(configPath).href) as { readonly default: NuxtConfig }
    return module.default
  } finally {
    delete globals.defineNuxtConfig
  }
}

async function readManifest(path: string): Promise<PackageManifest> {
  return JSON.parse(await readFile(path, 'utf8')) as PackageManifest
}

function installedNuxtManifestPath(): string {
  const nuxtAdapterManifest = fileURLToPath(new URL('../../adapter-nuxt/package.json', import.meta.url))
  return createRequire(nuxtAdapterManifest).resolve('nuxt/package.json')
}

describe('scaffolded Nuxt app', () => {
  it('configures the Nuxt starter compatibility date and the Holo module', async () => {
    const projectRoot = await scaffoldNuxtApp()

    const config = await loadNuxtConfig(projectRoot)

    expect(config.compatibilityDate).toBe('2025-07-15')
    expect(config.modules).toEqual(['@holo-js/adapter-nuxt'])
  })

  it('declares Nuxt 4.7 with the Vue and Vue Router ranges it requires', async () => {
    const projectRoot = await scaffoldNuxtApp()
    const app = await readManifest(join(projectRoot, 'package.json'))

    expect(app.dependencies).toMatchObject({
      'nuxt': '^4.7.0',
      'vue': '^3.5.46',
      'vue-router': '^5.5.1',
    })
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
