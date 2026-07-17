import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  defineHoloPlugin,
  loadHoloPluginBootModules,
  loadHoloPluginContributionModules,
  loadHoloPluginDefinitions,
  resolveHoloPluginModulePath,
} from '../src'

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-kernel-'))
  await writeFile(join(root, 'package.json'), '{"type":"module"}')
  return root
}

async function createPlugin(
  root: string,
  packageName: string,
  definition: string,
  entry = './plugin.mjs',
): Promise<void> {
  const packageRoot = join(root, 'node_modules', ...packageName.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
    name: packageName,
    type: 'module',
    holo: { plugin: entry },
  }))
  await writeFile(join(packageRoot, 'plugin.mjs'), `export default ${definition}`)
  await writeFile(join(packageRoot, 'boot.mjs'), 'export default { boot: true }')
  await writeFile(join(packageRoot, 'driver.mjs'), 'export default { driver: true }')
}

async function createManifest(root: string, packageName: string, manifest: unknown): Promise<string> {
  const packageRoot = join(root, 'node_modules', ...packageName.split('/'))
  await mkdir(packageRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify(manifest))
  return packageRoot
}

describe('plugin kernel', () => {
  it('loads plugin definitions, contributions, and boot modules', async () => {
    const root = await createProject()
    await createPlugin(root, 'holo-demo', `({
      id: 'demo',
      contributes: {
        runtime: { boot: './boot.mjs' },
        queue: { drivers: { demo: { runtime: './driver.mjs' } } }
      }
    })`)
    const options = { moduleVersion: 'test version' }
    const plugins = await loadHoloPluginDefinitions(root, ['holo-demo'], options)
    const drivers = await loadHoloPluginContributionModules(root, plugins, 'queue', 'drivers', options)
    const boot = await loadHoloPluginBootModules(root, plugins, options)

    expect(plugins[0]?.definition.id).toBe('demo')
    expect(drivers[0]).toMatchObject({ name: 'demo', runtime: './driver.mjs', module: { default: { driver: true } } })
    expect(boot[0]).toMatchObject({ name: 'boot', runtime: './boot.mjs', module: { default: { boot: true } } })
    expect(resolveHoloPluginModulePath(root, plugins[0]!, './driver.mjs')).toContain('holo-demo/driver.mjs')
  })

  it('loads asynchronous ESM plugin entries and contribution modules', async () => {
    const root = await createProject()
    const packageRoot = await createManifest(root, 'async-plugin', {
      name: 'async-plugin',
      type: 'module',
      holo: { plugin: './plugin.mjs' },
    })
    await writeFile(join(packageRoot, 'plugin.mjs'), [
      'await Promise.resolve()',
      'export default {',
      "  id: 'async-plugin',",
      "  contributes: { cache: { drivers: { async: { runtime: './driver.mjs' } } } },",
      '}',
    ].join('\n'))
    await writeFile(join(packageRoot, 'driver.mjs'), [
      'const ready = await Promise.resolve(true)',
      "export default { name: 'async', ready }",
    ].join('\n'))

    const plugins = await loadHoloPluginDefinitions(root, ['async-plugin'])
    const drivers = await loadHoloPluginContributionModules(root, plugins, 'cache', 'drivers')

    expect(drivers).toMatchObject([{
      name: 'async',
      module: { default: { name: 'async', ready: true } },
    }])
  })

  it('rejects unsafe and conflicting plugin declarations', async () => {
    const root = await createProject()
    await expect(loadHoloPluginDefinitions(root, ['../invalid'])).rejects.toThrow('Invalid plugin package name')
    await createPlugin(root, 'first', `({ id: 'duplicate' })`)
    await createPlugin(root, 'second', `({ id: 'duplicate' })`)
    await expect(loadHoloPluginDefinitions(root, ['first', 'second'])).rejects.toThrow('Duplicate plugin id')

    await createPlugin(root, 'outside', `({ id: 'outside' })`, '../plugin.mjs')
    await expect(loadHoloPluginDefinitions(root, ['outside'])).rejects.toThrow('entry must stay inside')

    await expect(loadHoloPluginDefinitions(root, ['missing'])).rejects.toThrow("Cannot find module 'missing/package.json'")
    await createManifest(root, 'no-holo', { name: 'no-holo' })
    await expect(loadHoloPluginDefinitions(root, ['no-holo'])).rejects.toThrow('does not declare holo.plugin')
    await createManifest(root, 'blank-entry', { holo: { plugin: ' ' } })
    await expect(loadHoloPluginDefinitions(root, ['blank-entry'])).rejects.toThrow('does not declare holo.plugin')
    await createManifest(root, 'absolute-entry', { holo: { plugin: '/tmp/plugin.mjs' } })
    await expect(loadHoloPluginDefinitions(root, ['absolute-entry'])).rejects.toThrow('absolute module path')

    const invalidRoot = await createManifest(root, 'invalid-export', { holo: { plugin: './plugin.mjs' } })
    await writeFile(join(invalidRoot, 'plugin.mjs'), 'export default false')
    await expect(loadHoloPluginDefinitions(root, ['invalid-export'])).rejects.toThrow('with an id')

    const namedRoot = await createManifest(root, 'named-export', { holo: { plugin: './plugin.mjs' } })
    await writeFile(join(namedRoot, 'plugin.mjs'), `export const plugin = { id: 'named' }`)
    await expect(loadHoloPluginDefinitions(root, ['named-export'])).resolves.toMatchObject([{ definition: { id: 'named' } }])

    const directRoot = await createManifest(root, 'direct-export', { holo: { plugin: './plugin.mjs' } })
    await writeFile(join(directRoot, 'plugin.mjs'), `export const id = 'direct'`)
    await expect(loadHoloPluginDefinitions(root, ['direct-export'])).resolves.toMatchObject([{ definition: { id: 'direct' } }])

    const malformedRoot = await createManifest(root, 'malformed-manifest', { holo: { plugin: './plugin.mjs' } })
    await writeFile(join(malformedRoot, 'package.json'), '{')
    await expect(loadHoloPluginDefinitions(root, ['malformed-manifest'])).rejects.toBeInstanceOf(SyntaxError)
  })

  it('rejects duplicate contribution names and invalid module paths', async () => {
    const root = await createProject()
    const definition = `(name => ({ id: name, contributes: { queue: { drivers: { shared: { runtime: './driver.mjs' } } } } }))`
    await createPlugin(root, 'first', `${definition}('first')`)
    await createPlugin(root, 'second', `${definition}('second')`)
    const plugins = await loadHoloPluginDefinitions(root, ['first', 'second'])
    await expect(loadHoloPluginContributionModules(root, plugins, 'queue', 'drivers')).rejects.toThrow('Duplicate queue.drivers')
    expect(() => resolveHoloPluginModulePath(root, plugins[0]!, '')).toThrow('empty module specifier')
    expect(() => resolveHoloPluginModulePath(root, plugins[0]!, '/tmp/module.mjs')).toThrow('absolute module path')
    expect(() => resolveHoloPluginModulePath(root, plugins[0]!, '../module.mjs')).toThrow('must stay inside')
    expect(resolveHoloPluginModulePath(root, plugins[0]!, 'first/driver.mjs')).toContain('first/driver.mjs')

    const noContributions = [{ ...plugins[0]!, definition: { id: 'empty' } }]
    await expect(loadHoloPluginContributionModules(root, noContributions, 'queue', 'drivers')).resolves.toEqual([])
    await expect(loadHoloPluginBootModules(root, noContributions)).resolves.toEqual([])

    const invalidContributions = [{
      ...plugins[0]!,
      definition: {
        id: 'invalid',
        contributes: {
          queue: { drivers: { ignored: false, blank: { runtime: ' ' } } },
          runtime: false,
        },
      },
    }] as unknown as Parameters<typeof loadHoloPluginContributionModules>[1]
    await expect(loadHoloPluginContributionModules(root, invalidContributions, 'queue', 'drivers')).resolves.toEqual([])
    await expect(loadHoloPluginBootModules(root, invalidContributions)).resolves.toEqual([])
  })

  it('defines immutable plugin declarations', () => {
    const plugin = defineHoloPlugin({ id: 'demo' })
    expect(plugin).toEqual({ id: 'demo' })
    expect(Object.isFrozen(plugin)).toBe(true)
  })
})
