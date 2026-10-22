import { resolve } from 'node:path'
import { storageRuntimeInternals } from '@holo-js/core'
import { normalizeModuleOptions } from '@holo-js/storage'
import { writeLine } from './io'
import type { IoStreams } from './cli-types'
import { loadConfigWithNormalizers } from './project/load-config'

export async function runStorageDecodeNamesCommand(
  io: IoStreams,
  projectRoot: string,
  diskName: string,
): Promise<void> {
  const loadedConfig = await loadConfigWithNormalizers(projectRoot)
  const storage = normalizeModuleOptions({
    defaultDisk: loadedConfig.storage.defaultDisk,
    routePrefix: loadedConfig.storage.routePrefix,
    disks: loadedConfig.storage.disks,
  })
  const disk = storage.disks[diskName]
  if (!disk) {
    throw new Error(`Disk "${diskName}" is not configured. Available disks: ${storage.diskNames.join(', ')}`)
  }
  if (disk.driver === 's3' || !disk.root) {
    throw new Error(`storage:decode-names only renames files on local disks. Disk "${diskName}" uses the ${disk.driver} driver.`)
  }

  const result = await storageRuntimeInternals.decodeLocalStorageNames(resolve(projectRoot, disk.root))
  for (const { from, to } of result.renamed) {
    writeLine(io.stdout, `[storage] Renamed "${from}" to "${to}".`)
  }
  for (const { path, reason } of result.skipped) {
    writeLine(io.stdout, `[storage] Skipped "${path}": ${reason}.`)
  }
  writeLine(io.stdout, `[storage] Renamed ${result.renamed.length} names on disk "${diskName}".`)
}
