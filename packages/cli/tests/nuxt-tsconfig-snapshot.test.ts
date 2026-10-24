import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProjectPrepare } from '../src/dev'
import { initializeProjectRuntime } from '../src/runtime'

const temporaryDirectories: string[] = []
const blogNuxtRoot = resolve(import.meta.dirname, '../../../apps/blog-nuxt')
const generatedDirectories = new Set(['node_modules', 'storage', '.holo-js', '.nuxt', '.output'])

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function createUpgradedNuxtProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-nuxt-snapshot-'))
  temporaryDirectories.push(root)
  await cp(blogNuxtRoot, root, {
    recursive: true,
    filter: source => !generatedDirectories.has(source.slice(blogNuxtRoot.length + 1).split('/')[0] ?? ''),
  })
  await symlink(join(blogNuxtRoot, 'node_modules'), join(root, 'node_modules'), 'dir')
  await mkdir(join(root, 'storage'), { recursive: true })
  await mkdir(join(root, 'lib/custom'), { recursive: true })
  await writeFile(join(root, 'lib/custom/label.ts'), "export const label = 'custom'\n")
  await writeFile(join(root, 'nuxt.config.ts'), `export default defineNuxtConfig({
  modules: ['@holo-js/adapter-nuxt'],
  alias: { '@custom': ${JSON.stringify(join(root, 'lib/custom'))} },
})
`)
  await writeFile(join(root, 'server/models/Custom.ts'), `import { defineModel } from '@holo-js/db'
import { label } from '@custom/label'

export const customLabel = label

export default defineModel('custom_labels', {
  fillable: ['name'],
})
`)

  await mkdir(join(root, 'server/jobs/custom'), { recursive: true })
  await writeFile(join(root, 'server/jobs/custom/index-label.ts'), `import { defineJob } from '@holo-js/queue'
import { label } from '@custom/label'

export const IndexLabel = defineJob<{ name: string }>({
  queue: 'default',
  async handle(payload) {
    return { name: payload.name, label }
  },
})
`)

  const nuxtPrepare = spawnSync('bun', ['x', 'nuxt', 'prepare'], { cwd: root, encoding: 'utf8' })
  expect(nuxtPrepare.status, nuxtPrepare.stderr).toBe(0)
  await rm(join(root, '.holo-js/generated/nuxt-tsconfig.json'), { force: true })
  expect(existsSync(join(root, '.nuxt/tsconfig.json'))).toBe(true)
  expect(existsSync(join(root, '.holo-js/generated/nuxt-tsconfig.json'))).toBe(false)
  return root
}

it('prepares an upgraded Nuxt project whose custom alias is used in a model before any snapshot exists', async () => {
  const root = await createUpgradedNuxtProject()

  await runProjectPrepare(root)

  expect(existsSync(join(root, '.holo-js/generated/nuxt-tsconfig.json'))).toBe(true)
  expect(await readFile(join(root, '.holo-js/generated/nuxt-tsconfig.json'), 'utf8')).toContain('@custom')
  const registry = JSON.parse(await readFile(join(root, '.holo-js/generated/registry.json'), 'utf8')) as {
    readonly jobs: ReadonlyArray<{ readonly sourcePath: string }>
  }
  expect(registry.jobs.map(job => job.sourcePath)).toContain('server/jobs/custom/index-label.ts')
}, 300_000)

it('initializes the runtime for an upgraded Nuxt project whose custom alias is used in a job before any snapshot exists', async () => {
  const root = await createUpgradedNuxtProject()
  const previousDirectory = process.cwd()
  process.chdir(root)

  try {
    const runtime = await initializeProjectRuntime(root)
    try {
      expect(existsSync(join(root, '.holo-js/generated/nuxt-tsconfig.json'))).toBe(true)
    } finally {
      await runtime.shutdown()
    }
  } finally {
    process.chdir(previousDirectory)
  }
}, 300_000)
