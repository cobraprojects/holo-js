import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createFormClient: vi.fn(),
  runWatch: true,
  onCleanup: vi.fn(),
  onScopeDispose: vi.fn(),
  stop: vi.fn(),
}))

vi.mock('vue', () => ({
  reactive: <TValue>(value: TValue) => value,
  shallowRef: <TValue>(value: TValue) => ({ value }),
  watchEffect: (callback: (onCleanup: (cleanup: () => void) => void) => void) => {
    if (mocks.runWatch) callback(mocks.onCleanup)
    return mocks.stop
  },
  onScopeDispose: mocks.onScopeDispose,
}))

vi.mock('#app', () => ({ useCookie: () => ({ value: null }) }))
vi.mock('@holo-js/forms/internal/client', () => ({ createFormClient: mocks.createFormClient }))

const { useForm } = await import('../src/runtime/composables/forms')

describe('Nuxt useForm facade', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.runWatch = true
  })

  it('delegates reactive form state and operations to the active form client', async () => {
    const unsubscribe = vi.fn()
    const form = {
      fields: { email: {} }, values: { email: 'ava@app.test' }, errors: {}, submitting: false, valid: true,
      lastSubmission: { ok: true }, subscribe: vi.fn(() => unsubscribe), validate: vi.fn(async () => true),
      validateField: vi.fn(async () => true), submit: vi.fn(async () => ({ ok: false, status: 422 })),
      reset: vi.fn(), setValue: vi.fn(async () => undefined), applyServerState: vi.fn(() => 'applied'),
    }
    mocks.createFormClient.mockReturnValue(form)
    const result = useForm({} as never)
    expect(result.fields).toBe(form.fields)
    expect(result.errors).toBe(form.errors)
    expect(result.submitting).toBe(false)
    expect(result.valid).toBe(true)
    expect(result.lastSubmission).toBe(form.lastSubmission)
    expect(result.subscribe(vi.fn())).toBe(unsubscribe)
    await expect(result.validate()).resolves.toBe(true)
    await expect(result.validateField('email')).resolves.toBe(true)
    await expect(result.submit()).resolves.toEqual({ ok: false, status: 422 })
    result.reset({ email: 'next@app.test' } as never)
    await result.setValue('email', 'next@app.test')
    expect(result.applyServerState({} as never)).toBe('applied')
    expect(mocks.onCleanup).toHaveBeenCalledWith(unsubscribe)
    expect(mocks.onScopeDispose).toHaveBeenCalledWith(mocks.stop)
  })

  it('rejects facade access before a form client is initialized', () => {
    mocks.runWatch = false
    const result = useForm({} as never)
    expect(() => result.fields).toThrow('Expected form to be initialized')
  })
})
