declare module '@holo-js/cache-redis' {
  import type { CacheDriverContract } from './contracts'

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
            readonly url?: string
            readonly clusters?: readonly {
              readonly url?: string
              readonly socketPath?: string
              readonly host: string
              readonly port: number
            }[]
            readonly socketPath?: string
            readonly host: string
            readonly port: number
          }
        | {
            readonly url: string
            readonly clusters?: readonly {
              readonly url?: string
              readonly socketPath?: string
              readonly host: string
              readonly port: number
            }[]
            readonly socketPath?: string
            readonly host?: string
            readonly port?: number
          }
        | {
            readonly clusters: readonly {
              readonly url?: string
              readonly socketPath?: string
              readonly host: string
              readonly port: number
            }[]
            readonly url?: string
            readonly socketPath?: string
            readonly host?: string
            readonly port?: number
          }
      )
  }

  export function createRedisCacheDriver(options: RedisCacheDriverOptions): CacheDriverContract
}
