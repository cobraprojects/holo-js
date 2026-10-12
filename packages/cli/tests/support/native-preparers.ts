import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import type { HoloProjectPreparer } from '@holo-js/kernel'
import type { LoadedProjectPreparer, LoadedProjectPluginPreparation } from '../../src/project/plugins'

const registryKey = Symbol.for('holo.native-test-preparers')
const registry = new Map<string, HoloProjectPreparer>()
Reflect.set(globalThis, registryKey, registry)

export async function installPreparers(root: string, preparers: readonly LoadedProjectPreparer[]): Promise<void> {
  await installPreparation(root, { activePlugins: preparers.map(preparer => preparer.plugin), preparers })
}

export async function installPreparation(root: string, preparation: LoadedProjectPluginPreparation): Promise<void> {
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `export default { name: 'Native plugin app', plugins: ${JSON.stringify(preparation.activePlugins.map(plugin => plugin.packageName))} }`)
  for (const plugin of preparation.activePlugins) {
    await mkdir(plugin.packageRoot, { recursive: true })
    await writeFile(join(plugin.packageRoot, 'package.json'), JSON.stringify({ name: plugin.packageName, type: 'module', holo: { plugin: './plugin.mjs' } }))
    await writeFile(join(plugin.packageRoot, 'plugin.mjs'), `export default ${JSON.stringify(plugin.definition)}`)
    const installedPath = join(root, 'node_modules', plugin.packageName)
    if (installedPath !== plugin.packageRoot) {
      await mkdir(join(root, 'node_modules'), { recursive: true })
      await rm(installedPath, { recursive: true, force: true })
      await symlink(plugin.packageRoot, installedPath)
    }
  }
  for (const loaded of preparation.preparers) {
    const id = randomUUID()
    registry.set(id, loaded.preparer)
    onTestFinished(() => { registry.delete(id) })
    await writeFile(join(loaded.plugin.packageRoot, loaded.specifier), `export default globalThis[Symbol.for('holo.native-test-preparers')].get(${JSON.stringify(id)})`)
  }
}
