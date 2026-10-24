import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { scaffoldProject } from '../src/project/scaffold/framework'
import type { ProjectScaffoldOptions } from '../src/project/shared'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scaffoldTsconfig(framework: ProjectScaffoldOptions['framework']): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), `holo-scaffold-tsconfig-${framework}-`))
  roots.push(projectRoot)
  await scaffoldProject(projectRoot, {
    projectName: 'Tsconfig App',
    framework,
    databaseDriver: 'sqlite',
    packageManager: 'bun',
    storageDefaultDisk: 'local',
    optionalPackages: [],
  })
  return await readFile(join(projectRoot, 'tsconfig.json'), 'utf8')
}

function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

describe('scaffolded tsconfig.json', () => {
  it('writes the Nuxt 4 project references layout that nuxi init writes', async () => {
    expect(await scaffoldTsconfig('nuxt')).toBe(`{
  "files": [],
  "references": [
    {
      "path": "./.nuxt/tsconfig.app.json"
    },
    {
      "path": "./.nuxt/tsconfig.server.json"
    },
    {
      "path": "./.nuxt/tsconfig.shared.json"
    },
    {
      "path": "./.nuxt/tsconfig.node.json"
    }
  ]
}
`)
  })

  it('writes the create-next-app 16 config and includes the generated Holo types', async () => {
    expect(await scaffoldTsconfig('next')).toBe(jsonFile({
      compilerOptions: {
        target: 'ES2017',
        lib: ['dom', 'dom.iterable', 'esnext'],
        allowJs: true,
        skipLibCheck: true,
        strict: true,
        noEmit: true,
        esModuleInterop: true,
        module: 'esnext',
        moduleResolution: 'bundler',
        resolveJsonModule: true,
        isolatedModules: true,
        jsx: 'react-jsx',
        incremental: true,
        plugins: [{ name: 'next' }],
        paths: { '@/*': ['./*'] },
      },
      include: [
        'next-env.d.ts',
        '**/*.ts',
        '**/*.tsx',
        '.next/types/**/*.ts',
        '.next/dev/types/**/*.ts',
        '**/*.mts',
        '.holo-js/generated/**/*.ts',
      ],
      exclude: ['node_modules'],
    }))
  })

  it('writes the sv create config and includes the Holo server, config, and generated directories', async () => {
    expect(await scaffoldTsconfig('sveltekit')).toBe(jsonFile({
      extends: '$app/tsconfig',
      compilerOptions: { strict: true },
      include: ['src', 'vite.config.ts', 'server', 'config', '.holo-js/generated/**/*.ts'],
    }))
  })
})
