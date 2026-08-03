import { mkdtemp, mkdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises'
import { hostname } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HoloProjectPrepareError, normalizeHoloProjectConfig, type HoloProjectPreparer } from '@holo-js/kernel'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { type LoadedProjectPreparer, loadProjectPluginPreparation } from '../src/project/plugins'
import { runPluginProjectPreparers } from '../src/project/plugin-prepare/coordinator'
import { assertManagedPathAllowed, normalizeArtifactPath } from '../src/project/plugin-prepare/paths'
import {
  renderAuthProviderRouteFiles,
  renderAuthRouteFiles,
  renderBroadcastAuthSupportFrameworkFiles,
  renderBroadcastInstallFrameworkFiles,
  renderFrameworkFiles,
  renderManagedHostedAuthRouteFiles,
} from '../src/project/scaffold/framework-renderers'

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

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-plugin-prepare-'))
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture' }))
  return root
}

function loadedPreparer(
  root: string,
  id: string,
  preparer: HoloProjectPreparer,
): LoadedProjectPreparer {
  return {
    plugin: {
      packageName: `holo-${id}`,
      packageRoot: join(root, 'node_modules', `holo-${id}`),
      entryPath: join(root, 'node_modules', `holo-${id}`, 'plugin.mjs'),
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

describe('plugin project preparation', () => {
  beforeEach(() => {
    mockedLoadPreparers.mockReset()
  })

  it('serializes concurrent preparation for the same project', async () => {
    const root = await createProject()
    let activePreparers = 0
    let maximumActivePreparers = 0
    let releaseFirst: () => void = () => undefined
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let firstEntered: () => void = () => undefined
    const firstStarted = new Promise<void>((resolve) => {
      firstEntered = resolve
    })
    let calls = 0
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      async prepare() {
        calls += 1
        const call = calls
        activePreparers += 1
        maximumActivePreparers = Math.max(maximumActivePreparers, activePreparers)
        if (call === 1) {
          firstEntered()
          await firstBlocked
        }
        activePreparers -= 1
        return {
          kind: 'prepared',
          generatedArtifacts: [{ path: 'registry.json', contents: `v${call}` }],
        }
      },
    })])
    const options = {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    } as const

    const first = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
    await firstStarted
    const second = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), options)
    await new Promise(resolve => setTimeout(resolve, 20))
    releaseFirst()
    await Promise.all([first, second])

    expect(maximumActivePreparers).toBe(1)
    expect(await readFile(join(root, '.holo-js/generated/demo/registry.json'), 'utf8')).toBe('v2')
  })

  it('reclaims preparation locks owned by a terminated local process', async () => {
    const root = await createProject()
    const lockPath = join(root, '.holo-js/project-prepare.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      host: hostname(),
      pid: 999_999,
      token: 'terminated-owner',
    }))
    mockedLoadPreparers.mockResolvedValue([])

    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })

    await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims a stale preparation lock after its owner PID is reused', async () => {
    const root = await createProject()
    const lockPath = join(root, '.holo-js/project-prepare.lock')
    const ownerPath = join(lockPath, 'owner.json')
    await mkdir(lockPath, { recursive: true })
    await writeFile(ownerPath, JSON.stringify({
      host: hostname(),
      pid: process.pid,
      token: 'reused-owner',
    }))
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(ownerPath, staleTime, staleTime)
    mockedLoadPreparers.mockResolvedValue([])
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 50)

    try {
      await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
        run: { kind: 'full', command: 'prepare', reason: 'explicit' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(abortTimer)
    }

    await expect(readFile(ownerPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reclaims stale preparation locks created on a previous host', async () => {
    const root = await createProject()
    const lockPath = join(root, '.holo-js/project-prepare.lock')
    await mkdir(lockPath, { recursive: true })
    await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
      host: `${hostname()}-previous`,
      pid: 1,
      token: 'previous-host-owner',
    }))
    const staleTime = new Date(Date.now() - 60_000)
    await utimes(lockPath, staleTime, staleTime)
    await utimes(join(lockPath, 'owner.json'), staleTime, staleTime)
    mockedLoadPreparers.mockResolvedValue([])
    const controller = new AbortController()
    const abortTimer = setTimeout(() => controller.abort(), 50)

    try {
      await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
        run: { kind: 'full', command: 'prepare', reason: 'explicit' },
        signal: controller.signal,
      })
    } finally {
      clearTimeout(abortTimer)
    }

    await expect(readFile(join(lockPath, 'owner.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('commits complete snapshots and tracks generated and managed ownership', async () => {
    const root = await createProject()
    let version = 1
    const preparer = loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'registry.json', contents: `v${version}` }],
        managedArtifacts: version === 1 ? [{ path: 'app/demo-route.ts', contents: 'route' }] : [],
        watch: { roots: ['server/demo'] },
      }),
    })
    mockedLoadPreparers.mockResolvedValue([preparer])

    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    expect(await readFile(join(root, '.holo-js/generated/demo/registry.json'), 'utf8')).toBe('v1')
    expect(await readFile(join(root, 'app/demo-route.ts'), 'utf8')).toBe('route')

    version = 2
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'build', reason: 'initial' },
    })
    expect(await readFile(join(root, '.holo-js/generated/demo/registry.json'), 'utf8')).toBe('v2')
    await expect(readFile(join(root, 'app/demo-route.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, '.holo-js/generated/.plugins/demo.json'), 'utf8')).toContain('server/demo')

    mockedLoadPreparers.mockResolvedValue([])
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'configuration-changed' },
    })
    await expect(readFile(join(root, '.holo-js/generated/demo/registry.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.holo-js/generated/.plugins/demo.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes unchanged generated and managed ownership after plugin deactivation', async () => {
    const root = await createProject()
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'registry.json', contents: 'generated' }],
        managedArtifacts: [{ path: 'app/demo-route.ts', contents: 'managed' }],
      }),
    })])

    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    expect(await readFile(join(root, '.holo-js/generated/demo/registry.json'), 'utf8')).toBe('generated')
    expect(await readFile(join(root, 'app/demo-route.ts'), 'utf8')).toBe('managed')

    mockedLoadPreparers.mockResolvedValue([])
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'configuration-changed' },
    })

    await expect(readFile(join(root, '.holo-js/generated/demo/registry.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, 'app/demo-route.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(root, '.holo-js/generated/.plugins/demo.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('preserves modified managed ownership after plugin deactivation', async () => {
    const root = await createProject()
    const warnings: string[] = []
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'registry.json', contents: 'generated' }],
        managedArtifacts: [{ path: 'app/demo-route.ts', contents: 'managed' }],
      }),
    })])

    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    await writeFile(join(root, 'app/demo-route.ts'), 'application change')

    mockedLoadPreparers.mockResolvedValue([])
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'configuration-changed' },
      writeWarning: message => warnings.push(message),
    })

    expect(await readFile(join(root, 'app/demo-route.ts'), 'utf8')).toBe('application change')
    await expect(readFile(join(root, '.holo-js/generated/demo/registry.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    const ownership = JSON.parse(await readFile(join(root, '.holo-js/generated/.plugins/demo.json'), 'utf8')) as {
      readonly managedArtifacts: readonly { readonly path: string }[]
    }
    expect(ownership.managedArtifacts).toEqual([expect.objectContaining({ path: 'app/demo-route.ts' })])
    expect(warnings).toEqual(['[demo] Preserved modified managed artifact after plugin deactivation: app/demo-route.ts'])
  })

  it('preserves unmanaged and user-modified managed files', async () => {
    const root = await createProject()
    await mkdir(join(root, 'app'), { recursive: true })
    await writeFile(join(root, 'app/existing.ts'), 'user')
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        managedArtifacts: [{ path: 'app/existing.ts', contents: 'plugin' }],
      }),
    })])

    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toThrow('already exists and is unowned')
    expect(await readFile(join(root, 'app/existing.ts'), 'utf8')).toBe('user')
  })

  it('rejects modified ownership, protected files, and duplicate artifacts without leaking contents', async () => {
    const root = await createProject()
    let mode: 'create' | 'update' | 'protected' | 'duplicate' = 'create'
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        managedArtifacts: mode === 'protected'
          ? [{ path: 'package.json', contents: 'secret-content' }]
          : [{ path: 'app/managed.ts', contents: mode === 'create' ? 'original' : 'replacement' }],
        generatedArtifacts: mode === 'duplicate'
          ? [{ path: 'same.ts', contents: 'one' }, { path: 'same.ts', contents: 'two' }]
          : [],
      }),
    })])
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    await writeFile(join(root, 'app/managed.ts'), 'application-change')

    mode = 'update'
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toThrow('modified by the application')
    expect(await readFile(join(root, 'app/managed.ts'), 'utf8')).toBe('application-change')

    mode = 'protected'
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.not.toThrow('secret-content')

    mode = 'duplicate'
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toThrow('Duplicate artifact path')
  })

  it('runs preparers in order, validates the full batch, and honors one full retry', async () => {
    const root = await createProject()
    const calls: string[] = []
    let firstRun = true
    let firstContents = 'first'
    const first = loadedPreparer(root, 'first', {
      apiVersion: 1,
      prepare: (context) => {
        calls.push(`first:${context.run.kind}`)
        if (context.run.kind === 'incremental' && firstRun) {
          firstRun = false
          return { kind: 'retry-full', reason: 'graph changed' }
        }
        return { kind: 'prepared', generatedArtifacts: [{ path: 'first.txt', contents: firstContents }] }
      },
    })
    const second = loadedPreparer(root, 'second', {
      apiVersion: 1,
      prepare: (context) => {
        calls.push(`second:${context.run.kind}`)
        throw new Error('broken snapshot')
      },
    })
    mockedLoadPreparers.mockResolvedValue([first])
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'dev', reason: 'initial' },
    })
    calls.length = 0
    mockedLoadPreparers.mockResolvedValue([first, second])
    firstContents = 'changed-before-failure'

    const failure = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'incremental', command: 'dev', changes: [{ path: 'server/demo.ts', kind: 'changed' }] },
    })
    await expect(failure).rejects.toThrow('The project preparer threw an unstructured error')
    await expect(failure).rejects.not.toThrow('broken snapshot')
    expect(calls).toEqual(['first:incremental', 'first:full', 'second:full'])
    expect(await readFile(join(root, '.holo-js/generated/first/first.txt'), 'utf8')).toBe('first')
  })

  it('rejects malformed and mismatched ownership manifests before using their paths', async () => {
    const root = await createProject()
    const preparer = loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({ kind: 'prepared' }),
    })
    mockedLoadPreparers.mockResolvedValue([preparer])
    const manifestRoot = join(root, '.holo-js/generated/.plugins')
    await mkdir(manifestRoot, { recursive: true })
    await writeFile(join(manifestRoot, 'demo.json'), JSON.stringify({
      version: 1,
      pluginId: 'other',
      packageName: 'holo-demo',
      apiVersion: 1,
      generatedArtifacts: [],
      managedArtifacts: [{ path: '../../package.json', digest: 'a'.repeat(64) }],
      watch: { roots: [] },
    }))

    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toMatchObject({ failure: { code: 'HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT' } })
    expect(await readFile(join(root, 'package.json'), 'utf8')).toContain('fixture')
  })

  it('validates nested result, watch, and diagnostic shapes at the host boundary', async () => {
    const root = await createProject()
    const invalidResults: unknown[] = [
      { kind: 'prepared', generatedArtifacts: 'bad' },
      { kind: 'prepared', generatedArtifacts: [null] },
      { kind: 'prepared', watch: { roots: 'server' } },
      { kind: 'prepared', diagnostics: [{ severity: 'warning', code: 'WARN', message: 'warning', source: { path: 'server/file.ts', line: 0 } }] },
      { kind: 'retry-full', reason: '' },
    ]
    for (const result of invalidResults) {
      mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
        apiVersion: 1,
        prepare: () => result as never,
      })])
      await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
        run: { kind: 'incremental', command: 'dev', changes: [] },
      })).rejects.toMatchObject({ failure: { code: 'HOLO_PLUGIN_PREPARE_INVALID_RESULT' } })
    }
  })

  it('attributes structured plugin failures and renders diagnostic locations and hints', async () => {
    const root = await createProject()
    const warnings: string[] = []
    let fails = true
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => {
        if (fails) {
          throw new HoloProjectPrepareError({ code: 'PLUGIN_FAILURE', message: 'broken input', source: { path: 'server/demo.ts', line: 4, column: 2 }, hint: 'Fix it' })
        }
        return {
          kind: 'prepared',
          diagnostics: [{ severity: 'warning', code: 'PLUGIN_WARNING', message: 'check input', source: { path: 'server/demo.ts', line: 4, column: 2 }, hint: 'Review it' }],
        }
      },
    })])
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toMatchObject({
      failure: {
        code: 'PLUGIN_FAILURE',
        source: { path: 'server/demo.ts', line: 4, column: 2 },
        hint: 'Fix it',
      },
      message: expect.stringContaining('Plugin demo (holo-demo) project.prepare ./prepare.mjs: broken input'),
    })

    fails = false
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
      writeWarning: message => warnings.push(message),
    })
    expect(warnings).toEqual(['[demo] PLUGIN_WARNING: server/demo.ts:4:2 check input\n  Hint: Review it'])
  })

  it('redacts arbitrary preparer error messages while retaining plugin attribution', async () => {
    const root = await createProject()
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => {
        throw new Error('database-password=secret-value')
      },
    })])

    const failure = runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    await expect(failure).rejects.toMatchObject({
      failure: { code: 'HOLO_PLUGIN_PREPARE_EXECUTION_FAILED' },
      message: expect.stringContaining('Plugin demo (holo-demo) project.prepare ./prepare.mjs'),
    })
    await expect(failure).rejects.not.toThrow('secret-value')
  })

  it('rejects stale symlinks and managed paths inside linked plugin roots', async () => {
    const root = await createProject()
    let includeGenerated = true
    const preparer = loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: includeGenerated ? [{ path: 'stale.ts', contents: 'generated' }] : [],
      }),
    })
    mockedLoadPreparers.mockResolvedValue([preparer])
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    await writeFile(join(root, 'outside.ts'), 'outside')
    await writeFile(join(root, '.holo-js/generated/demo/stale.ts'), '')
    await symlink(join(root, 'outside.ts'), join(root, '.holo-js/generated/demo/stale-link.ts'))
    const manifestPath = join(root, '.holo-js/generated/.plugins/demo.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { generatedArtifacts: Array<{ path: string, digest: string }> }
    manifest.generatedArtifacts.push({ path: 'stale-link.ts', digest: 'a'.repeat(64) })
    await writeFile(manifestPath, JSON.stringify(manifest))
    includeGenerated = false
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toThrow('must not be a symbolic link')
    expect(await readFile(join(root, 'outside.ts'), 'utf8')).toBe('outside')

    const nestedPackageRoot = join(root, 'packages/demo-plugin')
    await mkdir(nestedPackageRoot, { recursive: true })
    const protectedPreparer = { ...loadedPreparer(root, 'protected', {
      apiVersion: 1,
      prepare: () => ({ kind: 'prepared', managedArtifacts: [{ path: 'packages/demo-plugin/route.ts', contents: 'route' }] }),
    }), plugin: { ...loadedPreparer(root, 'protected', { apiVersion: 1, prepare: () => ({ kind: 'prepared' }) }).plugin, packageRoot: nestedPackageRoot } }
    mockedLoadPreparers.mockResolvedValue([protectedPreparer])
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toMatchObject({ failure: { code: 'HOLO_PLUGIN_PREPARE_PROTECTED_PATH' } })
  })

  it('cleans abandoned staged files and reconciles an interrupted managed update', async () => {
    const root = await createProject()
    let contents = 'v1'
    mockedLoadPreparers.mockResolvedValue([loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({ kind: 'prepared', managedArtifacts: [{ path: 'app/route.ts', contents }] }),
    })])
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    const abandoned = join(root, 'app/route.ts.holo-123-123e4567-e89b-12d3-a456-426614174000.tmp')
    await writeFile(abandoned, 'abandoned')
    contents = 'v2'
    await writeFile(join(root, 'app/route.ts'), contents)
    await runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })
    await expect(readFile(abandoned, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(root, 'app/route.ts'), 'utf8')).toBe('v2')
    expect(await readFile(join(root, '.holo-js/generated/.plugins/demo.json'), 'utf8')).not.toContain('v1')
  })

  it('rejects generated-managed overlap and duplicate active plugin IDs before mutation', async () => {
    const root = await createProject()
    const duplicatePath = loadedPreparer(root, 'demo', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        generatedArtifacts: [{ path: 'same.ts', contents: 'generated' }],
        managedArtifacts: [{ path: 'same.ts', contents: 'managed' }],
      }),
    })
    mockedLoadPreparers.mockResolvedValue([duplicatePath])
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toMatchObject({ failure: { code: 'HOLO_PLUGIN_PREPARE_DUPLICATE_ARTIFACT' } })
    await expect(readFile(join(root, 'same.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const first = loadedPreparer(root, 'duplicate', {
      apiVersion: 1,
      prepare: () => ({ kind: 'prepared', generatedArtifacts: [{ path: 'first.ts', contents: 'first' }] }),
    })
    const second = loadedPreparer(root, 'duplicate', {
      apiVersion: 1,
      prepare: () => ({ kind: 'prepared', generatedArtifacts: [{ path: 'second.ts', contents: 'second' }] }),
    })
    mockedLoadPreparers.mockResolvedValue([first, second])
    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toMatchObject({ failure: { code: 'HOLO_PLUGIN_PREPARE_OWNERSHIP_CONFLICT' } })
    await expect(readFile(join(root, '.holo-js/generated/duplicate/first.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('protects the package root of an active plugin without a project preparer', async () => {
    const root = await createProject()
    const packageRoot = join(root, 'packages/passive-plugin')
    await mkdir(packageRoot, { recursive: true })
    const attacker = loadedPreparer(root, 'attacker', {
      apiVersion: 1,
      prepare: () => ({
        kind: 'prepared',
        managedArtifacts: [{ path: 'packages/passive-plugin/runtime.mjs', contents: 'replaced' }],
      }),
    })
    mockedLoadPreparation.mockResolvedValue({
      activePlugins: [
        attacker.plugin,
        {
          packageName: 'passive-plugin',
          packageRoot,
          entryPath: join(packageRoot, 'plugin.mjs'),
          definition: { id: 'passive-plugin', name: 'Passive Plugin' },
        },
      ],
      preparers: [attacker],
    })

    await expect(runPluginProjectPreparers(root, normalizeHoloProjectConfig(), {
      run: { kind: 'full', command: 'prepare', reason: 'explicit' },
    })).rejects.toMatchObject({
      failure: {
        code: 'HOLO_PLUGIN_PREPARE_PROTECTED_PATH',
        message: expect.stringContaining('passive-plugin'),
      },
    })
    await expect(readFile(join(packageRoot, 'runtime.mjs'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects unsafe and duplicate artifact paths', () => {
    for (const path of ['', '/tmp/file', 'C:/file', 'a\\b', 'a/../b', 'a/./b', 'a//b', 'a\0b']) {
      expect(() => normalizeArtifactPath(path)).toThrow()
    }
    expect(normalizeArtifactPath('safe/file.ts')).toBe('safe/file.ts')
    expect(normalizeArtifactPath('.', true)).toBe('.')
  })

  it('reserves exact Holo and framework scaffold files from plugin ownership', () => {
    const frameworks = ['nuxt', 'next', 'sveltekit'] as const
    const scaffoldPaths = frameworks.flatMap(framework => [
      ...renderFrameworkFiles({
        projectName: 'fixture',
        framework,
        databaseDriver: 'sqlite',
        packageManager: 'bun',
        storageDefaultDisk: 'local',
        optionalPackages: [
          'storage',
          'events',
          'queue',
          'validation',
          'forms',
          'auth',
          'authorization',
          'notifications',
          'mail',
          'broadcast',
          'realtime',
          'security',
          'cache',
        ],
      }),
      ...renderAuthProviderRouteFiles(framework, { clerk: true, workos: true }),
      ...renderAuthRouteFiles(framework),
      ...renderManagedHostedAuthRouteFiles(framework, { clerk: true, workos: true }),
      ...renderBroadcastInstallFrameworkFiles(framework),
      ...renderBroadcastAuthSupportFrameworkFiles(framework),
    ].map(file => file.path))
    expect(scaffoldPaths).toContain('app/broadcasting/auth/route.ts')

    for (const path of new Set([
      '.gitignore',
      '.ENV.local',
      '.vscode/settings.json',
      'Config/plugin.ts',
      'Node_Modules/example/index.js',
      'eslint.config.mjs',
      'tsconfig.json',
      ...scaffoldPaths,
    ])) {
      expect(() => assertManagedPathAllowed(path, []))
        .toThrow(`Protected managed project artifact path: ${path}.`)
    }

    for (const path of [
      'app/api/audit/route.ts',
      'server/api/audit.get.ts',
      'src/routes/admin/+page.svelte',
    ]) {
      expect(() => assertManagedPathAllowed(path, [])).not.toThrow()
    }
  })
})
