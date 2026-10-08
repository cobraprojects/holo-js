import { resolve } from 'node:path'
import { readProjectDependencyNames } from '../package-json'
import { readTextFile, writeTextFile } from './runtime'
import {
  getFrameworkDescriptorByIdFrom,
  getFrameworkDescriptorsWith,
  type FrameworkDescriptor,
} from './frameworks'
import { loadProjectPluginFrameworkDescriptors } from './plugins'
import { renderFrameworkRunnerForDescriptor } from './scaffold/framework-renderers'
import { syncManagedFrameworkArtifacts } from './registry-svelte'

export async function resolveFrameworkPreparation(projectRoot: string): Promise<{
  readonly framework?: FrameworkDescriptor
  readonly sync?: FrameworkDescriptor['sync']
  readonly writeArtifacts: () => Promise<boolean>
}> {
  const pluginDescriptors = await loadProjectPluginFrameworkDescriptors(projectRoot)
  const descriptors = getFrameworkDescriptorsWith(pluginDescriptors)
  const dependencyNames = await readProjectDependencyNames(projectRoot)
  let framework: FrameworkDescriptor | undefined
  try {
    const content = await readTextFile(resolve(projectRoot, '.holo-js/framework/project.json'))
    if (content) {
      const manifest = JSON.parse(content) as { framework?: unknown }
      if (typeof manifest.framework === 'string') {
        framework = getFrameworkDescriptorByIdFrom(manifest.framework, pluginDescriptors)
      }
    }
  } catch {
    framework = undefined
  }
  const detectedFramework = descriptors.find(descriptor => descriptor.detectPackages.some(name => dependencyNames.has(name)))
  if (!framework || (detectedFramework && !framework.detectPackages.some(name => dependencyNames.has(name)))) {
    framework = detectedFramework
  }
  const selectedFramework = framework
  const sync = framework
    ? descriptors.find(descriptor => descriptor.id === framework.id && descriptor.sync)?.sync
    : undefined
  return {
    framework,
    sync,
    writeArtifacts: async () => {
      if (!selectedFramework) return false
      await writeFrameworkMetadata(projectRoot, selectedFramework)
      return await syncManagedFrameworkArtifacts(projectRoot, selectedFramework.id, dependencyNames)
    },
  }
}

async function writeFrameworkMetadata(projectRoot: string, framework: FrameworkDescriptor): Promise<void> {
  const metadata = [
    { path: '.holo-js/framework/project.json', contents: `${JSON.stringify({ framework: framework.id }, null, 2)}\n` },
    { path: '.holo-js/framework/run.mjs', contents: renderFrameworkRunnerForDescriptor(framework) },
  ]
  for (const file of metadata) {
    const path = resolve(projectRoot, file.path)
    if (await readTextFile(path) !== file.contents) await writeTextFile(path, file.contents)
  }
}
