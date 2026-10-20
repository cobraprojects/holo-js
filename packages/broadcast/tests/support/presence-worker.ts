import { normalizeRedisConfig } from '@holo-js/kernel'
import { defineChannel, normalizeBroadcastConfig, startBroadcastWorker } from '../../src'

const [nodeId = '', port = '', redisPort = '', leaseTtlMs = '', refreshIntervalMs = ''] = process.argv.slice(2)

await startBroadcastWorker({
  config: normalizeBroadcastConfig({
    default: 'main',
    connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
    worker: { host: '127.0.0.1', port: Number(port), scaling: { driver: 'redis', connection: 'shared' } },
  }),
  redis: normalizeRedisConfig({
    default: 'shared',
    connections: { shared: { host: '127.0.0.1', port: Number(redisPort) } },
  }),
  nodeId,
  scalingLiveness: { leaseTtlMs: Number(leaseTtlMs), refreshIntervalMs: Number(refreshIntervalMs) },
  channelAuth: {
    resolveUser: ({ headers }) => ({ id: headers.get('x-test-user') ?? 'anonymous' }),
    definitions: [defineChannel('chat.1', { type: 'presence', authorize: user => ({ id: (user as { id: string }).id }) })],
  },
})

process.stdout.write('ready\n')
