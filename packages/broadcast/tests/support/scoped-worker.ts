import { normalizeRedisConfig } from '@holo-js/kernel'
import { configureDB, createConnectionManager, createDatabase, createDialect } from '../../../db/src'
import { createSQLiteAdapter } from '../../../db-sqlite/src'
import { query } from '../../../realtime/src'
import { configureRealtimeRuntime, executeRealtimeQuery, realtimeServerInternals, subscribeRealtimeQuery } from '../../../realtime/src/server'
import { normalizeBroadcastConfig, startBroadcastWorker } from '../../src'

const [filename = '', redisPort = '', port = '', appId = '', key = ''] = process.argv.slice(2)

const adapter = createSQLiteAdapter({ filename })
const db = createDatabase({ adapter, dialect: createDialect('sqlite'), connectionName: 'main' })
configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))
configureRealtimeRuntime({ db: () => db })
const scores = query({
  name: 'scores.current',
  access: 'public',
  handler: async () => ({ score: (await db.table('scores').where('id', 1).first())?.score }),
})

await startBroadcastWorker({
  config: normalizeBroadcastConfig({
    default: 'main',
    connections: { main: { driver: 'holo', appId, key, secret: 'secret', options: { host: '127.0.0.1', port: Number(port), scheme: 'http' } } },
    worker: { host: '127.0.0.1', port: Number(port), scaling: { driver: 'redis', connection: 'shared' } },
  }),
  redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: Number(redisPort) } } }),
  nodeId: `worker-${appId}`,
  realtime: {
    databaseInvalidation: realtimeServerInternals.createRealtimeDatabaseInvalidationBridge(),
    query: async () => await executeRealtimeQuery(scores),
    mutate: async () => { throw new Error('No mutation is registered') },
    subscribe: async (_name, _args, options) => await subscribeRealtimeQuery(scores, {}, options),
  },
})

process.stdout.write('ready\n')
