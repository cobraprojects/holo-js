import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { configRegistryInternals, loadConfigDirectory, type LoadedHoloConfig } from '@holo-js/config'

export const CONFIG_NORMALIZER_PACKAGES = [
  '@holo-js/auth',
  '@holo-js/broadcast',
  '@holo-js/cache',
  '@holo-js/db',
  '@holo-js/mail',
  '@holo-js/media',
  '@holo-js/notifications',
  '@holo-js/queue',
  '@holo-js/security',
  '@holo-js/session',
  '@holo-js/storage',
] as const

function resolveInstalledConfigModule(projectRoot: string, packageName: string): string | undefined {
  try {
    const projectRequire = createRequire(resolve(projectRoot, 'package.json'))
    return pathToFileURL(projectRequire.resolve(`${packageName}/config`)).href
  } catch {
    return undefined
  }
}

export async function loadConfigWithNormalizers(
  projectRoot: string,
  options?: Parameters<typeof loadConfigDirectory>[1],
  loadOptions: { readonly excludeNormalizers?: readonly string[] } = {},
): Promise<LoadedHoloConfig> {
  for (const packageName of CONFIG_NORMALIZER_PACKAGES) {
    const moduleUrl = resolveInstalledConfigModule(projectRoot, packageName)
    if (moduleUrl) {
      await import(moduleUrl)
    }
  }

  const excludedNormalizers = loadOptions.excludeNormalizers ?? []
  if (excludedNormalizers.length === 0) {
    return await loadConfigDirectory(projectRoot, options)
  }

  return await configRegistryInternals.runWithoutNormalizers(
    excludedNormalizers,
    () => loadConfigDirectory(projectRoot, options),
  )
}
