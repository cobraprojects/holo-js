import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const buildState = vi.hoisted(() => ({
  builds: 0,
  dependencyChangeBuild: Number.POSITIVE_INFINITY,
  definitionPath: '',
  dependencyPath: '',
  outputPaths: [] as string[],
  projectRoot: '',
  runtimeAsset: false,
}))

vi.mock('esbuild', () => ({
  async build(options: { readonly outfile: string }) {
    buildState.builds += 1
    buildState.outputPaths.push(options.outfile)
    const version = await readFile(buildState.dependencyPath, 'utf8').then(value => value.trim()).catch(() => 'removed')
    if (buildState.runtimeAsset) await writeFile(join(dirname(options.outfile), 'runtime-value.txt'), version)
    await writeFile(options.outfile, `
${buildState.runtimeAsset ? "import { readFile } from 'node:fs/promises'" : ''}
const definition = ${buildState.runtimeAsset
  ? "async () => [{ version: await readFile(new URL('./runtime-value.txt', import.meta.url), 'utf8') }]"
  : `() => [{ version: ${JSON.stringify(version)} }]`}
Object.defineProperties(definition, {
  kind: { value: 'query', enumerable: true },
  name: { value: 'cache.consistent', enumerable: true },
  access: { value: 'public', enumerable: true },
  handler: { value: definition, enumerable: true },
  $types: { value: undefined, enumerable: true },
})
Object.defineProperty(definition, Symbol.for('holo-js.realtime.definition'), { value: true })
export { definition }
`)
    if (buildState.builds === buildState.dependencyChangeBuild) {
      await writeFile(buildState.dependencyPath, String(Number(version) + 1))
    }
    return {
      metafile: {
        inputs: {
          [relative(buildState.projectRoot, buildState.definitionPath)]: { bytes: 1, imports: [] },
          [relative(
            buildState.projectRoot,
            version === 'removed' ? buildState.definitionPath : buildState.dependencyPath,
          )]: { bytes: 1, imports: [] },
        },
        outputs: {},
      },
    }
  },
}))

import { resolveRealtimeDefinition } from '../src/server'

const temporaryDirectories: string[] = []

