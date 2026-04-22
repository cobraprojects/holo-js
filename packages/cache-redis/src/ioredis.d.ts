declare module 'ioredis' {
  type RedisClientOptions = Record<string, unknown>
  type RedisClusterStartupNode = {
    host: string
    port: number
    tls?: Record<string, never>
  }
  type RedisClusterOptions = {
    redisOptions?: Record<string, unknown>
  }

  export default class Redis {
    static Cluster: new (
      startupNodes: readonly RedisClusterStartupNode[],
      options?: RedisClusterOptions,
    ) => Redis

    constructor(urlOrOptions?: string | RedisClientOptions, options?: RedisClientOptions)
    get(key: string): Promise<string | null>
    set(key: string, value: string, ...arguments_: readonly (string | number)[]): Promise<'OK' | null>
    del(...keys: string[]): Promise<number>
    scan(cursor: string, matchLabel: string, pattern: string, countLabel: string, count: number): Promise<[string, string[]]>
    incrby(key: string, amount: number): Promise<number>
    decrby(key: string, amount: number): Promise<number>
    eval(script: string, numberOfKeys: number, ...arguments_: readonly string[]): Promise<number>
  }
}
