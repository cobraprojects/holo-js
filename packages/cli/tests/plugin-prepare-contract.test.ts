import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  normalizeHoloProjectConfig,
  type HoloProjectPrepareContext,
  type HoloProjectPreparer,
} from '@holo-js/kernel'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPluginProjectPreparers } from '../src/project/plugin-prepare/coordinator'
import { type LoadedProjectPreparer, loadProjectPluginPreparation } from '../src/project/plugins'

vi.mock('../src/project/plugins', () => ({
  loadProjectPluginPreparation: vi.fn(),
}))

const mockedLoadPreparation = vi.mocked(loadProjectPluginPreparation)
const mockedLoadPreparers = {
  mockReset() {
    mockedLoadPreparation.mockReset()
  },
  mockResolvedValue(preparers: readonly LoadedProjectPreparer[]) {
    mockedLoadPreparation.mockResolvedValue({
      activePlugins: preparers.map(preparer => preparer.plugin),
      preparers,
    })
  },
}
const projectRoots: string[] = []

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-plugin-prepare-contract-'))
  projectRoots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  return root
}

function loadedPreparer(
  root: string,
  id: string,
  preparer: HoloProjectPreparer,
  packageName = `holo-${id}`,
): LoadedProjectPreparer {
  return {
    plugin: {
      packageName,
      packageRoot: join(root, 'node_modules', packageName),
      entryPath: join(root, 'node_modules', packageName, 'plugin.mjs'),
      definition: {
        id,
        name: `Plugin ${id}`,
        contributes: { project: { prepare: './prepare.mjs' } },
      },
    },
    specifier: './prepare.mjs',
    preparer,
  }
}

async function runFull(root: string, options: Parameters<typeof runPluginProjectPreparers>[2] = {
  run: { kind: 'full', command: 'prepare', reason: 'explicit' },
}): Promise<void> {
  await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
}

async function expectMissing(path: string): Promise<void> {
  await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' })
}

