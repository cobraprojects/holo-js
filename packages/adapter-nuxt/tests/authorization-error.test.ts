import { describe, expect, it, vi } from 'vitest'

const createError = vi.fn((input: { statusCode: number, statusMessage: string }) => Object.assign(new Error(input.statusMessage), input))
vi.mock('h3', () => ({ createError }))

const { createNuxtAuthorizationError } = await import('../src/runtime/authorization-error')

describe('Nuxt authorization errors', () => {
  it('maps not-found and forbidden decisions with default and explicit messages', () => {
    expect(createNuxtAuthorizationError({ status: 404 })).toMatchObject({ statusCode: 404, statusMessage: 'You are not authorized to perform this action.' })
    expect(createNuxtAuthorizationError({ status: 403, message: 'Denied' })).toMatchObject({ statusCode: 403, statusMessage: 'Denied' })
  })
})
