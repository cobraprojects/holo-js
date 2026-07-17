import { describe, expect, it } from 'vitest'
import { createNextRenderableError, normalizeNextClientHttpError } from '../src/client-errors'

describe('Next client errors', () => {
  it('normalizes HTTP errors and preserves non-access statuses as ordinary errors', () => {
    const cause = new Error('upstream')
    const normalized = normalizeNextClientHttpError({ status: 500, message: 'Failure', cause })
    expect(normalized).toMatchObject({ status: 500, message: 'Failure' })
    const rendered = createNextRenderableError(normalized!)
    expect(rendered.message).toBe('Failure')
    expect(rendered.cause).toBe(normalized?.cause)
    expect(rendered).not.toHaveProperty('digest')
  })

  it('marks access errors for the Next render boundary', () => {
    expect(createNextRenderableError({ status: 401, message: 'Sign in', cause: undefined })).toMatchObject({
      message: 'Sign in', digest: 'NEXT_HTTP_ERROR_FALLBACK;401',
    })
  })
})
