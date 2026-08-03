import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { runCli } from '../src/cli'
import type { IoStreams } from '../src/cli-types'
import { runProjectPrepare } from '../src/dev'
import {
  loadProjectPluginPreparation,
  loadProjectPluginMigrations,
  loadProjectPluginMigrationPublishers,
  loadProjectPluginPreparers,
  normalizeHoloPluginDefinition,
} from '../src/project/plugins'

const repositoryRoot = resolve(import.meta.dirname, '../../..')

function createIo(projectRoot: string): { readonly io: IoStreams, readonly stderr: PassThrough } {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream
  const stderr = new PassThrough()
  return {
    io: {
      cwd: projectRoot,
      stdin,
      stdout,
      stderr: stderr as unknown as NodeJS.WriteStream,
    },
    stderr,
  }
}

describe('project preparer loading', () => {
  it('resolves package-relative plugin migration publishers in configured order', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-plugin-migrations-'))
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
      await mkdir(join(root, 'config'), { recursive: true })
      await writeFile(join(root, 'config/app.mjs'), `export default { plugins: ['first-migrations', 'second-migrations'] }`)

      for (const [index, packageName] of ['first-migrations', 'second-migrations'].entries()) {
        const packageRoot = join(root, 'node_modules', packageName)
        await mkdir(packageRoot, { recursive: true })
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
          name: packageName,
          type: 'module',
          holo: { plugin: './plugin.mjs' },
        }))
        await writeFile(join(packageRoot, 'plugin.mjs'), `export default { id: '${packageName}', contributes: { migrations: { publish: './migrations.mjs' } } }`)
        await writeFile(join(packageRoot, 'migrations.mjs'), `export const migrations = [{ name: '2026_07_28_00000${index + 1}_${packageName.replaceAll('-', '_')}', up() {} }]`)
      }

      const publishers = await loadProjectPluginMigrationPublishers(root)
      expect(publishers.map(publisher => publisher.packageName)).toEqual(['first-migrations', 'second-migrations'])
      expect(publishers.map(publisher => publisher.specifier)).toEqual(['./migrations.mjs', './migrations.mjs'])
      await expect(loadProjectPluginMigrations(root)).resolves.toMatchObject([
        { name: '2026_07_28_000001_first_migrations' },
        { name: '2026_07_28_000002_second_migrations' },
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves a bare project preparer specifier from the application', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-preparer-application-resolution-'))

    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
      await mkdir(join(root, 'config'), { recursive: true })
      await writeFile(join(root, 'config/app.mjs'), `export default { plugins: ['bare-preparer-plugin'] }`)

      const pluginRoot = join(root, 'node_modules/bare-preparer-plugin')
      await mkdir(pluginRoot, { recursive: true })
      await writeFile(join(pluginRoot, 'package.json'), JSON.stringify({
        name: 'bare-preparer-plugin',
        type: 'module',
        holo: { plugin: './plugin.mjs' },
      }))
      await writeFile(join(pluginRoot, 'plugin.mjs'), `export default { id: 'bare-preparer', contributes: { project: { prepare: 'application-preparer' } } }`)

      const preparerRoot = join(root, 'node_modules/application-preparer')
      await mkdir(preparerRoot, { recursive: true })
      await writeFile(join(preparerRoot, 'package.json'), JSON.stringify({
        name: 'application-preparer',
        type: 'module',
        exports: './index.mjs',
      }))
      await writeFile(join(preparerRoot, 'index.mjs'), `export default { apiVersion: 1, prepare() { return { kind: 'prepared', generatedArtifacts: [{ path: 'application.txt', contents: 'resolved' }] } } }`)

      const [loaded] = await loadProjectPluginPreparers(root)
      expect(loaded?.specifier).toBe('application-preparer')
      expect(await loaded?.preparer.prepare({} as never)).toMatchObject({
        generatedArtifacts: [{ path: 'application.txt', contents: 'resolved' }],
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('loads preparation modules in configured plugin order with versioned exports', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-preparer-loader-'))
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
    await mkdir(join(root, 'config'), { recursive: true })
    await writeFile(join(root, 'config/app.mjs'), `export default { plugins: ['first-plugin', 'second-plugin'] }`)

    for (const [packageName, id, exportName] of [
      ['first-plugin', 'first', 'default'],
      ['second-plugin', 'second', 'preparer'],
    ] as const) {
      const packageRoot = join(root, 'node_modules', packageName)
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: packageName,
        type: 'module',
        holo: { plugin: './plugin.mjs' },
      }))
      await writeFile(join(packageRoot, 'plugin.mjs'), `export default { id: '${id}', contributes: { project: { prepare: './prepare.mjs' } } }`)
      await writeFile(join(packageRoot, 'prepare.mjs'), `${exportName === 'default' ? 'export default' : 'export const preparer ='} { apiVersion: 1, prepare() { return { kind: 'prepared' } } }`)
    }

    const preparers = await loadProjectPluginPreparers(root)
    expect(preparers.map(preparer => preparer.plugin.definition.id)).toEqual(['first', 'second'])
    expect(await preparers[0]?.preparer.prepare({} as never)).toEqual({ kind: 'prepared' })

    await writeFile(join(root, 'node_modules/first-plugin/prepare.mjs'), `export default { apiVersion: 1, prepare() { return { kind: 'prepared', generatedArtifacts: [{ path: 'new.txt', contents: 'new' }] } } }`)
    const reloaded = await loadProjectPluginPreparers(root)
    expect(await reloaded[0]?.preparer.prepare({} as never)).toMatchObject({
      generatedArtifacts: [{ path: 'new.txt' }],
    })

    await writeFile(join(root, 'node_modules/first-plugin/prepare.mjs'), `export default { apiVersion: 2, prepare() { return { kind: 'prepared' } } }`)
    await expect(loadProjectPluginPreparers(root)).rejects.toMatchObject({
      failure: {
        code: 'HOLO_PLUGIN_PREPARE_VERSION_MISMATCH',
        message: expect.stringContaining('expected apiVersion 1, received 2'),
      },
    })

    await writeFile(join(root, 'node_modules/first-plugin/prepare.mjs'), `export default { apiVersion: 1 }`)
    await expect(loadProjectPluginPreparers(root)).rejects.toMatchObject({
      failure: {
        code: 'HOLO_PLUGIN_PREPARE_INVALID_EXPORT',
        message: expect.stringContaining('prepare() method'),
      },
    })

    await writeFile(join(root, 'node_modules/first-plugin/prepare.mjs'), `export default { prepare() { return { kind: 'prepared' } } }`)
    await expect(loadProjectPluginPreparers(root)).rejects.toMatchObject({
      failure: {
        code: 'HOLO_PLUGIN_PREPARE_VERSION_MISMATCH',
        message: expect.stringContaining('received missing'),
      },
    })
  })

  it('retains active plugin package roots when a plugin has no project preparer', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-preparer-active-roots-'))
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
      await mkdir(join(root, 'config'), { recursive: true })
      await writeFile(join(root, 'config/app.mjs'), `export default { plugins: ['active-plugin', 'preparer-plugin'] }`)

      for (const [packageName, pluginSource] of [
        ['active-plugin', `export default { id: 'active' }`],
        ['preparer-plugin', `export default { id: 'preparer', contributes: { project: { prepare: './prepare.mjs' } } }`],
      ] as const) {
        const packageRoot = join(root, 'node_modules', packageName)
        await mkdir(packageRoot, { recursive: true })
        await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
          name: packageName,
          type: 'module',
          holo: { plugin: './plugin.mjs' },
        }))
        await writeFile(join(packageRoot, 'plugin.mjs'), pluginSource)
      }
      await writeFile(join(root, 'node_modules/preparer-plugin/prepare.mjs'), `export default { apiVersion: 1, prepare() { return { kind: 'prepared' } } }`)

      const preparation = await loadProjectPluginPreparation(root)

      expect(preparation.activePlugins.map(plugin => plugin.packageName)).toEqual(['active-plugin', 'preparer-plugin'])
      expect(preparation.preparers.map(preparer => preparer.plugin.packageName)).toEqual(['preparer-plugin'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('rejects malformed explicit project contribution shapes', () => {
    expect(() => normalizeHoloPluginDefinition({ id: 'bad', contributes: { project: false } })).toThrow('must be an object')
    expect(() => normalizeHoloPluginDefinition({ id: 'bad', contributes: { project: { prepare: '' } } })).toThrow('must be a non-empty string')
  })

  it('makes plugin doctor validate project preparer modules with plugin attribution', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-preparer-doctor-'))
    try {
      await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module' }))
      await mkdir(join(root, 'config'), { recursive: true })
      await writeFile(join(root, 'config/app.mjs'), `export default { plugins: ['broken-plugin'] }`)
      const packageRoot = join(root, 'node_modules/broken-plugin')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'broken-plugin',
        type: 'module',
        holo: { plugin: './plugin.mjs' },
      }))
      await writeFile(join(packageRoot, 'plugin.mjs'), `export default { id: 'broken', name: 'Broken Plugin', contributes: { project: { prepare: './prepare.mjs' } } }`)
      await writeFile(join(packageRoot, 'prepare.mjs'), `export default { apiVersion: 2, prepare() { return { kind: 'prepared' } } }`)
      const { io, stderr } = createIo(root)

      await expect(runCli(['plugin:doctor'], io)).resolves.toBe(1)
      expect(stderr.read()?.toString()).toContain('Broken Plugin (broken-plugin) project.prepare ./prepare.mjs')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('re-detects the framework before the dependency-change preparer rerun', async () => {
    const root = await mkdtemp(join(tmpdir(), 'holo-preparer-dependencies-'))
    const fakeBinRoot = await mkdtemp(join(tmpdir(), 'holo-preparer-bin-'))
    const originalPath = process.env.PATH
    try {
      await mkdir(join(root, 'config'), { recursive: true })
      await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
      await symlink(join(repositoryRoot, 'packages/db'), join(root, 'node_modules/@holo-js/db'), 'dir')
      await writeFile(join(root, 'package.json'), `${JSON.stringify({
        name: 'fixture',
        private: true,
        type: 'module',
        packageManager: 'npm@10.0.0',
        dependencies: {
          '@holo-js/db': '^0.3.8',
          '@holo-js/db-sqlite': '^0.3.8',
        },
      }, null, 2)}\n`)
      await writeFile(join(root, 'config/app.mjs'), `export default { plugins: ['framework-probe'] }`)
      await writeFile(join(root, 'config/database.mjs'), `
import { defineDatabaseConfig } from '@holo-js/db'
export default defineDatabaseConfig({ connections: { default: { driver: 'postgres', url: 'postgres://localhost/app' } } })
`)
      const packageRoot = join(root, 'node_modules/framework-probe')
      await mkdir(packageRoot, { recursive: true })
      await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
        name: 'framework-probe',
        type: 'module',
        holo: { plugin: './plugin.mjs' },
      }))
      await writeFile(join(packageRoot, 'plugin.mjs'), `export default { id: 'framework-probe', contributes: { project: { prepare: './prepare.mjs' } } }`)
      await writeFile(join(packageRoot, 'prepare.mjs'), `export default {
  apiVersion: 1,
  prepare(context) {
    return {
      kind: 'prepared',
      generatedArtifacts: [{
        path: 'context.json',
        contents: JSON.stringify({ framework: context.framework?.id ?? null, reason: context.run.reason ?? null }),
      }],
    }
  },
}`)
      const npmPath = join(fakeBinRoot, 'npm')
      await writeFile(npmPath, `#!/bin/sh
node -e "const fs=require('node:fs');const path='package.json';const value=JSON.parse(fs.readFileSync(path,'utf8'));value.dependencies.next='^16.0.0';fs.writeFileSync(path,JSON.stringify(value,null,2)+'\\n')"
`)
      await chmod(npmPath, 0o755)
      process.env.PATH = `${fakeBinRoot}:${originalPath ?? ''}`
      const { io } = createIo(root)

      await runProjectPrepare(root, io, { syncFramework: false })

      const context = JSON.parse(await readFile(join(root, '.holo-js/generated/framework-probe/context.json'), 'utf8')) as {
        framework: string | null
        reason: string | null
      }
      expect(context).toEqual({ framework: 'next', reason: 'dependencies-changed' })
    } finally {
      process.env.PATH = originalPath
      await Promise.all([
        rm(root, { recursive: true, force: true }),
        rm(fakeBinRoot, { recursive: true, force: true }),
      ])
    }
  }, 30_000)
})
