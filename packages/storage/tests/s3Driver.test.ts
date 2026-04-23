import { createHash, createHmac } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type createS3Driver from '../../storage-s3/src'

const fetchMock = vi.fn()

async function loadDriver(): Promise<typeof createS3Driver> {
  const module = await import('../src/runtime/drivers/s3') as { default: typeof createS3Driver }
  return module.default
}

async function readRequestBody(request: Request): Promise<string> {
  return request.clone().text()
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex')
}

function hmac(key: Buffer | string, value: string): Buffer {
  return createHmac('sha256', key).update(value).digest()
}

function getSigningKey(secretAccessKey: string, date: string, region: string): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, date)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, 's3')
  return hmac(kService, 'aws4_request')
}

function encodeCanonicalUri(pathname: string): string {
  return pathname.replace(/[!'()*]/g, (value) => {
    return `%${value.charCodeAt(0).toString(16).toUpperCase()}`
  })
}

describe('custom s3 storage driver', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'))
    vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('signs requests with the session token when temporary credentials are configured', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      sessionToken: 'session-token',
    })

    await driver.setItemRaw('reports:daily.txt', new TextEncoder().encode('ok'))

    const request = fetchMock.mock.calls[0]?.[0] as Request
    expect(request).toBeInstanceOf(Request)
    expect(request.headers.get('x-amz-security-token')).toBe('session-token')
    expect(request.headers.get('authorization')).toContain('Credential=AKIAEXAMPLE/')
  })

  it('uses the configured addressing mode for backend requests', async () => {
    fetchMock.mockImplementation(async () => new Response('stored', { status: 200 }))

    const createDriver = await loadDriver()
    const virtualHostDriver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com/storage',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: false,
    })
    const pathStyleDriver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com/storage',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: true,
    })

    await virtualHostDriver.getItemRaw('images:photo.jpg')
    await pathStyleDriver.getItemRaw('images:photo.jpg')

    const firstRequest = fetchMock.mock.calls[0]?.[0] as Request
    const secondRequest = fetchMock.mock.calls[1]?.[0] as Request
    expect(firstRequest.url).toBe('https://media-bucket.gateway.example.com/storage/images/photo.jpg')
    expect(secondRequest.url).toBe('https://gateway.example.com/storage/media-bucket/images/photo.jpg')
  })

  it('RFC3986-encodes reserved filename characters in the canonical URI', async () => {
    fetchMock.mockResolvedValueOnce(new Response('stored', { status: 200 }))

    const accessKeyId = 'AKIAEXAMPLE'
    const secretAccessKey = 'supersecretkey'
    const region = 'us-east-1'
    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region,
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId,
      secretAccessKey,
    })

    await driver.getItemRaw('photos:photo (1)!*.jpg')

    const request = fetchMock.mock.calls[0]?.[0] as Request
    const amzDate = request.headers.get('x-amz-date')!
    const scopeDate = amzDate.slice(0, 8)
    const payloadHash = request.headers.get('x-amz-content-sha256')!
    const canonicalHeaders = Array.from(request.headers.entries())
      .filter(([name]) => name.toLowerCase() !== 'authorization')
      .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(';')
    const url = new URL(request.url)
    const canonicalRequest = [
      'GET',
      encodeCanonicalUri(url.pathname),
      '',
      canonicalHeaders.map(([name, value]) => `${name}:${value}`).join('\n'),
      '',
      signedHeaders,
      payloadHash,
    ].join('\n')
    const expectedSignature = createHmac('sha256', getSigningKey(secretAccessKey, scopeDate, region))
      .update([
        'AWS4-HMAC-SHA256',
        amzDate,
        `${scopeDate}/${region}/s3/aws4_request`,
        sha256(canonicalRequest),
      ].join('\n'))
      .digest('hex')

    expect(request.headers.get('authorization')).toContain(`Signature=${expectedSignature}`)
  })

  it('validates required driver options', async () => {
    const createDriver = await loadDriver()

    expect(() => createDriver({
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      bucket: 'media-bucket',
    })).not.toThrow()
    expect(() => createDriver({
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      secretAccessKey: 'supersecretkey',
      bucket: 'media-bucket',
    })).toThrow('Missing required option `accessKeyId`')
    expect(() => createDriver({
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      bucket: 'media-bucket',
    })).toThrow('Missing required option `secretAccessKey`')
    expect(() => createDriver({
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      bucket: 'media-bucket',
    })).toThrow('Missing required option `endpoint`')
    expect(() => createDriver({
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      bucket: 'media-bucket',
    })).toThrow('Missing required option `region`')
    expect(() => createDriver({
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })).toThrow('Missing required option `bucket`')
  })

  it('supports text, raw, metadata, and missing-item operations', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('ready', { status: 200 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, {
        status: 200,
        headers: {
          'x-amz-meta-etag': 'etag-1',
          'x-amz-meta-origin': 'camera',
        },
      }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com/storage',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: true,
    })

    await expect(driver.getItem('reports:daily.txt')).resolves.toBe('ready')
    const bytes = await driver.getItemRaw('reports:bytes.bin')
    await expect(driver.getMeta('reports:daily.txt')).resolves.toEqual({
      etag: 'etag-1',
      origin: 'camera',
    })
    await expect(driver.hasItem('reports:missing.txt')).resolves.toBe(false)

    expect(Array.from(new Uint8Array(bytes ?? new ArrayBuffer(0)))).toEqual([1, 2, 3])
    expect((fetchMock.mock.calls[0]?.[0] as Request).url).toBe(
      'https://gateway.example.com/storage/media-bucket/reports/daily.txt',
    )
    expect((fetchMock.mock.calls[1]?.[0] as Request).url).toBe(
      'https://gateway.example.com/storage/media-bucket/reports/bytes.bin',
    )
  })

  it('returns null for missing text objects and preserves raw Uint8Array payloads on writes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getItem('reports:missing.txt')).resolves.toBeNull()
    await driver.setItemRaw('reports:uint8.bin', new Uint8Array([117, 56]))

    expect(await readRequestBody(fetchMock.mock.calls[1]?.[0] as Request)).toBe('u8')
  })

  it('returns null for missing raw objects and preserves plain string writes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getItemRaw('reports:missing.bin')).resolves.toBeNull()
    await driver.setItem('reports:plain.txt', 'plain-text')

    expect(await readRequestBody(fetchMock.mock.calls[1]?.[0] as Request)).toBe('plain-text')
  })

  it('returns null metadata for missing objects', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getMeta('reports:missing.txt')).resolves.toBeNull()
  })

  it('stringifies structured values and preserves raw payloads on writes', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await driver.setItem('reports:summary.json', { ok: true })
    await driver.setItemRaw('reports:archive.bin', new TextEncoder().encode('raw-data').buffer)

    expect(await readRequestBody(fetchMock.mock.calls[0]?.[0] as Request)).toBe('{"ok":true}')
    expect(await readRequestBody(fetchMock.mock.calls[1]?.[0] as Request)).toBe('raw-data')
  })

  it('parses structured JSON payloads back through getItem', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{"ok":true,"count":2}', { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getItem('reports:summary.json')).resolves.toEqual({
      ok: true,
      count: 2,
    })
  })

  it('lists keys with prefixes and follows continuation tokens', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(
        '<?xml version="1.0"?><ListBucketResult>'
        + '<Contents><Key>reports/one.txt</Key></Contents>'
        + '<NextContinuationToken>token-2</NextContinuationToken>'
        + '</ListBucketResult>',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        '<?xml version="1.0"?><ListBucketResult>'
        + '<Contents><Key>reports/two.txt</Key></Contents>'
        + '</ListBucketResult>',
        { status: 200 },
      ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('reports')).resolves.toEqual([
      'reports/one.txt',
      'reports/two.txt',
    ])

    const firstRequest = new URL((fetchMock.mock.calls[0]?.[0] as Request).url)
    const secondRequest = new URL((fetchMock.mock.calls[1]?.[0] as Request).url)
    expect(firstRequest.searchParams.get('list-type')).toBe('2')
    expect(firstRequest.searchParams.get('prefix')).toBe('reports')
    expect(secondRequest.searchParams.get('continuation-token')).toBe('token-2')
  })

  it('preserves directory boundaries for colon-scoped prefixes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<?xml version="1.0"?><ListBucketResult>'
      + '<Contents><Key>reports/one.txt</Key></Contents>'
      + '<Contents><Key>reports/two.txt</Key></Contents>'
      + '</ListBucketResult>',
      { status: 200 },
    ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('reports:')).resolves.toEqual([
      'reports/one.txt',
      'reports/two.txt',
    ])

    const request = new URL((fetchMock.mock.calls[0]?.[0] as Request).url)
    expect(request.searchParams.get('prefix')).toBe('reports/')
  })

  it('drops empty normalized list prefixes', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<?xml version="1.0"?><ListBucketResult></ListBucketResult>',
      { status: 200 },
    ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('::')).resolves.toEqual([])

    const request = new URL((fetchMock.mock.calls[0]?.[0] as Request).url)
    expect(request.searchParams.has('prefix')).toBe(false)
  })

  it('decodes XML-escaped keys before returning listings and clearing objects', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(
        '<?xml version="1.0"?><ListBucketResult>'
        + '<Contents><Key>reports/a&amp;b.txt</Key></Contents>'
        + '<Contents><Key>reports/less&lt;more&gt;.txt</Key></Contents>'
        + '</ListBucketResult>',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(
        '<?xml version="1.0"?><ListBucketResult>'
        + '<Contents><Key>reports/a&amp;b.txt</Key></Contents>'
        + '<Contents><Key>reports/less&lt;more&gt;.txt</Key></Contents>'
        + '</ListBucketResult>',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('reports')).resolves.toEqual([
      'reports/a&b.txt',
      'reports/less<more>.txt',
    ])

    await driver.clear('reports')

    expect((fetchMock.mock.calls[2]?.[0] as Request).url).toContain('/reports/a%26b.txt')
    expect((fetchMock.mock.calls[3]?.[0] as Request).url).toContain('/reports/less%3Cmore%3E.txt')
  })

  it('preserves unknown XML entities when listing keys', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<?xml version="1.0"?><ListBucketResult>'
      + '<Contents><Key>reports/keep&unknown;.txt</Key></Contents>'
      + '</ListBucketResult>',
      { status: 200 },
    ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('reports')).resolves.toEqual([
      'reports/keep&unknown;.txt',
    ])
  })

  it('decodes quoted XML entities in listed keys', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<?xml version="1.0"?><ListBucketResult>'
      + '<Contents><Key>reports/&quot;quoted&quot;.txt</Key></Contents>'
      + '<Contents><Key>reports/it&apos;s.txt</Key></Contents>'
      + '</ListBucketResult>',
      { status: 200 },
    ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('reports')).resolves.toEqual([
      'reports/"quoted".txt',
      'reports/it\'s.txt',
    ])
  })

  it('decodes numeric XML entities in listed keys', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<?xml version="1.0"?><ListBucketResult>'
      + '<Contents><Key>reports/&#34;decimal&#34;.txt</Key></Contents>'
      + '<Contents><Key>reports/hex&#x27;s.txt</Key></Contents>'
      + '</ListBucketResult>',
      { status: 200 },
    ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('reports')).resolves.toEqual([
      'reports/"decimal".txt',
      'reports/hex\'s.txt',
    ])
  })

  it('drops list entries that do not contain an object key', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<?xml version="1.0"?><ListBucketResult>'
      + '<Contents></Contents>'
      + '<Contents><Key>reports/valid.txt</Key></Contents>'
      + '</ListBucketResult>',
      { status: 200 },
    ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys('reports')).resolves.toEqual([
      'reports/valid.txt',
    ])
  })

  it('clears a prefix by deleting each listed key', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(
        '<?xml version="1.0"?><ListBucketResult>'
        + '<Contents><Key>reports/one.txt</Key></Contents>'
        + '<Contents><Key>reports/two.txt</Key></Contents>'
        + '</ListBucketResult>',
        { status: 200 },
      ))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await driver.clear('reports')

    expect((fetchMock.mock.calls[1]?.[0] as Request).method).toBe('DELETE')
    expect((fetchMock.mock.calls[2]?.[0] as Request).method).toBe('DELETE')
    expect((fetchMock.mock.calls[1]?.[0] as Request).url).toContain('/reports/one.txt')
    expect((fetchMock.mock.calls[2]?.[0] as Request).url).toContain('/reports/two.txt')
  })

  it('returns empty listings for missing buckets and surfaces request errors', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        text: vi.fn(async () => {
          throw new Error('read failed')
        }),
      })

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys()).resolves.toEqual([])
    await expect(driver.removeItem('reports:broken.txt')).rejects.toThrow(
      '[unstorage] [s3] [DELETE] https://media-bucket.s3.us-east-1.amazonaws.com/reports/broken.txt: 500 Internal Error',
    )
  })

  it('returns an empty key list when the bucket response has no contents', async () => {
    fetchMock.mockResolvedValueOnce(new Response(
      '<?xml version="1.0"?><ListBucketResult></ListBucketResult>',
      { status: 200 },
    ))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })

    await expect(driver.getKeys()).resolves.toEqual([])
  })

  it('handles root-object requests and duplicate query keys when signing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('root', { status: 200 }))

    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://gateway.example.com?x=2&x=1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
      forcePathStyleEndpoint: false,
    })

    await expect(driver.getItem('')).resolves.toBe('root')

    const request = fetchMock.mock.calls[0]?.[0] as Request
    expect(request.url).toBe('https://media-bucket.gateway.example.com/?x=2&x=1')
    expect(request.headers.get('authorization')).toContain('SignedHeaders=')
  })

  it('canonicalizes reserved characters in endpoint path prefixes while signing', async () => {
    fetchMock.mockResolvedValueOnce(new Response('stored', { status: 200 }))

    const accessKeyId = 'AKIAEXAMPLE'
    const secretAccessKey = 'supersecretkey'
    const region = 'us-east-1'
    const createDriver = await loadDriver()
    const driver = createDriver({
      bucket: 'media-bucket',
      region,
      endpoint: 'https://gateway.example.com/storage(1)',
      accessKeyId,
      secretAccessKey,
      forcePathStyleEndpoint: true,
    })

    await driver.getItemRaw('images:photo.jpg')

    const request = fetchMock.mock.calls[0]?.[0] as Request
    const amzDate = request.headers.get('x-amz-date')!
    const scopeDate = amzDate.slice(0, 8)
    const payloadHash = request.headers.get('x-amz-content-sha256')!
    const canonicalHeaders = Array.from(request.headers.entries())
      .filter(([name]) => name.toLowerCase() !== 'authorization')
      .map(([name, value]) => [name.toLowerCase(), value.trim().replace(/\s+/g, ' ')] as const)
      .sort(([leftName], [rightName]) => leftName.localeCompare(rightName))
    const signedHeaders = canonicalHeaders.map(([name]) => name).join(';')
    const url = new URL(request.url)
    const canonicalRequest = [
      'GET',
      '/storage%281%29/media-bucket/images/photo.jpg',
      '',
      canonicalHeaders.map(([name, value]) => `${name}:${value}`).join('\n'),
      '',
      signedHeaders,
      payloadHash,
    ].join('\n')
    const expectedSignature = createHmac('sha256', getSigningKey(secretAccessKey, scopeDate, region))
      .update([
        'AWS4-HMAC-SHA256',
        amzDate,
        `${scopeDate}/${region}/s3/aws4_request`,
        sha256(canonicalRequest),
      ].join('\n'))
      .digest('hex')

    expect(request.url).toBe('https://gateway.example.com/storage(1)/media-bucket/images/photo.jpg')
    expect(request.headers.get('authorization')).toContain(`Signature=${expectedSignature}`)
  })
})
