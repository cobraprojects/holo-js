import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer, request, type IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { connectionAddress } from '../src/runtime/server/connection-address'

async function addressSeenBy(listen: (server: ReturnType<typeof createServer>) => void, connect: (server: ReturnType<typeof createServer>) => void): Promise<string | undefined> {
  let seen: string | undefined
  const server = createServer((incoming: IncomingMessage, response) => {
    seen = connectionAddress(incoming.socket)
    response.end()
  })
  listen(server)
  await once(server, 'listening')
  try {
    connect(server)
    await once(server, 'request')
    await new Promise(resolve => setImmediate(resolve))
    return seen
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

describe('Nuxt connection address', () => {
  it('reports the TCP peer address', async () => {
    const seen = await addressSeenBy(
      server => server.listen(0, '127.0.0.1'),
      (server) => {
        const address = server.address()
        if (!address || typeof address === 'string') throw new Error('Expected a TCP address')
        request({ host: '127.0.0.1', port: address.port, path: '/' }, response => response.resume()).end()
      },
    )
    expect(seen).toBe('127.0.0.1')
  })

  it('reports a Unix socket peer, such as the nuxi dev proxy, as the local machine', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'holo-nuxt-socket-'))
    const socketPath = join(directory, 'nitro.sock')
    try {
      const seen = await addressSeenBy(
        server => server.listen(socketPath),
        () => request({ socketPath, path: '/' }, response => response.resume()).end(),
      )
      expect(seen).toBe('127.0.0.1')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
