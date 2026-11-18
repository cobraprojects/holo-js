import { createPostgresAdapter } from '@holo-js/db-postgres'
import { postgresIntegration, postgresTestConnection } from '../../../tests/support/real-database'

export default async function setup(): Promise<void> {
  if (!postgresIntegration) return
  const adapter = createPostgresAdapter({ config: postgresTestConnection() })
  try {
    await adapter.initialize()
    await adapter.execute('CREATE EXTENSION IF NOT EXISTS vector')
  } finally {
    await adapter.disconnect()
  }
}
