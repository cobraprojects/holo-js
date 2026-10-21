import { normalizeRedisConfig } from '@holo-js/kernel'
import { realtimeServerInternals } from '../../../realtime/src/server'
import { normalizeBroadcastConfig, startBroadcastWorker } from '../../src'

const [redisPort = '', port = '', appId = ''] = process.argv.slice(2)

const bridge = realtimeServerInternals.createRealtimeDatabaseInvalidationBridge()
await startBroadcastWorker({
  config: normalizeBroadcastConfig({
    default: 'main',
    connections: { main: { driver: 'holo', appId, key: 'key', secret: 'secret', options: { host: '127.0.0.1', port: Number(port), scheme: 'http' } } },
    worker: { host: '127.0.0.1', port: Number(port), scaling: { driver: 'redis', connection: 'shared' } },
  }),
  redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: Number(redisPort) } } }),
  realtime: {
    databaseInvalidation: {
      connect: bridge.connect,
      receive: async invalidation => {
        process.stdout.write(`received ${JSON.stringify(invalidation)}\n`)
        await bridge.receive(invalidation)
      },
    },
    query: async () => { throw new Error('No query is registered') },
    mutate: async () => { throw new Error('No mutation is registered') },
    subscribe: async () => { throw new Error('No subscription is registered') },
  },
})

process.stdout.write('ready\n')
