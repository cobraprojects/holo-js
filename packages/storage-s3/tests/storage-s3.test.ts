import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import createS3Driver from '../src'

describe('@holo-js/storage-s3', () => {
  const createDriver = () => {
    return createS3Driver({
      bucket: 'media-bucket',
      region: 'us-east-1',
      endpoint: 'https://s3.us-east-1.amazonaws.com',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'supersecretkey',
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-03-30T00:00:00.000Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('signs requests for object uploads', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const driver = createDriver()

    await driver.setItemRaw('reports:daily.txt', new TextEncoder().encode('ok'))

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined
    const request = firstCall?.[0] as unknown as Request
    expect(request.headers.get('authorization')).toContain('AWS4-HMAC-SHA256')
    expect(request.url).toContain('/reports/daily.txt')
  })

  it('supports buffer-backed payload uploads', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input)
      expect(await request.text()).toBe('buffer-ok')
      return new Response(null, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const driver = createDriver()

    await driver.setItemRaw('reports:buffer.txt', Buffer.from('buffer-ok'))

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined
    const request = firstCall?.[0] as unknown as Request
    expect(request.url).toContain('/reports/buffer.txt')
  })

  it('signs list requests with AWS canonical query encoding', async () => {
    const fetchMock = vi.fn(async () => {
      const response = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<ListBucketResult>',
        '</ListBucketResult>',
      ].join('')

      return new Response(response, { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const driver = createDriver()

    await expect(driver.getKeys('reports*\'(!)')).resolves.toEqual([])

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined
    const request = firstCall?.[0] as unknown as Request
    expect(request.url).toContain('prefix=reports*%27%28%21%29')
    expect(request.headers.get('authorization')).toBe([
      'AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260330/us-east-1/s3/aws4_request,',
      'SignedHeaders=host;x-amz-content-sha256;x-amz-date,',
      'Signature=62dc0343ca80050302df7c5e449ff75bb50a409623a73e24d64400926b3891e7',
    ].join(' '))
  })

  it('round-trips string values that look like JSON', async () => {
    const objects = new Map<string, string>()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const request = input instanceof Request ? input : new Request(input)

      if (request.method === 'PUT') {
        objects.set(request.url, await request.text())
        return new Response(null, { status: 200 })
      }

      return new Response(objects.get(request.url) ?? '', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const driver = createDriver()
    const values = ['123', 'true', 'null', '[]', '{"active":true}'] as const

    for (const [index, value] of values.entries()) {
      await driver.setItem(`values/${index}`, value)
      await expect(driver.getItem(`values/${index}`)).resolves.toBe(value)
    }

    await driver.setItem('values/number', 123)
    await driver.setItem('values/object', { active: true })

    await expect(driver.getItem('values/number')).resolves.toBe(123)
    await expect(driver.getItem('values/object')).resolves.toEqual({ active: true })
  })

  it('rejects raw uploads with period-only object key segments', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const driver = createDriver()

    await expect(driver.setItemRaw('tenant:..:admin.txt', new TextEncoder().encode('x')))
      .rejects.toThrow('S3 object keys cannot contain period-only path segments')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects deletes with period-only object key segments', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const driver = createDriver()

    await expect(driver.removeItem('tenant:.:admin.txt'))
      .rejects.toThrow('S3 object keys cannot contain period-only path segments')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not clear listed keys with period-only object key segments', async () => {
    const listResponse = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<ListBucketResult>',
      '<Contents><Key>tenant/../admin.txt</Key></Contents>',
      '</ListBucketResult>',
    ].join('')
    const fetchMock = vi.fn(async () => new Response(listResponse, { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const driver = createDriver()

    await expect(driver.clear('tenant')).rejects
      .toThrow('S3 object keys cannot contain period-only path segments')
    expect(fetchMock).toHaveBeenCalledOnce()

    const firstCall = fetchMock.mock.calls[0] as unknown[] | undefined
    const request = firstCall?.[0] as unknown as Request
    expect(request.method).toBe('GET')
    expect(request.url).not.toContain('/admin.txt')
  })
})
