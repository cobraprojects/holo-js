declare module '@holo-js/cache-redis' {
  import type { CacheDriverContract } from './contracts'

  type RedisClusterNode = {
    readonly url?: string
    readonly socketPath?: string
    readonly host: string
    readonly port: number
  }

  export type RedisCacheDriverOptions = {
    readonly name: string
    readonly connectionName: string
    readonly prefix: string
    readonly now?: () => number
    readonly sleep?: (milliseconds: number) => Promise<void>
    readonly ownerFactory?: () => string
    readonly redis:
      & {
        readonly username?: string
        readonly password?: string
        readonly db: number
      }
      & (
        | {
            readonly url?: never
            readonly clusters?: never
            readonly socketPath?: never
            readonly host: string
            readonly port: number
          }
        | {
            readonly url: string
            readonly clusters?: never
            readonly socketPath?: never
            readonly host?: never
            readonly port?: never
          }
        | {
            readonly url?: never
            readonly clusters: readonly RedisClusterNode[]
            readonly socketPath?: never
            readonly host?: never
            readonly port?: never
          }
        | {
            readonly url?: never
            readonly clusters?: never
            readonly socketPath: string
            readonly host?: never
            readonly port?: never
          }
      )
  }

  export function createRedisCacheDriver(options: RedisCacheDriverOptions): CacheDriverContract
}
