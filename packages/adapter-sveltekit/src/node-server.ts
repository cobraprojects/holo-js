import type { EventEmitter } from 'node:events'
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Server } from '@sveltejs/kit'
import { createReadableStream, getRequest, setResponse } from '@sveltejs/kit/node'
import sirv from 'sirv'

type NodeServerOptions = {
  readonly directory: URL
  readonly base: string
  readonly appPath: string
  readonly canonicalOrigin?: string
  readonly prerenderedPaths: readonly string[]
}

function deploymentOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('APP_URL must be an HTTP or HTTPS URL without credentials')
  }
  return url.origin
}

function requestBodyLimit(value = '512K'): number {
  const match = /^(\d+(?:\.\d+)?)([KMG]?)$/i.exec(value)
  if (!match) throw new Error('BODY_SIZE_LIMIT must be bytes or a size ending in K, M, or G')
  const power = match[2] ? 'KMG'.indexOf(match[2].toUpperCase()) + 1 : 0
  const limit = Number(match[1]) * 1024 ** power
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error('BODY_SIZE_LIMIT must be a non-negative safe integer in bytes')
  return limit
}

export async function startNodeServer(application: Server, options: NodeServerOptions): Promise<HttpServer> {
  const bodySizeLimit = requestBodyLimit(process.env.BODY_SIZE_LIMIT)
  const origin = deploymentOrigin(options.canonicalOrigin ?? process.env.APP_URL)
  const directory = fileURLToPath(options.directory)
  const assets = join(directory, 'client', options.base)
  const serveClient = sirv(join(directory, 'client'), {
    etag: true,
    gzip: true,
    brotli: true,
    setHeaders(response, pathname) {
      if (pathname.startsWith(`/${options.appPath}/immutable/`)) {
        response.setHeader('cache-control', 'public,max-age=31536000,immutable')
      }
    },
  })
  const servePrerendered = sirv(join(directory, 'prerendered'), { etag: true, gzip: true, brotli: true })
  const prerenderedPaths = new Set(options.prerenderedPaths)
  await application.init({ env: process.env, read: file => createReadableStream(join(assets, file)) })

  const respond = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    let request: Request
    try {
      if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) throw new Error('Invalid request target')
      request = getRequest({
        request: incoming,
        response: outgoing,
        base: origin ?? new URL(`http://${incoming.headers.host}`).origin,
        bodySizeLimit,
      })
    } catch {
      outgoing.writeHead(400).end('Bad Request')
      return
    }
    try {
      const response = await application.respond(request, {
        platform: { req: incoming },
        getClientAddress: () => {
          const address = incoming.socket.remoteAddress
          if (!address) throw new Error('Client address is unavailable')
          return address
        },
      })
      setResponse(outgoing, response)
    } catch {
      if (outgoing.headersSent) outgoing.destroy()
      else outgoing.writeHead(500).end('Internal Server Error')
    }
  }
  const server = createServer((request, response) => {
    const render = () => { void respond(request, response) }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      render()
      return
    }
    serveClient(request, response, () => {
      let url: URL
      let pathname: string
      try {
        url = new URL(request.url ?? '/', 'http://localhost')
        pathname = decodeURI(url.pathname)
      } catch {
        response.writeHead(400).end('Bad Request')
        return
      }
      if (prerenderedPaths.has(pathname)) {
        servePrerendered(request, response, render)
        return
      }
      const alternate = pathname.endsWith('/') ? pathname.slice(0, -1) : `${pathname}/`
      if (prerenderedPaths.has(alternate)) {
        response.writeHead(308, { location: encodeURI(alternate) + url.search }).end()
        return
      }
      render()
    })
  })
  const port = Number(process.env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be an integer between 0 and 65535')
  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject)
    server.listen(port, process.env.HOST ?? '0.0.0.0', () => {
      server.off('error', reject)
      resolvePromise()
    })
  })
  let shutdownTimeout: ReturnType<typeof setTimeout> | undefined
  const shutdown = (): void => {
    if (shutdownTimeout) return
    shutdownTimeout = setTimeout(() => server.closeAllConnections(), 30_000)
    shutdownTimeout.unref()
    server.close()
    server.closeIdleConnections()
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  server.once('close', () => {
    clearTimeout(shutdownTimeout)
    process.off('SIGTERM', shutdown)
    process.off('SIGINT', shutdown)
    const lifecycle: EventEmitter = process
    lifecycle.emit('sveltekit:shutdown')
  })
  const address = server.address()
  process.stdout.write(`Listening on port ${typeof address === 'object' ? address?.port : port}\n`)
  return server
}
