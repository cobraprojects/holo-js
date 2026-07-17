import { describe, expect, it, vi } from 'vitest'
import { adapterNextClientInternals } from '../src/client'

describe('Next client internals', () => {
  it('recognizes redirect errors across object and function values', () => {
    expect(adapterNextClientInternals.isNextRedirectError(null)).toBe(false)
    expect(adapterNextClientInternals.isNextRedirectError(() => undefined)).toBe(false)
    const redirect = Object.assign(() => undefined, { digest: 'NEXT_REDIRECT;replace;/dashboard' })
    expect(adapterNextClientInternals.isNextRedirectError(redirect)).toBe(true)
  })

  it('requires a submitter and rethrows ordinary failures', async () => {
    const optionsRef: { current: { submitter?: (context: { values: Record<string, unknown> }) => Promise<unknown> } } = {
      current: {},
    }
    const onHttpError = vi.fn()
    const bridge = adapterNextClientInternals.createSubmitterBridge(optionsRef as never, onHttpError)
    await expect(bridge({ values: {} } as never)).rejects.toThrow('Expected submitter')
    optionsRef.current.submitter = async () => { throw new Error('ordinary') }
    await expect(bridge({ values: {} } as never)).rejects.toThrow('ordinary')
    expect(onHttpError).not.toHaveBeenCalled()
  })
})
