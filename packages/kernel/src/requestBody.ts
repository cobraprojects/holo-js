export const DEFAULT_MAX_REQUEST_BODY_BYTES = 1024 * 1024

let maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES

export class HoloRequestBodyTooLargeError extends Error {
  readonly status = 413

  constructor(limit: number) {
    super(`[@holo-js/kernel] Request body exceeds the ${limit}-byte limit.`)
    this.name = 'HoloRequestBodyTooLargeError'
  }
}

function resolveLimit(maxBytes: number | undefined): number {
  return maxBytes ?? maxRequestBodyBytes
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  return bytes
}

export async function readBoundedRequestBody(request: Request, maxBytes?: number): Promise<Uint8Array<ArrayBuffer>> {
  const limit = resolveLimit(maxBytes)
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) > limit) {
    throw new HoloRequestBodyTooLargeError(limit)
  }

  if (!request.body) {
    return new Uint8Array(0)
  }

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        throw new HoloRequestBodyTooLargeError(limit)
      }
      chunks.push(value)
    }
  } catch (error) {
    void reader.cancel(error).catch(() => undefined)
    throw error
  }

  return concatChunks(chunks, total)
}

export async function readBoundedRequestText(request: Request, maxBytes?: number): Promise<string> {
  return new TextDecoder().decode(await readBoundedRequestBody(request, maxBytes))
}

export async function readBoundedRequestJson(request: Request, maxBytes?: number): Promise<unknown> {
  return JSON.parse(await readBoundedRequestText(request, maxBytes)) as unknown
}

export async function readBoundedRequestFormData(request: Request, maxBytes?: number): Promise<FormData> {
  const bytes = await readBoundedRequestBody(request, maxBytes)
  return new Response(bytes, { headers: { 'content-type': request.headers.get('content-type') ?? '' } }).formData()
}

export async function readBoundedNodeRequestBody(
  stream: AsyncIterable<Uint8Array | string>,
  maxBytes?: number,
  declaredLength?: string | null,
): Promise<Uint8Array<ArrayBuffer>> {
  const limit = resolveLimit(maxBytes)
  if (declaredLength != null && Number(declaredLength) > limit) {
    throw new HoloRequestBodyTooLargeError(limit)
  }

  const chunks: Uint8Array[] = []
  let total = 0
  for await (const chunk of stream) {
    const bytes = typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
    total += bytes.byteLength
    if (total > limit) {
      throw new HoloRequestBodyTooLargeError(limit)
    }
    chunks.push(bytes)
  }

  return concatChunks(chunks, total)
}

export const requestBodyInternals = Object.freeze({
  configureMaxRequestBodyBytes(bytes: number | undefined): void {
    maxRequestBodyBytes = bytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES
  },
  getMaxRequestBodyBytes(): number {
    return maxRequestBodyBytes
  },
})
