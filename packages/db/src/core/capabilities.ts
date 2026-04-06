/**
 * Capability flags exposed by a driver+dialect pair.
 *
 * The new architecture uses explicit capabilities instead of branching on
 * driver names throughout the ORM.
 */

export interface DatabaseCapabilities {
  returning: boolean
  savepoints: boolean
  concurrentQueries: boolean
  workerThreadExecution: boolean
  lockForUpdate: boolean
  sharedLock: boolean
  jsonValueQuery: boolean
  jsonContains: boolean
  jsonLength: boolean
  schemaQualifiedIdentifiers: boolean
  nativeUpsert: boolean
  ddlAlterSupport: boolean
  introspection: boolean
}

export const DEFAULT_CAPABILITIES: DatabaseCapabilities = {
  returning: false,
  savepoints: false,
  concurrentQueries: false,
  workerThreadExecution: false,
  lockForUpdate: false,
  sharedLock: false,
  jsonValueQuery: false,
  jsonContains: false,
  jsonLength: false,
  schemaQualifiedIdentifiers: false,
  nativeUpsert: false,
  ddlAlterSupport: false,
  introspection: false,
}

export function createCapabilities(
  overrides: Partial<DatabaseCapabilities> = {},
): DatabaseCapabilities {
  return {
    ...DEFAULT_CAPABILITIES,
    ...overrides,
  }
}
