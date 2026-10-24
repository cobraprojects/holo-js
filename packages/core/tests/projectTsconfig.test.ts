import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { projectTsconfigInternals } from '../src/projectTsconfig'
import { runtimeModuleInternals } from '../src/runtimeModule'

const { parseTsconfigText, writeLoaderTsconfig, writeNuxtTsconfigSnapshot, missingNuxtTsconfigSnapshot } = projectTsconfigInternals

const nuxtTsconfigContents = JSON.stringify({
  compilerOptions: {
    paths: {
      '~/*': ['../*'],
      '@/*': ['../*'],
      '#imports': ['../lib/imports.ts'],
      'custom/*': ['../lib/custom/*'],
    },
  },
}, null, 2)

const nuxtReferencesTsconfig = `{
  "files": [],
  "references": [
    { "path": "./.nuxt/tsconfig.app.json" },
    { "path": "./.nuxt/tsconfig.server.json" },
    { "path": "./.nuxt/tsconfig.shared.json" },
    { "path": "./.nuxt/tsconfig.node.json" }
  ]
}
`

const entryContents = [
  "import { title } from '~/app/models/Post'",
  "import { util } from '@/lib/util'",
  "import { helper } from '#imports'",
  "import { tool } from 'custom/tool'",
  'export const definition = { title, util, helper, tool }',
  '',
].join('\n')

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

async function createNuxtProject(options: { readonly projectTsconfig?: string, readonly snapshot?: boolean } = {}): Promise<{
  readonly projectRoot: string
  readonly nuxtTsconfigPath: string
  readonly entryPath: string
}> {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'holo-project-tsconfig-')))
  temporaryDirectories.push(projectRoot)
  await writeFile(join(projectRoot, 'package.json'), '{"type":"module"}\n')
  await mkdir(join(projectRoot, 'app/models'), { recursive: true })
  await mkdir(join(projectRoot, 'lib/custom'), { recursive: true })
  await mkdir(join(projectRoot, '.nuxt'), { recursive: true })
  await writeFile(join(projectRoot, 'app/models/Post.ts'), "export const title = 'post'\n")
  await writeFile(join(projectRoot, 'lib/util.ts'), "export const util = 'util'\n")
  await writeFile(join(projectRoot, 'lib/imports.ts'), "export const helper = 'imports'\n")
  await writeFile(join(projectRoot, 'lib/custom/tool.ts'), "export const tool = 'tool'\n")
  await writeFile(join(projectRoot, 'entry.ts'), entryContents)
  const nuxtTsconfigPath = join(projectRoot, '.nuxt/tsconfig.json')
  await writeFile(nuxtTsconfigPath, nuxtTsconfigContents)
  await writeFile(join(projectRoot, 'tsconfig.json'), options.projectTsconfig ?? '// Nuxt owns the base config\n{ "extends": "./.nuxt/tsconfig.json", }\n')
  if (options.snapshot !== false) {
    await writeNuxtTsconfigSnapshot(projectRoot, join(projectRoot, '.nuxt'), { tsConfig: JSON.parse(nuxtTsconfigContents) as unknown })
  }
  return { projectRoot, nuxtTsconfigPath, entryPath: join(projectRoot, 'entry.ts') }
}

async function importBundled(projectRoot: string, entryPath: string): Promise<Record<string, unknown>> {
  const bundled = await runtimeModuleInternals.bundleRuntimeModule(projectRoot, entryPath)
  try {
    return await import(pathToFileURL(bundled.path).href) as Record<string, unknown>
  } finally {
    await bundled.cleanup()
  }
}

