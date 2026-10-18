import { readFile } from 'node:fs/promises'
import { isHttpError } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'
import { field, isValidationException, schema, validate, serializeValidationException } from '@holo-js/validation'
import { adapterSvelteKitInternals, runWithSvelteKitRequestEvent } from '../src'

describe('native validation exceptions', () => {
  it('keeps image field failures readable after SvelteKit wraps them', async () => {
    adapterSvelteKitInternals.registerValidationExceptionThrower()
    const bytes = await readFile(new URL('../../validation/tests/fixtures/images/valid.png', import.meta.url))
    const file = new File([bytes], 'avatar.png', { type: 'image/png' })
    const event = {
      request: new Request('https://app.test/api/avatar', { method: 'POST' }),
      url: new URL('https://app.test/api/avatar'),
      cookies: { get: () => undefined, set() {} },
    }
    const failure = await runWithSvelteKitRequestEvent(event, () => validate(
      { file, title: 'Profile' },
      schema({ file: field.file().image().imageAspectRatio('1:1'), title: field.string() }),
      { bag: 'avatar' },
    )).catch((error: unknown) => error)

    expect(isHttpError(failure, 422)).toBe(true)
    expect(isValidationException(failure)).toBe(false)
    expect(serializeValidationException(failure)).toMatchObject({
      status: 422,
      bag: 'avatar',
      values: { title: 'Profile' },
      errors: { file: ['The selected image must have an allowed aspect ratio.'] },
    })
  })
})
