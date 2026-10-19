import { afterEach, describe, expect, it, vi } from 'vitest'
import createS3Driver from '../src'

function createDriver() {
  return createS3Driver({
    bucket: 'media-bucket',
    region: 'us-east-1',
    endpoint: 'https://s3.us-east-1.amazonaws.com',
    accessKeyId: 'AKIAEXAMPLE',
    secretAccessKey: 'supersecretkey',
  })
}

function listResponse(keys: readonly string[], nextToken?: string): Response {
  return new Response(
    `<ListBucketResult>${keys.map(key => `<Contents><Key>${key}</Key></Contents>`).join('')}${nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : ''}</ListBucketResult>`,
    { status: 200 },
  )
}

function stalledBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => undefined) })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('S3 transfer bounds', () => {
  it('caps multipart part buffers at 64 MiB however long the stream runs', async () => {
    const partSizes: number[] = []
    vi.stubGlobal('fetch', async (input: Request) => {
      const url = new URL(input.url)
      if (input.method === 'POST' && url.searchParams.has('uploads')) {
        return new Response('<InitiateMultipartUploadResult><UploadId>upload-1</UploadId></InitiateMultipartUploadResult>', { status: 200 })
      }
      if (input.method === 'PUT') {
        partSizes.push((await input.arrayBuffer()).byteLength)
        return new Response(null, { status: 200, headers: { etag: `"part-${url.searchParams.get('partNumber')}"` } })
      }
      return new Response(null, { status: 200 })
    })
    const chunk = new Uint8Array(5 * 1024 * 1024)
    const source = async function* (): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < 180; index += 1) yield chunk
    }

    await createDriver().setItemStream('reports:huge.bin', source(), { overwrite: true })

    expect(partSizes.reduce((total, size) => total + size, 0)).toBe(180 * chunk.byteLength)
    expect(Math.max(...partSizes)).toBe(64 * 1024 * 1024)
  }, 60_000)

  it('times out a request that receives no response', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined))

    const read = createDriver().getItemRaw('reports:daily.txt')
    const assertion = expect(read).rejects.toThrow('[unstorage] [s3] Request timed out.')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it('aborts the underlying fetch when a request times out', async () => {
    vi.useFakeTimers()
    let signal: AbortSignal | undefined
    vi.stubGlobal('fetch', (_input: Request, init?: RequestInit) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => undefined)
    })

    const read = createDriver().hasItem('reports:daily.txt').catch(() => undefined)
    await vi.advanceTimersByTimeAsync(30_000)
    await read
    expect(signal?.aborted).toBe(true)
  })

  it('gives uploads time proportional to their size before timing out', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined))
    let settled = false

    const write = createDriver().setItemRaw('reports:large.bin', new Uint8Array(1024 * 1024)).finally(() => {
      settled = true
    })
    const assertion = expect(write).rejects.toThrow('Request timed out.')
    await vi.advanceTimersByTimeAsync(37_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(1_000)
    await assertion
  })

  it('times out a response body that stops sending data', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async () => new Response(stalledBody(), { status: 200 }))

    const read = createDriver().getItemRaw('reports:daily.txt')
    const assertion = expect(read).rejects.toThrow('Request timed out.')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it('does not time out a stream while the consumer pauses between chunks', async () => {
    vi.useFakeTimers()
    const chunks = [new Uint8Array([1]), new Uint8Array([2])]
    vi.stubGlobal('fetch', async (input: Request) => {
      if (input.method === 'HEAD') return new Response(null, { status: 200 })
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          const next = chunks.shift()
          if (next) controller.enqueue(next)
          else controller.close()
        },
      }), { status: 200 })
    })

    const stream = await createDriver().getItemStream('reports:clip.bin', {})
    const iterator = stream![Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toEqual({ done: false, value: new Uint8Array([1]) })
    await vi.advanceTimersByTimeAsync(120_000)
    await expect(iterator.next()).resolves.toEqual({ done: false, value: new Uint8Array([2]) })
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined })
  })

  it('times out a stream whose object download stalls', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', async (input: Request) => {
      if (input.method === 'HEAD') return new Response(null, { status: 200 })
      return new Response(stalledBody(), { status: 200 })
    })

    const stream = await createDriver().getItemStream('reports:clip.bin', {})
    const next = stream![Symbol.asyncIterator]().next()
    const assertion = expect(next).rejects.toThrow('Request timed out.')
    await vi.advanceTimersByTimeAsync(30_000)
    await assertion
  })

  it('clears listing pages with at most eight concurrent deletes', async () => {
    const firstPage = Array.from({ length: 20 }, (_, index) => `reports/${index}.txt`)
    const secondPage = ['reports/last.txt']
    const listRequests: URL[] = []
    const deleted: string[] = []
    let inFlight = 0
    let maximumInFlight = 0
    vi.stubGlobal('fetch', async (input: Request) => {
      const url = new URL(input.url)
      if (input.method === 'GET') {
        listRequests.push(url)
        return url.searchParams.has('continuation-token') ? listResponse(secondPage) : listResponse(firstPage, 'token-2')
      }
      inFlight += 1
      maximumInFlight = Math.max(maximumInFlight, inFlight)
      await new Promise(resolve => setTimeout(resolve, 1))
      inFlight -= 1
      deleted.push(decodeURIComponent(url.pathname.slice(1)))
      return new Response(null, { status: 204 })
    })

    await createDriver().clear('reports:')

    expect(maximumInFlight).toBe(8)
    expect(deleted.sort()).toEqual([...firstPage, ...secondPage].sort())
    expect(listRequests.map(url => url.searchParams.get('max-keys'))).toEqual(['1000', '1000'])
    expect(listRequests[1]?.searchParams.get('continuation-token')).toBe('token-2')
  })
})
