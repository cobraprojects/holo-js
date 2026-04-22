declare module '@holo-js/cache-db' {
  import type { CacheDriverContract } from './contracts'
  import type { HoloDatabaseConnectionConfig } from '@holo-js/config'

  export type DatabaseCacheDriverOptions = {
    readonly name: string
    readonly connectionName: string
    readonly table: string
    readonly lockTable: string
    readonly connection: HoloDatabaseConnectionConfig | string
  }

  export function createDatabaseCacheDriver(options: DatabaseCacheDriverOptions): CacheDriverContract
}
