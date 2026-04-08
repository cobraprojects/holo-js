import { join } from 'node:path'
import {
  generateMigrationTemplate,
  inferMigrationTableName,
  inferMigrationTemplateKind,
  normalizeMigrationSlug,
} from '@holo-js/db'
import { fileExists } from './fs-utils'
import type { loadGeneratedProjectRegistry } from './project'

export const MIGRATION_NAME_PREFIX_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_/

export function stripMigrationNamePrefix(name: string): string {
  return name.replace(MIGRATION_NAME_PREFIX_PATTERN, '')
}

export function getRegistryMigrationSlug(name: string): string {
  return normalizeMigrationSlug(stripMigrationNamePrefix(name))
}

export function hasRegisteredMigrationSlug(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  migrationSlug: string,
): boolean {
  return Boolean(registry?.migrations.some((entry) => {
    try {
      return getRegistryMigrationSlug(entry.name) === migrationSlug
    } catch {
      return false
    }
  }))
}

export function hasRegisteredCreateTableMigration(
  registry: Awaited<ReturnType<typeof loadGeneratedProjectRegistry>> | undefined,
  tableName: string,
): boolean {
  const expectedSlug = `create_${tableName}_table`
  return Boolean(registry?.migrations.some((entry) => {
    try {
      const slug = getRegistryMigrationSlug(entry.name)
      if (slug === expectedSlug) {
        return true
      }

      if (inferMigrationTemplateKind(slug) !== 'create_table') {
        return false
      }

      return inferMigrationTableName(slug, 'create_table') === tableName
    } catch {
      return false
    }
  }))
}

export async function nextMigrationTemplate(
  name: string,
  migrationsDir: string,
  options: Parameters<typeof generateMigrationTemplate>[1] = {},
): Promise<ReturnType<typeof generateMigrationTemplate>> {
  let offsetSeconds = 0

  while (true) {
    const candidate = generateMigrationTemplate(name, {
      date: new Date(Date.now() + offsetSeconds * 1000),
      ...options,
    })
    if (!(await fileExists(join(migrationsDir, candidate.fileName)))) {
      return candidate
    }

    offsetSeconds += 1
  }
}
