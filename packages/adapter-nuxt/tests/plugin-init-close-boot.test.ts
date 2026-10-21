import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { peekHolo, resolveGeneratedProjectRegistryPath } from '@holo-js/core'

vi.mock('#imports', () => ({
  defineNitroPlugin: <TPlugin>(plugin: TPlugin): TPlugin => plugin,
  useEvent: () => undefined,
  useRuntimeConfig: () => ({ holo: { projectRoot: projectRoot.current } }),
}))

const projectRoot = vi.hoisted(() => ({ current: '' }))
const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const databaseConfigEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/databaseConfig.ts'))
const tempRoots: string[] = []

async function createNuxtProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-nuxt-close-boot-'))
  tempRoots.push(root)
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await symlink(resolve(import.meta.dirname, '../../config'), join(root, 'node_modules/@holo-js/config'))
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'Nuxt App',
  key: 'base64:key',
  url: 'https://nuxt.test',
  debug: false,
  env: 'production',
  plugins: ['holo-plugin-close-during-boot'],
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databaseConfigEntry}

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: ':memory:',
      logging: false,
    },
  },
})
`, 'utf8')
  const registryPath = resolveGeneratedProjectRegistryPath(root)
  await mkdir(join(root, '.holo-js/generated'), { recursive: true })
  await writeFile(registryPath, `${JSON.stringify({
    version: 1,
    generatedAt: '2026-03-31T00:00:00.000Z',
    paths: {
      models: 'server/models',
      migrations: 'server/db/migrations',
      seeders: 'server/db/seeders',
      commands: 'server/commands',
      jobs: 'server/jobs',
      events: 'server/events',
      listeners: 'server/listeners',
      generatedSchema: 'server/db/schema.ts',
    },
    models: [],
    migrations: [],
    seeders: [],
    commands: [],
    jobs: [],
    events: [],
    listeners: [],
  }, null, 2)}\n`, 'utf8')
  const packageRoot = join(root, 'node_modules/holo-plugin-close-during-boot')
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: 'holo-plugin-close-during-boot',
    type: 'module',
    holo: { plugin: './plugin.mjs' },
  }, null, 2), 'utf8')
  await writeFile(join(packageRoot, 'plugin.mjs'), `
export default {
  id: 'close-during-boot',
  name: 'Close During Boot',
  contributes: {
    runtime: {
      boot: './boot.mjs',
    },
  },
}
`, 'utf8')
  await writeFile(join(packageRoot, 'boot.mjs'), `
export default async function boot() {
  await globalThis.__holoNuxtCloseDuringBoot__()
}
`, 'utf8')
  return root
}

function createNitroApp() {
  let closeHandler: (() => Promise<void>) | undefined
  return {
    nitroApp: {
      h3App: { options: {} as { onRequest?: (event: unknown) => Promise<void> } },
      hooks: {
        hook(_name: 'close', handler: () => Promise<void>) {
          closeHandler = handler
        },
      },
    },
    close: async () => {
      if (!closeHandler) throw new Error('close hook was not registered')
      await closeHandler()
    },
  }
}

async function loadInitPlugin() {
  const { default: init } = await import('../src/runtime/plugins/init')
  return init as unknown as (nitroApp: ReturnType<typeof createNitroApp>['nitroApp']) => void
}

function withTimeout<TValue>(promise: Promise<TValue>, ms: number): Promise<TValue> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out after ${ms}ms`)), ms)
    }),
  ]).finally(() => clearTimeout(timer))
}

afterEach(async () => {
  delete (globalThis as { __holoNuxtCloseDuringBoot__?: unknown }).__holoNuxtCloseDuringBoot__
  await peekHolo()?.shutdown().catch(() => undefined)
  for (const root of tempRoots.splice(0)) await rm(root, { recursive: true, force: true })
})

describe('Nuxt init plugin with a real Holo boot', () => {
  it('lets a plugin boot hook close Nuxt during startup and shuts Holo down after startup settles', async () => {
    projectRoot.current = await createNuxtProject()
    const app = createNitroApp()
    let closeReturned = false
    const bootGlobals = globalThis as typeof globalThis & { __holoNuxtCloseDuringBoot__?: () => Promise<void> }
    bootGlobals.__holoNuxtCloseDuringBoot__ = async () => {
      await withTimeout(app.close(), 2000)
      closeReturned = true
    }

    ;(await loadInitPlugin())(app.nitroApp)

    await vi.waitFor(() => expect(closeReturned).toBe(true), { timeout: 5000 })
    await app.nitroApp.h3App.options.onRequest?.({} as never)
    await vi.waitFor(() => expect(peekHolo()).toBeUndefined(), { timeout: 5000 })
  })
})
