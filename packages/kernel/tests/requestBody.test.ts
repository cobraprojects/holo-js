import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  DEFAULT_MAX_UPLOAD_BODY_BYTES,
  requestBodyLimitFor,
  HoloRequestBodyTooLargeError,
  readBoundedNodeRequestBody,
  readBoundedRequestBody,
  readBoundedRequestFormData,
  readBoundedRequestJson,
  readBoundedRequestText,
} from '../src/index'

function streamOf(chunks: readonly Uint8Array[], onPull?: (index: number) => void): ReadableStream<Uint8Array> {
  let index = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      onPull?.(index)
      const chunk = chunks[index++]
      if (chunk) controller.enqueue(chunk)
      else controller.close()
    },
  }, { highWaterMark: 0 })
}

describe('bounded request bodies', () => {
  it('defaults to one mebibyte', () => {
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBe(1024 * 1024)
  })

  it('returns the bytes of a body at the limit', async () => {
    const request = new Request('https://example.test', { method: 'POST', body: new Uint8Array(8) })

    const bytes = await readBoundedRequestBody(request, 8)

    expect(bytes.byteLength).toBe(8)
  })

  it('rejects a declared Content-Length above the limit without reading the stream', async () => {
    let pulls = 0
    const request = new Request('https://example.test', {
      method: 'POST',
      headers: { 'content-length': '9' },
      body: streamOf([new Uint8Array(9)], () => pulls++),
      duplex: 'half',
    } as RequestInit)

    await expect(readBoundedRequestBody(request, 8)).rejects.toMatchObject({ status: 413 })
    expect(pulls).toBe(0)
  })

  it('rejects a streamed body above the limit before reading past it', async () => {
    const pulled: number[] = []
    const request = new Request('https://example.test', {
      method: 'POST',
      body: streamOf(Array.from({ length: 100 }, () => new Uint8Array(4)), index => pulled.push(index)),
      duplex: 'half',
    } as RequestInit)

    const error = await readBoundedRequestBody(request, 10).catch(caught => caught)

    expect(error).toBeInstanceOf(HoloRequestBodyTooLargeError)
    expect(pulled.length).toBeLessThan(5)
  })

  it('returns an empty buffer for a request without a body', async () => {
    const bytes = await readBoundedRequestBody(new Request('https://example.test', { method: 'POST' }), 1)

    expect(bytes.byteLength).toBe(0)
  })

  it('rejects a declared Node Content-Length above the limit before reading', async () => {
    await expect(readBoundedNodeRequestBody(Readable.from([Buffer.alloc(1)]), 10, '11'))
      .rejects.toBeInstanceOf(HoloRequestBodyTooLargeError)
  })

  it('bounds Node request streams the same way', async () => {
    await expect(readBoundedNodeRequestBody(Readable.from([Buffer.alloc(6), Buffer.alloc(6)]), 10))
      .rejects.toBeInstanceOf(HoloRequestBodyTooLargeError)
    await expect(readBoundedNodeRequestBody(Readable.from([Buffer.alloc(4), Buffer.alloc(6)]), 10))
      .resolves.toHaveProperty('byteLength', 10)
  })
})

describe('bounded request body decoding', () => {
  it('decodes JSON, text and form bodies within the limit', async () => {
    await expect(readBoundedRequestJson(new Request('https://example.test', {
      method: 'POST',
      body: '{"name":"query"}',
    }), 64)).resolves.toEqual({ name: 'query' })
    await expect(readBoundedRequestText(new Request('https://example.test', { method: 'POST', body: 'plain' }), 64))
      .resolves.toBe('plain')
    await expect(readBoundedRequestFormData(new Request('https://example.test', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=Guide',
    }), 64).then(form => form.get('title'))).resolves.toBe('Guide')
  })

  it('applies the limit to form bodies', async () => {
    await expect(readBoundedRequestFormData(new Request('https://example.test', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'title=' + 'x'.repeat(64),
    }), 16)).rejects.toBeInstanceOf(HoloRequestBodyTooLargeError)
  })
})

describe('upload body limit', () => {
  it('defaults multipart uploads to eight mebibytes, as PHP post_max_size does', () => {
    expect(DEFAULT_MAX_UPLOAD_BODY_BYTES).toBe(8 * 1024 * 1024)
    expect(requestBodyLimitFor('multipart/form-data; boundary=x')).toBe(DEFAULT_MAX_UPLOAD_BODY_BYTES)
    expect(requestBodyLimitFor('application/json')).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES)
    expect(requestBodyLimitFor(null)).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES)
  })

  it('accepts a multipart upload above one mebibyte and below the upload limit', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: new Uint8Array(2 * 1024 * 1024 + 1),
    })

    await expect(readBoundedRequestBody(request)).resolves.toHaveProperty('byteLength', 2 * 1024 * 1024 + 1)
  })

  it('rejects a multipart upload above the upload limit', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: new Uint8Array(DEFAULT_MAX_UPLOAD_BODY_BYTES + 1),
    })

    await expect(readBoundedRequestBody(request)).rejects.toMatchObject({ status: 413 })
  })

  it('keeps the request body limit for non-multipart bodies', async () => {
    const request = new Request('https://example.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new Uint8Array(DEFAULT_MAX_REQUEST_BODY_BYTES + 1),
    })

    await expect(readBoundedRequestBody(request)).rejects.toMatchObject({ status: 413 })
  })
})
