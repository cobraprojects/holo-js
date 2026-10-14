import { createServer, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, expectTypeOf, it } from 'vitest'
import createS3Driver from '../../storage-s3/src'
import type { StorageFileMetadata } from '../src/runtime/composables'

let server: Server
let driver: ReturnType<typeof createS3Driver>
let status: number
let headers: Record<string, string>
let requests: { method: string | undefined, path: string | undefined }[]

beforeEach(async () => {
  status = 200
  headers = { 'content-length': '96', 'content-type': 'text/plain', 'x-amz-meta-size': '0' }
  requests = []
  server = createServer((request, response) => {
    requests.push({ method: request.method, path: request.url })
    if (!request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=test-access/')) {
      response.writeHead(403).end()
      return
    }
    response.writeHead(status, headers).end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing S3 test endpoint')
  driver = createS3Driver({
    bucket: 'files',
    region: 'us-east-1',
    endpoint: `http://127.0.0.1:${address.port}`,
    forcePathStyleEndpoint: true,
    accessKeyId: 'test-access',
    secretAccessKey: 'test-secret',
  })
})

afterEach(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
})

describe('S3 file metadata over HTTP', () => {
  it('returns size and MIME in one signed HEAD request without exposing custom metadata', async () => {
    const result = driver.getItemStat('uploads:report.txt')
    expectTypeOf(result).toEqualTypeOf<Promise<StorageFileMetadata | null>>()
    await expect(result).resolves.toEqual({ size: 96, mimeType: 'text/plain' })
    expect(requests).toEqual([{ method: 'HEAD', path: '/files/uploads/report.txt' }])
  })

  it('distinguishes an empty file from a missing file and allows absent MIME', async () => {
    headers = { 'content-length': '0' }
    await expect(driver.getItemStat('empty.bin')).resolves.toEqual({ size: 0, mimeType: null })
    status = 404
    await expect(driver.getItemStat('missing.bin')).resolves.toBeNull()
  })

  it.each([undefined, '-1', '1.5', '9007199254740992'])('rejects unusable content length: %j', async (length) => {
    headers = length === undefined ? {} : { 'content-length': length }
    await expect(driver.getItemStat('report.txt')).rejects.toThrow('File metadata')
  })

  it('reports denied metadata without exposing credentials or server error details', async () => {
    status = 403
    await expect(driver.getItemStat('report.txt')).rejects.toThrow('[unstorage] [s3] File metadata request failed.')
  })

  it.each(['../escape.txt', 'nested:..:escape.txt'])('rejects traversal before making a request: %j', async (path) => {
    await expect(driver.getItemStat(path)).rejects.toThrow()
    expect(requests).toEqual([])
  })
})
