import { ConfigurationError } from '../core/errors'
import type { MigrationDefinition } from './types'

const MIGRATION_NAME_PATTERN = /^\d{4}_\d{2}_\d{2}_\d{6}_[a-z0-9_]+$/

export function defineMigration<TDefinition extends MigrationDefinition>(definition: TDefinition): TDefinition {
  if (definition.name && !MIGRATION_NAME_PATTERN.test(definition.name)) {
    throw new ConfigurationError(
      `Migration name "${definition.name}" must match YYYY_MM_DD_HHMMSS_description.`,
    )
  }

  return Object.freeze(definition)
}

export function assertMigrationName(name: string): string {
  if (!MIGRATION_NAME_PATTERN.test(name)) {
    throw new ConfigurationError(
      `Migration name "${name}" must match YYYY_MM_DD_HHMMSS_description.`,
    )
  }

  return name
}
