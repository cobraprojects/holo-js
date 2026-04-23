// Vitest resolves this file as the aliased `ioredis` module.
export default class Redis {
  static Cluster = class RedisClusterStub {
    constructor(..._args: unknown[]) {}
  }

  constructor(..._args: unknown[]) {}
}