describe('plugin project preparation contract', () => {
  beforeEach(() => {
    mockedLoadPreparers.mockReset()
  })

  afterEach(async () => {
    await Promise.all(projectRoots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })

  it('supplies the exact stable framework context when detected and omits it otherwise', async () => {
    const root = await createProject()
    const contexts: HoloProjectPrepareContext[] = []
    const config = normalizeHoloProjectConfig()
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: (context) => {
        contexts.push(context)
        return { kind: 'prepared' }
      },
    })])

    const framework = {
      id: 'next',
      displayName: 'Next.js',
      adapterPackage: '@holo-js/next' as const,
      fluxPackage: '@holo-js/flux-next' as const,
      capabilities: { managedBroadcastAuthRoute: true },
    }
    await runPluginProjectPreparers(root, config, {
      run: { kind: 'full', command: 'build', reason: 'initial' },
      framework,
    })
    await runPluginProjectPreparers(root, config, {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })

    expect(contexts).toHaveLength(2)
    expect(contexts[0]).toMatchObject({
      projectRoot: root,
      generatedRoot: join(root, '.holo-js/generated'),
      pluginGeneratedRoot: join(root, '.holo-js/generated/demo'),
      config,
      framework,
      plugin: {
        id: 'demo',
        name: 'Plugin demo',
        packageName: 'holo-demo',
        packageRoot: join(root, 'node_modules/holo-demo'),
      },
      run: { kind: 'full', command: 'build', reason: 'initial' },
    })
    expect(contexts[0]?.signal).toBeInstanceOf(AbortSignal)
    expect(contexts[1]).not.toHaveProperty('framework')
  })

  it('rejects retry-full from a full run and a second retry-full response', async () => {
    const fullRoot = await createProject()
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(fullRoot, 'full-retry', {
      apiVersion: 1,
      prepare: () => ({ kind: 'retry-full', reason: 'unexpected' }),
    })])

    await expect(runFull(fullRoot)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_INVALID_RESULT' },
    })

    const repeatedRoot = await createProject()
    let calls = 0
    let retry = false
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(repeatedRoot, 'repeated-retry', {
      apiVersion: 1,
      prepare: () => {
        calls += 1
        if (retry) return { kind: 'retry-full', reason: 'still stale' }
        return { kind: 'prepared', watch: { roots: ['server'] } }
      },
    })])
    await runFull(repeatedRoot)
    calls = 0
    retry = true

    await expect(runPluginProjectPreparers(repeatedRoot, normalizeHoloProjectConfig(), {
      run: {
        kind: 'incremental',
        command: 'dev',
        changes: [{ path: 'server/change.ts', kind: 'changed' }],
      },
    })).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_INVALID_RESULT' },
    })
    expect(calls).toBe(2)
  })

  it('renders diagnostics in deterministic code order with source and hint details', async () => {
    const root = await createProject()
    const output: string[] = []
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        diagnostics: [
          { severity: 'info', code: 'Z_LAST', message: 'Last diagnostic' },
          {
            severity: 'warning',
            code: 'A_FIRST',
            message: 'First diagnostic',
            source: { path: 'server/posts.ts', line: 7, column: 11 },
            hint: 'Fix the post definition',
          },
          { severity: 'warning', code: 'M_MIDDLE', message: 'Middle diagnostic' },
        ],
      }),
    })])

    await runFull(root, {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
      writeInfo: message => output.push(`info:${message}`),
      writeWarning: message => output.push(`warning:${message}`),
    })

    expect(output).toEqual([
      'warning:[demo] A_FIRST: server/posts.ts:7:11 First diagnostic\n  Hint: Fix the post definition',
      'warning:[demo] M_MIDDLE: Middle diagnostic',
      'info:[demo] Z_LAST: Last diagnostic',
    ])
  })

  it('enforces diagnostic and artifact count ceilings at their boundaries', async () => {
    const root = await createProject()
    let mode: 'diagnostics-exact' | 'diagnostics-over' | 'artifacts-exact' | 'artifacts-over' = 'diagnostics-exact'
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'limits', {
      apiVersion: 1,
      prepare: () => {
        const diagnosticCount = mode === 'diagnostics-exact' ? 200 : mode === 'diagnostics-over' ? 201 : 0
        const artifactCount = mode === 'artifacts-exact' ? 2_000 : mode === 'artifacts-over' ? 2_001 : 0
        return {
          kind: 'prepared',
          diagnostics: Array.from({ length: diagnosticCount }, (_, index) => ({
            severity: 'info' as const,
            code: `D_${index.toString().padStart(3, '0')}`,
            message: 'Diagnostic',
          })),
          generatedArtifacts: Array.from({ length: artifactCount }, (_, index) => ({
            path: `items/${index}.txt`,
            contents: '',
          })),
          watch: artifactCount === 2_000 ? { roots: ['invalid/../watch'] } : undefined,
        }
      },
    })])

    await expect(runFull(root)).resolves.toBeUndefined()
    mode = 'diagnostics-over'
    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED' },
    })
    mode = 'artifacts-exact'
    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_INVALID_PATH' },
    })
    mode = 'artifacts-over'
    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED' },
    })
  })

  it('enforces individual and total byte ceilings at their boundaries', async () => {
    const root = await createProject()
    const eightMegabytes = new Uint8Array(8 * 1024 * 1024)
    let mode: 'exact' | 'individual-over' | 'total-over' = 'exact'
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'byte-limits', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: mode === 'individual-over'
          ? [{ path: 'large.bin', contents: new Uint8Array(eightMegabytes.byteLength + 1) }]
          : [
              ...Array.from({ length: 8 }, (_, index) => ({
                path: `${index}.bin`,
                contents: eightMegabytes,
              })),
              ...(mode === 'total-over' ? [{ path: 'extra.bin', contents: new Uint8Array(1) }] : []),
            ],
        watch: mode === 'exact' ? { roots: ['invalid/../watch'] } : undefined,
      }),
    })])

    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_INVALID_PATH' },
    })
    mode = 'individual-over'
    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED' },
    })
    mode = 'total-over'
    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_LIMIT_EXCEEDED' },
    })
  })

  it('rejects generated-managed overlap within one snapshot', async () => {
    const overlapRoot = await createProject()
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(overlapRoot, 'overlap', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'shared.ts', contents: 'generated' }],
        managedArtifacts: [{ path: 'shared.ts', contents: 'managed' }],
      }),
    })])

    await expect(runFull(overlapRoot)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_DUPLICATE_ARTIFACT' },
    })
  })

  it('rejects artifact aliases on case-insensitive platforms', async () => {
    const root = await createProject()
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'aliases', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [
          { path: 'Reports.ts', contents: 'first' },
          { path: 'reports.ts', contents: 'second' },
        ],
      }),
    })])

    try {
      await expect(runFull(root)).rejects.toMatchObject({
        failure: { code: 'HOLO_PLUGIN_PREPARE_DUPLICATE_ARTIFACT' },
      })
      await expectMissing(join(root, '.holo-js/generated/aliases/Reports.ts'))
      await expectMissing(join(root, '.holo-js/generated/aliases/reports.ts'))
    } finally {
      platform.mockRestore()
    }
  })

  it('rejects cross-plugin generated namespace collisions', async () => {
    const collisionRoot = await createProject()
    mockedLoadPreparers.mockResolvedValue([
      loadedPreparer(collisionRoot, 'shared', {
        apiVersion: 1,
        prepare: () => ({
          kind: 'prepared',
          generatedArtifacts: [{ path: 'registry.ts', contents: 'first' }],
        }),
      }, 'first-package'),
      loadedPreparer(collisionRoot, 'shared', {
        apiVersion: 1,
        prepare: () => ({
          kind: 'prepared',
          generatedArtifacts: [{ path: 'registry.ts', contents: 'second' }],
        }),
      }, 'second-package'),
    ])

    await expect(runFull(collisionRoot)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT' },
    })
    await expectMissing(join(collisionRoot, '.holo-js/generated/shared/registry.ts'))
  })

  it('rejects cross-plugin managed claims before writing either snapshot', async () => {
    const root = await createProject()
    mockedLoadPreparers.mockResolvedValue([
      loadedPreparer(root, 'first', {
        apiVersion: 1,
        prepare: () => ({
          kind: 'prepared',
          generatedArtifacts: [{ path: 'first.ts', contents: 'first-generated' }],
          managedArtifacts: [{ path: 'app/shared.ts', contents: 'first' }],
        }),
      }),
      loadedPreparer(root, 'second', {
        apiVersion: 1,
        prepare: () => ({
          kind: 'prepared',
          managedArtifacts: [{ path: 'app/shared.ts', contents: 'second' }],
        }),
      }),
    ])

    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT' },
    })
    await expectMissing(join(root, 'app/shared.ts'))
    await expectMissing(join(root, '.holo-js/generated/first/first.ts'))
  })

  it('uses write-if-changed behavior and updates unchanged owned artifacts', async () => {
    const root = await createProject()
    let contents = 'version-one'
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'registry.ts', contents }],
        managedArtifacts: [{ path: 'app/route.ts', contents }],
      }),
    })])
    await runFull(root)

    const generatedPath = join(root, '.holo-js/generated/demo/registry.ts')
    const managedPath = join(root, 'app/route.ts')
    const fixedTime = new Date('2020-01-02T03:04:05.000Z')
    await utimes(generatedPath, fixedTime, fixedTime)
    await utimes(managedPath, fixedTime, fixedTime)

    await runFull(root)
    expect((await stat(generatedPath)).mtimeMs).toBe(fixedTime.getTime())
    expect((await stat(managedPath)).mtimeMs).toBe(fixedTime.getTime())

    contents = 'version-two'
    await runFull(root)
    expect(await readFile(generatedPath, 'utf8')).toBe('version-two')
    expect(await readFile(managedPath, 'utf8')).toBe('version-two')
    expect((await stat(generatedPath)).mtimeMs).toBeGreaterThan(fixedTime.getTime())
    expect((await stat(managedPath)).mtimeMs).toBeGreaterThan(fixedTime.getTime())
  })

  it('rejects identical unowned managed files and preserves modified stale files', async () => {
    const identicalRoot = await createProject()
    await mkdir(join(identicalRoot, 'app'), { recursive: true })
    await writeFile(join(identicalRoot, 'app/route.ts'), 'same')
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(identicalRoot, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        managedArtifacts: [{ path: 'app/route.ts', contents: 'same' }],
      }),
    })])
    await expect(runFull(identicalRoot)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT' },
    })
    expect(await readFile(join(identicalRoot, 'app/route.ts'), 'utf8')).toBe('same')

    const staleRoot = await createProject()
    let includeManaged = true
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(staleRoot, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        managedArtifacts: includeManaged ? [{ path: 'app/route.ts', contents: 'owned' }] : [],
      }),
    })])
    await runFull(staleRoot)
    await writeFile(join(staleRoot, 'app/route.ts'), 'user-modified')
    const manifestBefore = await readFile(join(staleRoot, '.holo-js/generated/.plugins/demo.json'), 'utf8')
    includeManaged = false

    await expect(runFull(staleRoot)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_MODIFIED_MANAGED_FILE' },
    })
    expect(await readFile(join(staleRoot, 'app/route.ts'), 'utf8')).toBe('user-modified')
    expect(await readFile(join(staleRoot, '.holo-js/generated/.plugins/demo.json'), 'utf8')).toBe(manifestBefore)
  })

  it('does not delete a newly claimed path retained by an inactive manifest', async () => {
    const root = await createProject()
    const inactive = loadedPreparer(root, 'inactive', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        managedArtifacts: [
          { path: 'app/modified.ts', contents: 'inactive' },
          { path: 'app/shared.ts', contents: 'inactive' },
        ],
      }),
    })
    mockedLoadPreparers.mockResolvedValue([inactive])
    await runFull(root)
    await writeFile(join(root, 'app/modified.ts'), 'application-owned')
    await rm(join(root, 'app/shared.ts'))

    const active = loadedPreparer(root, 'active', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        managedArtifacts: [{ path: 'app/shared.ts', contents: 'active' }],
      }),
    })
    mockedLoadPreparers.mockResolvedValue([active])

    await runFull(root)

    expect(await readFile(join(root, 'app/shared.ts'), 'utf8')).toBe('active')
    expect(await readFile(join(root, 'app/modified.ts'), 'utf8')).toBe('application-owned')
  })

  it('preserves prior artifacts and watch state when a later preparer fails', async () => {
    const root = await createProject()
    let failSecond = false
    let version = 'one'
    const first = loadedPreparer(root, 'first', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [
          { path: 'stable.ts', contents: version },
          ...(version === 'two' ? [{ path: 'new.ts', contents: 'new' }] : []),
        ],
        watch: { roots: [version === 'one' ? 'server/one' : 'server/two'] },
      }),
    })
    const second = loadedPreparer(root, 'second', {
      apiVersion: 1,
      prepare: () => {
        if (failSecond) throw new Error('second failed')
        return { kind: 'prepared', generatedArtifacts: [{ path: 'stable.ts', contents: 'second' }] }
      },
    })
    mockedLoadPreparers.mockResolvedValue([first, second])
    await runFull(root)
    const manifestPath = join(root, '.holo-js/generated/.plugins/first.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    version = 'two'
    failSecond = true

    await expect(runFull(root)).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_EXECUTION_FAILED' },
    })
    expect(await readFile(join(root, '.holo-js/generated/first/stable.ts'), 'utf8')).toBe('one')
    await expectMissing(join(root, '.holo-js/generated/first/new.ts'))
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
  })

  it('snapshots binary artifact contents before invoking later preparers', async () => {
    const root = await createProject()
    const contents = new Uint8Array([1, 2, 3])
    const first = loadedPreparer(root, 'first', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'registry.bin', contents }],
      }),
    })
    const second = loadedPreparer(root, 'second', {
      apiVersion: 1,
      prepare: () => {
        contents[0] = 9
        return { kind: 'prepared' }
      },
    })
    mockedLoadPreparers.mockResolvedValue([first, second])

    await runFull(root)

    expect(await readFile(join(root, '.holo-js/generated/first/registry.bin')))
      .toEqual(Buffer.from([1, 2, 3]))
    const manifest = JSON.parse(await readFile(
      join(root, '.holo-js/generated/.plugins/first.json'),
      'utf8',
    )) as { generatedArtifacts: Array<{ digest: string }> }
    expect(manifest.generatedArtifacts[0]?.digest)
      .toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81')
  })

  it('honors an aborted signal before committing artifacts or ownership', async () => {
    const root = await createProject()
    const controller = new AbortController()
    controller.abort()
    let receivedSignal: AbortSignal | undefined
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: (context) => {
        receivedSignal = context.signal
        return {
          kind: 'prepared',
          generatedArtifacts: [{ path: 'registry.ts', contents: 'registry' }],
          managedArtifacts: [{ path: 'app/route.ts', contents: 'route' }],
        }
      },
    })])

    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'dev', reason: 'initial' },
      signal: controller.signal,
    })).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_COMMIT_FAILED' },
    })
    expect(receivedSignal).toBe(controller.signal)
    await expectMissing(join(root, '.holo-js/generated/demo/registry.ts'))
    await expectMissing(join(root, '.holo-js/generated/.plugins/demo.json'))
    await expectMissing(join(root, 'app/route.ts'))
  })

  it('rolls back installed artifacts when preparation is aborted during commit', async () => {
    const root = await createProject()
    let version = 'one'
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'registry.ts', contents: version }],
        managedArtifacts: [{ path: 'app/route.ts', contents: version }],
      }),
    })])
    await runFull(root)
    const manifestPath = join(root, '.holo-js/generated/.plugins/demo.json')
    const manifestBefore = await readFile(manifestPath, 'utf8')
    version = 'two'
    let abortChecks = 0
    const signal = {
      throwIfAborted() {
        abortChecks += 1
        if (abortChecks === 4) throw new Error('aborted during commit')
      },
    } as AbortSignal

    await expect(runFull(root, {
      run: { kind: 'full', command: 'dev', reason: 'initial' },
      signal,
    })).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_COMMIT_FAILED' },
    })
    expect(await readFile(join(root, '.holo-js/generated/demo/registry.ts'), 'utf8')).toBe('one')
    expect(await readFile(join(root, 'app/route.ts'), 'utf8')).toBe('one')
    expect(await readFile(manifestPath, 'utf8')).toBe(manifestBefore)
  })

  it('leaves a clean project unchanged when no preparers are active', async () => {
    const root = await createProject()
    mockedLoadPreparers.mockResolvedValue([])

    await expect(runFull(root)).resolves.toBeUndefined()
    await expectMissing(join(root, '.holo-js/generated/.plugins'))
    expect(await readFile(join(root, 'package.json'), 'utf8')).toBe(JSON.stringify({ name: 'fixture' }))
  })
})
