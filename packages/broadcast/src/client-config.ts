import type { LoadedHoloConfig } from '@holo-js/config'

export type BroadcastClientConfig = {
  readonly key: string
  readonly host: string
  readonly port: number
  readonly path: string
  readonly scheme: 'http' | 'https'
}

function resolveDefaultHoloConnection(config: LoadedHoloConfig['broadcast']) {
  const connection = config.connections[config.default]
  if (!connection || connection.driver !== 'holo' || !('key' in connection) || !('options' in connection)) {
    throw new Error('[@holo-js/broadcast] Broadcast client config requires the default broadcast connection to use the "holo" driver.')
  }

  return connection
}

export function resolveBroadcastClientConfig(config: LoadedHoloConfig['broadcast']): BroadcastClientConfig {
  const connection = resolveDefaultHoloConnection(config)
  const publicHost = config.worker.publicHost ?? connection.options.host
  const publicPort = config.worker.publicHost
    ? config.worker.publicPort ?? connection.options.port
    : connection.options.port

  return Object.freeze({
    key: connection.key,
    host: publicHost,
    port: publicPort,
    path: config.worker.path,
    scheme: config.worker.publicScheme,
  })
}

export function renderBroadcastClientConfigResponse(config: LoadedHoloConfig['broadcast']): Response {
  return Response.json(resolveBroadcastClientConfig(config), {
    headers: {
      'cache-control': 'no-store',
    },
  })
}
