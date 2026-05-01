import { defineBroadcastConfig, env } from '@holo-js/config'

const broadcastScheme = env('BROADCAST_SCHEME') === 'https' ? 'https' : 'http'

export default defineBroadcastConfig({
  default: env('BROADCAST_CONNECTION', 'holo'),
  connections: {
    holo: {
      driver: 'holo',
      appId: env('BROADCAST_APP_ID', 'app-id'),
      key: env('BROADCAST_APP_KEY', 'app-key'),
      secret: env('BROADCAST_APP_SECRET', 'app-secret'),
      options: {
        host: env('BROADCAST_HOST', '127.0.0.1'),
        port: env('BROADCAST_PORT', 8080),
        scheme: broadcastScheme,
        useTLS: broadcastScheme === 'https',
      },
      clientOptions: {
        authEndpoint: `${env('APP_URL', 'http://localhost:3000')}/broadcasting/auth`,
      },
    },
    log: {
      driver: 'log',
    },
    null: {
      driver: 'null',
    },
  },
})
