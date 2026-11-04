import { describe, expect, it } from 'vitest'
import { createPostgresAdapter } from '../src'

describe('@holo-js/db-postgres session startup options', () => {
  it('gives clients that connect from their resolved connection parameters, as pg-native does, the session time zone ahead of explicit options', async () => {
    const resolvedOptions: (string | undefined)[] = []
    class ConnectionParametersClient {
      readonly connectionParameters: { options?: string }

      constructor(config: { options?: string }) {
        this.connectionParameters = { options: config.options }
      }

      connect(callback: (error: Error) => void): void {
        resolvedOptions.push(this.connectionParameters.options)
        callback(new Error('connection refused'))
      }

      on(): void {}
    }
    const adapter = createPostgresAdapter({ config: { options: '-c statement_timeout=5000', Client: ConnectionParametersClient as never } })

    await expect(adapter.query('SELECT 1')).rejects.toThrow('connection refused')
    await adapter.disconnect()

    expect(resolvedOptions).toEqual(['-c TimeZone=UTC -c statement_timeout=5000'])
  })
})
