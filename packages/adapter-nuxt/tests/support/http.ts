import { once } from 'node:events'
import { createServer } from 'node:http'
import { toNodeListener, type App } from 'h3'
import { onTestFinished } from 'vitest'

export async function serve(app: App): Promise<string> {
  const server = createServer(toNodeListener(app))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  onTestFinished(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('HTTP server did not bind a port')
  return 'http://127.0.0.1:' + address.port
}
