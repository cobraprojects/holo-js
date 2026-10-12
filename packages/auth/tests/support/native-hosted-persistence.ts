import { resolve } from 'node:path'
import { createNativeAuthPersistence } from './native-persistence'
import { importBundledRuntimeModule } from '../../../core/src/runtimeModule'
import type { holoRuntimeInternals as CoreRuntimeInternals } from '../../../core/src/portable/holo'

export async function createNativeHostedAuthPersistence(namespace: 'clerk' | 'workos') {
  const persistence = await createNativeAuthPersistence(undefined, resolve(import.meta.dirname, 'hosted-models'))
  for (const tableName of ['users', 'admins']) {
    await persistence.schema.table(tableName, table => {
      table.string('clerkUserId').nullable()
      table.string('timezone').nullable()
    })
  }
  const { holoRuntimeInternals } = await importBundledRuntimeModule(persistence.projectRoot, resolve(import.meta.dirname, '../../../core/src/portable/holo.ts')) as { holoRuntimeInternals: typeof CoreRuntimeInternals }
  return { ...persistence, identityStore: holoRuntimeInternals.createCoreHostedIdentityStore(namespace) }
}
