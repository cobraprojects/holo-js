import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { importBundledRuntimeModule } from '../runtimeModule'
import type { GeneratedProjectRegistry } from './registry'

export async function preloadGeneratedSchemaModule(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
): Promise<void> {
  const entry = registry?.paths.generatedSchema
  if (!entry) return
  const expectedTarget = resolve(projectRoot, entry)
  if (!existsSync(expectedTarget)) return
  try {
    await importBundledRuntimeModule(projectRoot, entry)
  } catch (error) {
    if (error instanceof Error && /Cannot find module|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|Failed to load url|Failed to load /.test(error.message)) {
      const failedTarget = error.message
        .match(/Cannot find module '([^']+)'|Cannot find package '([^']+)'|Failed to load url ([^ ]+)|Failed to load ([^ ]+)\./)
        ?.slice(1)
        .find((value): value is string => typeof value === 'string')
      if (failedTarget === expectedTarget) return
    }
    throw error
  }
}

export async function preloadDiscoveredModelModules(
  projectRoot: string,
  registry: GeneratedProjectRegistry | undefined,
): Promise<void> {
  if (!registry || registry.models.length === 0) return
  for (const entry of registry.models) {
    const sourcePath = resolve(projectRoot, entry.sourcePath)
    if (existsSync(sourcePath)) await importBundledRuntimeModule(projectRoot, sourcePath)
  }
}