describe('project tsconfig loading for bundled definitions', () => {
  it('reads JSON with comments and trailing commas, keeping strings intact', () => {
    expect(parseTsconfigText('{ // note\n "url": "http://x/*", /* block */ "list": [1, 2,], }')).toEqual({
      url: 'http://x/*',
      list: [1, 2],
    })
    expect(parseTsconfigText('{')).toBeUndefined()
    expect(parseTsconfigText('[]')).toBeUndefined()
  })

  it('bundles definitions while .nuxt/tsconfig.json is being truncated concurrently', async () => {
    const { projectRoot, nuxtTsconfigPath, entryPath } = await createNuxtProject()
    let stopped = false
    const truncator = (async () => {
      let empty = true
      while (!stopped) {
        await writeFile(nuxtTsconfigPath, empty ? '' : nuxtTsconfigContents)
        empty = !empty
      }
      await writeFile(nuxtTsconfigPath, nuxtTsconfigContents)
    })()

    try {
      for (let attempt = 0; attempt < 30; attempt++) {
        const bundle = await importBundled(projectRoot, entryPath)
        expect(bundle.definition).toEqual({ title: 'post', util: 'util', helper: 'imports', tool: 'tool' })
      }
    } finally {
      stopped = true
      await truncator
    }
  })

  it('resolves the project tsconfig own baseUrl and paths from the bundle temp directory', async () => {
    const { projectRoot } = await createNuxtProject({
      projectTsconfig: JSON.stringify({
        extends: './.nuxt/tsconfig.json',
        compilerOptions: { baseUrl: '.', paths: { 'custom/*': ['./lib/custom/*'], '~/*': ['./*'], '@/*': ['./*'] } },
      }),
    })

    await writeFile(join(projectRoot, 'own.ts'), "import { util } from '@/lib/util'\nimport { tool } from 'custom/tool'\nexport const definition = { util, tool }\n")
    const bundle = await importBundled(projectRoot, join(projectRoot, 'own.ts'))

    expect(bundle.definition).toEqual({ util: 'util', tool: 'tool' })
  })

  it('does not read .nuxt/tsconfig.json when the snapshot is missing and keeps the default aliases', async () => {
    const { projectRoot, nuxtTsconfigPath } = await createNuxtProject({ snapshot: false })
    await writeFile(nuxtTsconfigPath, '')
    await writeFile(join(projectRoot, 'entry.ts'), "import { util } from '@/lib/util'\nexport const definition = { util }\n")

    expect(await missingNuxtTsconfigSnapshot(projectRoot)).toBe(true)
    const bundle = await importBundled(projectRoot, join(projectRoot, 'entry.ts'))

    expect(bundle.definition).toEqual({ util: 'util' })
  })

  it('bundles definitions from the snapshot when the project tsconfig references the Nuxt build configs', async () => {
    const { projectRoot, nuxtTsconfigPath, entryPath } = await createNuxtProject({ projectTsconfig: nuxtReferencesTsconfig })
    await writeFile(nuxtTsconfigPath, '')

    const bundle = await importBundled(projectRoot, entryPath)

    expect(bundle.definition).toEqual({ title: 'post', util: 'util', helper: 'imports', tool: 'tool' })
  })

  it('keeps the default aliases for a references tsconfig whose snapshot is missing', async () => {
    const { projectRoot } = await createNuxtProject({ projectTsconfig: nuxtReferencesTsconfig, snapshot: false })
    await writeFile(join(projectRoot, 'entry.ts'), "import { util } from '@/lib/util'\nexport const definition = { util }\n")

    expect(await missingNuxtTsconfigSnapshot(projectRoot)).toBe(true)
    const bundle = await importBundled(projectRoot, join(projectRoot, 'entry.ts'))

    expect(bundle.definition).toEqual({ util: 'util' })
  })

  it('keeps the project tsconfig path when it does not extend the Nuxt build directory', async () => {
    const projectRoot = await realpath(await mkdtemp(join(tmpdir(), 'holo-project-tsconfig-plain-')))
    temporaryDirectories.push(projectRoot)
    const tempDir = join(projectRoot, 'bundle')
    await mkdir(tempDir, { recursive: true })
    await writeFile(join(projectRoot, 'tsconfig.json'), '{"compilerOptions":{"paths":{"@/*":["./*"]}}}\n')

    expect(await writeLoaderTsconfig(projectRoot, tempDir)).toBe(join(projectRoot, 'tsconfig.json'))
  })
})

