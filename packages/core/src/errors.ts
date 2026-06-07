export type HoloHttpErrorStatus =
  | 400
  | 401
  | 402
  | 403
  | 404
  | 405
  | 406
  | 407
  | 408
  | 409
  | 410
  | 411
  | 412
  | 413
  | 414
  | 415
  | 416
  | 417
  | 418
  | 421
  | 422
  | 423
  | 424
  | 425
  | 426
  | 428
  | 429
  | 431
  | 451
  | 500
  | 501
  | 502
  | 503
  | 504
  | 505
  | 506
  | 507
  | 508
  | 510
  | 511

export type NormalizedHoloHttpError = {
  readonly status: HoloHttpErrorStatus
  readonly message: string
  readonly code?: string
  readonly cause: unknown
}

const httpStatuses = new Set<number>([
  400,
  401,
  402,
  403,
  404,
  405,
  406,
  407,
  408,
  409,
  410,
  411,
  412,
  413,
  414,
  415,
  416,
  417,
  418,
  421,
  422,
  423,
  424,
  425,
  426,
  428,
  429,
  431,
  451,
  500,
  501,
  502,
  503,
  504,
  505,
  506,
  507,
  508,
  510,
  511,
])

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object'
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function readStatus(error: unknown): number | undefined {
  if (!isObject(error)) {
    return undefined
  }

  const directStatus = readNumber(error.status)
  if (directStatus) {
    return directStatus
  }

  const statusCode = readNumber(error.statusCode)
  if (statusCode) {
    return statusCode
  }

  const digest = readString(error.digest)
  const nextHttpStatus = digest?.match(/^NEXT_HTTP_ERROR_FALLBACK;(\d{3})$/)?.[1]
  return nextHttpStatus ? Number(nextHttpStatus) : undefined
}

function readMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message
  }

  if (isObject(error)) {
    const message = readString(error.message)
    if (message) {
      return message
    }

    const statusText = readString(error.statusText)
    if (statusText) {
      return statusText
    }
  }

  return 'An unexpected error occurred.'
}

function readCode(error: unknown): string | undefined {
  return isObject(error) ? readString(error.code) : undefined
}

export function isHoloHttpErrorStatus(status: number): status is HoloHttpErrorStatus {
  return httpStatuses.has(status)
}

export function normalizeHoloHttpError(error: unknown): NormalizedHoloHttpError | undefined {
  const status = readStatus(error)

  if (!status || !isHoloHttpErrorStatus(status)) {
    return undefined
  }

  return {
    status,
    message: readMessage(error),
    code: readCode(error),
    cause: error,
  }
}
