import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfigDirectory } from '@holo-js/config'
import { configurePlainNodeStorageRuntime, resetOptionalStorageRuntime } from '../../core/src/storageRuntime'
import '../src/config'
import { useStorage } from '../src/runtime/composables'

const pngPixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

let server: Server
let objects: Map<string, { body: Buffer, contentType: string }>
let denied: boolean
let rangeStatusForEmptyObjects: 200 | 416
let contentRangeOverride: string | undefined
let requests: { method: string | undefined, path: string | undefined, range: string | undefined }[]
let projectRoot: string

beforeEach(async () => {
  objects = new Map()
  denied = false
  rangeStatusForEmptyObjects = 416
  contentRangeOverride = undefined
  requests = []
  projectRoot = await mkdtemp(join(tmpdir(), 'holo-storage-metadata-'))
  server = createServer((request, response) => {
    const range = request.headers.range
    requests.push({ method: request.method, path: request.url, range })
    if (denied || !request.headers.authorization?.startsWith('AWS4-HMAC-SHA256 Credential=test-access/')) {
      response.writeHead(403).end('<Error><Message>secret details</Message></Error>')
      return
    }
    const object = objects.get(request.url ?? '')
    if (!object) {
      response.writeHead(404).end()
      return
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'content-length': object.body.length, 'content-type': object.contentType }).end()
      return
    }
    const match = /^bytes=0-(\d+)$/.exec(range ?? '')
    if (!match) {
      response.writeHead(200, { 'content-type': object.contentType }).end(object.body)
      return
    }
    if (object.body.length === 0) {
      response.writeHead(rangeStatusForEmptyObjects, rangeStatusForEmptyObjects === 200 ? { 'content-length': 0 } : {}).end()
      return
    }
    const end = Math.min(Number(match[1]), object.body.length - 1)
    response.writeHead(206, {
      'content-type': object.contentType,
      'content-range': contentRangeOverride ?? `bytes 0-${end}/${object.body.length}`,
    }).end(object.body.subarray(0, end + 1))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing S3 test endpoint')
  await mkdir(join(projectRoot, 'config'))
  await writeFile(join(projectRoot, 'config/storage.mjs'), `export default ${JSON.stringify({
    defaultDisk: 'local',
    disks: {
      local: { driver: 'local', visibility: 'private', root: join(projectRoot, 'storage/app') },
      media: {
        driver: 's3',
        bucket: 'files',
        region: 'us-east-1',
        endpoint: `http://127.0.0.1:${address.port}`,
        forcePathStyleEndpoint: true,
        accessKeyId: 'test-access',
        secretAccessKey: 'test-secret',
      },
    },
  })}\n`)
  await configurePlainNodeStorageRuntime(resolve(import.meta.dirname, '../../..'), await loadConfigDirectory(projectRoot, { preferCache: false }))
})

afterEach(async () => {
  await resetOptionalStorageRuntime()
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  await rm(projectRoot, { recursive: true, force: true })
})

describe('file metadata across storage drivers', () => {
  it('detects the same MIME type on local and S3 disks from file contents instead of declarations', async () => {
    objects.set('/files/uploads/avatar.txt', { body: pngPixel, contentType: 'text/plain' })
    await useStorage('local').put('uploads/avatar.txt', pngPixel)

    const expected = { size: pngPixel.length, mimeType: 'image/png' }
    await expect(useStorage('local').stat('uploads/avatar.txt')).resolves.toEqual(expected)
    await expect(useStorage('media').stat('uploads/avatar.txt')).resolves.toEqual(expected)
    expect(requests).toEqual([{ method: 'GET', path: '/files/uploads/avatar.txt', range: 'bytes=0-65535' }])
  })

  it('names text formats by extension and refuses forged binary names on every driver', async () => {
    const notes = Buffer.from('quarterly notes')
    objects.set('/files/notes.csv', { body: notes, contentType: 'binary/octet-stream' })
    await useStorage('local').put('notes.csv', notes)
    await expect(useStorage('local').stat('notes.csv')).resolves.toEqual({ size: notes.length, mimeType: 'text/csv' })
    await expect(useStorage('media').stat('notes.csv')).resolves.toEqual({ size: notes.length, mimeType: 'text/csv' })
  })

  it('reports unrecognized contents without a MIME type on every driver', async () => {
    const report = Buffer.from('quarterly report')
    objects.set('/files/report.pdf', { body: report, contentType: 'application/pdf' })
    await useStorage('local').put('report.pdf', report)

    const expected = { size: report.length, mimeType: null }
    await expect(useStorage('local').stat('report.pdf')).resolves.toEqual(expected)
    await expect(useStorage('media').stat('report.pdf')).resolves.toEqual(expected)
  })

  it.each([416, 200] as const)('distinguishes an empty S3 object from a missing one when ranges answer %i', async (status) => {
    rangeStatusForEmptyObjects = status
    objects.set('/files/empty.bin', { body: Buffer.alloc(0), contentType: 'binary/octet-stream' })
    await expect(useStorage('media').stat('empty.bin')).resolves.toEqual({ size: 0, mimeType: null })
    await expect(useStorage('media').stat('missing.bin')).resolves.toBeNull()
  })

  it.each(['bytes 0-3/-1', 'bytes 0-3/1.5', 'bytes 0-3/9007199254740992', 'bytes */4', ''])('rejects an unusable S3 object size: %j', async (contentRange) => {
    objects.set('/files/report.bin', { body: Buffer.from('data'), contentType: 'binary/octet-stream' })
    contentRangeOverride = contentRange
    await expect(useStorage('media').stat('report.bin')).rejects.toThrow('[unstorage] [s3] File metadata response has an invalid content length.')
  })

  it('reports denied metadata without exposing credentials or server error details', async () => {
    denied = true
    const error = await useStorage('media').stat('report.txt').catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('[unstorage] [s3] File metadata request failed.')
  })

  it.each(['../escape.txt', 'nested/../escape.txt'])('rejects traversal before making a request: %j', async (path) => {
    await expect(useStorage('media').stat(path)).rejects.toThrow()
    expect(requests).toEqual([])
  })
})