afterEach(async () => {
  buildState.builds = 0
  buildState.dependencyChangeBuild = Number.POSITIVE_INFINITY
  buildState.definitionPath = ''
  buildState.dependencyPath = ''
  buildState.outputPaths.length = 0
  buildState.projectRoot = ''
  buildState.runtimeAsset = false
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('realtime module cache consistency', () => {
  it('removes bundles retained by dead processes without deleting live process bundles', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-cache-cleanup-'))
    temporaryDirectories.push(projectRoot)
    const realtimeRoot = join(projectRoot, 'server/realtime')
    const runtimeRoot = join(projectRoot, '.holo-js/runtime')
    const definitionPath = join(realtimeRoot, 'definition.ts')
    const dependencyPath = join(realtimeRoot, 'value.ts')
    const deadBundleRoot = join(runtimeRoot, 'realtime-2147483647-dead')
    const liveBundleRoot = join(runtimeRoot, `realtime-${process.pid}-live`)
    const legacyBundleRoot = join(runtimeRoot, 'realtime-legacy')
    const unrelatedRoot = join(runtimeRoot, 'unrelated')
    await mkdir(deadBundleRoot, { recursive: true })
    await mkdir(liveBundleRoot, { recursive: true })
    await mkdir(legacyBundleRoot, { recursive: true })
    await mkdir(unrelatedRoot, { recursive: true })
    await mkdir(realtimeRoot, { recursive: true })
    await writeFile(definitionPath, '')
    await writeFile(dependencyPath, '1')
    buildState.projectRoot = projectRoot
    buildState.definitionPath = definitionPath
    buildState.dependencyPath = dependencyPath

    await resolveRealtimeDefinition('cache.consistent', { projectRoot })

    await expect(stat(deadBundleRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(legacyBundleRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(liveBundleRoot)).resolves.toBeDefined()
    await expect(stat(unrelatedRoot)).resolves.toBeDefined()
  })

  it('keeps module-relative runtime resources available to resolved handlers', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-cache-runtime-resource-'))
    temporaryDirectories.push(projectRoot)
    const realtimeRoot = join(projectRoot, 'server/realtime')
    const definitionPath = join(realtimeRoot, 'definition.ts')
    const dependencyPath = join(realtimeRoot, 'value.ts')
    await mkdir(realtimeRoot, { recursive: true })
    await writeFile(definitionPath, '')
    await writeFile(dependencyPath, 'runtime')
    buildState.projectRoot = projectRoot
    buildState.definitionPath = definitionPath
    buildState.dependencyPath = dependencyPath
    buildState.runtimeAsset = true

    const definition = await resolveRealtimeDefinition('cache.consistent', { projectRoot })

    await expect(definition.handler({} as never)).resolves.toEqual([{ version: 'runtime' }])
  })

  it('rebuilds when a newly discovered dependency changes during the first build', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-cache-first-build-'))
    temporaryDirectories.push(projectRoot)
    const realtimeRoot = join(projectRoot, 'server/realtime')
    const definitionPath = join(realtimeRoot, 'definition.ts')
    const dependencyPath = join(realtimeRoot, 'value.ts')
    await mkdir(realtimeRoot, { recursive: true })
    await writeFile(definitionPath, '')
    await writeFile(dependencyPath, '1')
    buildState.projectRoot = projectRoot
    buildState.definitionPath = definitionPath
    buildState.dependencyPath = dependencyPath
    buildState.dependencyChangeBuild = 1

    const definition = await resolveRealtimeDefinition('cache.consistent', { projectRoot })

    expect(await definition.handler({} as never)).toEqual([{ version: '2' }])
    expect(buildState.builds).toBe(2)
    await expect(stat(dirname(buildState.outputPaths[0]!))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(dirname(buildState.outputPaths[1]!))).resolves.toBeDefined()
  })

  it('rebuilds when a known dependency changes while bundling', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-cache-'))
    temporaryDirectories.push(projectRoot)
    const realtimeRoot = join(projectRoot, 'server/realtime')
    const definitionPath = join(realtimeRoot, 'definition.ts')
    const dependencyPath = join(realtimeRoot, 'value.ts')
    await mkdir(realtimeRoot, { recursive: true })
    await writeFile(definitionPath, '')
    await writeFile(dependencyPath, '1')
    buildState.projectRoot = projectRoot
    buildState.definitionPath = definitionPath
    buildState.dependencyPath = dependencyPath

    const initial = await resolveRealtimeDefinition('cache.consistent', { projectRoot })
    expect(await initial.handler({} as never)).toEqual([{ version: '1' }])
    const initialBundleRoot = dirname(buildState.outputPaths.at(-1)!)

    await writeFile(dependencyPath, '2')
    buildState.dependencyChangeBuild = buildState.builds + 1
    const rebuilt = await resolveRealtimeDefinition('cache.consistent', { projectRoot })
    expect(await rebuilt.handler({} as never)).toEqual([{ version: '3' }])
    expect(buildState.builds).toBe(4)
    await expect(stat(initialBundleRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(dirname(buildState.outputPaths.at(-1)!))).resolves.toBeDefined()
  })

  it('rebuilds after a previously tracked dependency is removed', async () => {
    const projectRoot = await mkdtemp(join(import.meta.dirname, '../.tmp-realtime-cache-removed-'))
    temporaryDirectories.push(projectRoot)
    const realtimeRoot = join(projectRoot, 'server/realtime')
    const definitionPath = join(realtimeRoot, 'definition.ts')
    const dependencyPath = join(realtimeRoot, 'value.ts')
    await mkdir(realtimeRoot, { recursive: true })
    await writeFile(definitionPath, '')
    await writeFile(dependencyPath, '1')
    buildState.projectRoot = projectRoot
    buildState.definitionPath = definitionPath
    buildState.dependencyPath = dependencyPath

    await resolveRealtimeDefinition('cache.consistent', { projectRoot })
    await rm(dependencyPath)

    const rebuilt = await resolveRealtimeDefinition('cache.consistent', { projectRoot })
    expect(await rebuilt.handler({} as never)).toEqual([{ version: 'removed' }])
  })
})