describe('Nuxt tsconfig snapshot', () => {
  it('writes the compiler options with absolute paths and skips rewriting unchanged contents', async () => {
    const { projectRoot } = await createNuxtProject({ snapshot: false })
    const payload = { tsConfig: JSON.parse(nuxtTsconfigContents) as unknown }

    await writeNuxtTsconfigSnapshot(projectRoot, join(projectRoot, '.nuxt'), payload)
    const snapshotPath = join(projectRoot, '.holo-js/generated/nuxt-tsconfig.json')
    const first = await stat(snapshotPath)
    const snapshot = JSON.parse(await readFile(snapshotPath, 'utf8')) as { compilerOptions: { paths: Record<string, string[]> } }

    expect(snapshot.compilerOptions.paths['~/*']).toEqual([join(projectRoot, '*')])
    expect(snapshot.compilerOptions.paths['#imports']).toEqual([join(projectRoot, 'lib/imports.ts')])
    expect(await missingNuxtTsconfigSnapshot(projectRoot)).toBe(false)

    await writeNuxtTsconfigSnapshot(projectRoot, join(projectRoot, '.nuxt'), payload)
    expect((await stat(snapshotPath)).ino).toBe(first.ino)
  })

  it('snapshots the server config with the root aliases Nitro resolves at runtime', async () => {
    const { projectRoot } = await createNuxtProject({ projectTsconfig: nuxtReferencesTsconfig, snapshot: false })

    await writeNuxtTsconfigSnapshot(projectRoot, join(projectRoot, '.nuxt'), {
      tsConfig: {
        compilerOptions: {
          jsx: 'preserve',
          paths: { '~~/*': ['../*'], '#app': ['../node_modules/nuxt/app'], 'custom/*': ['../lib/app-only/*'] },
        },
      },
      serverTsConfig: {
        compilerOptions: {
          moduleResolution: 'Bundler',
          paths: { '#imports': ['../lib/imports.ts'], 'custom/*': ['../lib/custom/*'] },
        },
      },
    })
    const snapshot = JSON.parse(await readFile(join(projectRoot, '.holo-js/generated/nuxt-tsconfig.json'), 'utf8')) as unknown

    expect(snapshot).toEqual({
      compilerOptions: {
        moduleResolution: 'Bundler',
        paths: {
          '~~/*': [join(projectRoot, '*')],
          '#imports': [join(projectRoot, 'lib/imports.ts')],
          'custom/*': [join(projectRoot, 'lib/custom/*')],
        },
      },
    })
    await writeFile(join(projectRoot, 'entry.ts'), "import { tool } from 'custom/tool'\nimport { util } from '~~/lib/util'\nexport const definition = { tool, util }\n")
    expect((await importBundled(projectRoot, join(projectRoot, 'entry.ts'))).definition).toEqual({ tool: 'tool', util: 'util' })
  })

  it('never exposes a partially written snapshot to a concurrent reader', async () => {
    const { projectRoot } = await createNuxtProject({ snapshot: false })
    const snapshotPath = join(projectRoot, '.holo-js/generated/nuxt-tsconfig.json')
    const large = (size: number): Record<string, unknown> => ({
      compilerOptions: {
        paths: Object.fromEntries(Array.from({ length: size }, (_entry, index) => [`alias${index}/*`, [`../lib/${index}/*`]])),
      },
    })
    await writeNuxtTsconfigSnapshot(projectRoot, join(projectRoot, '.nuxt'), { tsConfig: large(400) })
    let stopped = false
    const writer = (async () => {
      for (let round = 0; round < 60 && !stopped; round++) {
        await writeNuxtTsconfigSnapshot(projectRoot, join(projectRoot, '.nuxt'), { tsConfig: large(round % 2 === 0 ? 400 : 800) })
      }
    })()

    const parsedReads: boolean[] = []
    for (let read = 0; read < 200; read++) {
      const contents = await readFile(snapshotPath, 'utf8')
      parsedReads.push(parseTsconfigText(contents) !== undefined)
    }
    stopped = true
    await writer

    expect(parsedReads.every(Boolean)).toBe(true)
  })
})
