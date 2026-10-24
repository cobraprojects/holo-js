import { describe, expect, it } from 'vitest'
import { renderScaffoldPackageJson } from '../src/project/scaffold/framework'

const base = {
  projectName: 'Scaffold App',
  databaseDriver: 'sqlite',
  packageManager: 'bun',
  storageDefaultDisk: 'local',
  optionalPackages: [],
} as const

describe('SvelteKit scaffold package.json', () => {
  it('maps #lib to src/lib so scaffolded code can import from it', () => {
    const manifest = JSON.parse(renderScaffoldPackageJson({ ...base, framework: 'sveltekit' })) as { imports?: Record<string, string> }

    expect(manifest.imports).toEqual({
      '#lib': './src/lib/index.js',
      '#lib/*': './src/lib/*',
    })
  })

  it('adds no subpath imports for frameworks that do not use #lib', () => {
    const manifest = JSON.parse(renderScaffoldPackageJson({ ...base, framework: 'next' })) as { imports?: Record<string, string> }

    expect(manifest.imports).toBeUndefined()
  })
})
