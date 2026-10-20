import { normalizeRedisConfig } from '@holo-js/kernel'
import { createConnectionManager, configureDB, createDatabase, createDialect, queryCacheInternals } from '../../../db/src'
import { createSQLiteAdapter } from '../../../db-sqlite/src'
import { normalizeBroadcastConfig, workerInternals } from '../../src'

const [filename = '', score = '', redisPort = '', appId = 'app'] = process.argv.slice(2)

const broadcast = normalizeBroadcastConfig({
  default: 'main',
  connections: { main: { driver: 'holo', appId: 'app', key: 'key', secret: 'secret' } },
  worker: { host: '127.0.0.1', port: 1, scaling: { driver: 'redis', connection: 'shared' } },
})
const sender = workerInternals.createScalingInvalidationSender({
  config: broadcast.worker.scaling as Exclude<typeof broadcast.worker.scaling, false>,
  redis: normalizeRedisConfig({ default: 'shared', connections: { shared: { host: '127.0.0.1', port: Number(redisPort) } } }),
  appId,
})
queryCacheInternals.onDatabaseDependencyInvalidationPublished(sender.publish)

const adapter = createSQLiteAdapter({ filename })
const db = createDatabase({
  adapter,
  dialect: createDialect('sqlite'),
  connectionName: 'main',
})
configureDB(createConnectionManager({ defaultConnection: 'main', connections: { main: db } }))

await db.table('scores').where('id', 1).update({ score: Number(score) })
await sender.close()
await adapter.disconnect()

process.stdout.write('written\n')
