import { afterEach, describe, expect, it } from 'vitest'
import {
  composeRegisteredConfig,
  configRegistryInternals,
  loaderInternals,
  registerConfigNormalizer,
  resetConfigNormalizers,
} from '../src'

describe('@holo-js/config registry composition', () => {
  afterEach(() => {
    resetConfigNormalizers()
  })

  it('orders normalizers by dependencies and exposes composed values', () => {
    registerConfigNormalizer<{ value: string }, { readonly value: string }>({
      name: 'second',
      dependencies: ['first', 'first'],
      normalize(value, context) {
        expect(context.values.first).toEqual({ value: 'one' })
        expect(context.has('second')).toBe(true)
        expect(context.has('missing')).toBe(false)
        return Object.freeze({
          value: `${context.get<{ readonly value: string }>('first')?.value}:${value?.value}`,
        })
      },
    })
    registerConfigNormalizer<{ value: string }, { readonly value: string }>({
      name: 'first',
      normalize(value) {
        return Object.freeze({ value: value?.value ?? 'missing' })
      },
    })

    expect(configRegistryInternals.getRegisteredNames()).toEqual(['first', 'second'])
    expect(composeRegisteredConfig({
      first: { value: 'one' },
      second: { value: 'two' },
    }, {})).toEqual({
      first: { value: 'one' },
      second: { value: 'one:two' },
    })
  })

  it('validates names, unresolved dependencies, and registration cleanup', () => {
    expect(() => registerConfigNormalizer({
      name: '   ',
      normalize: () => ({}),
    })).toThrow('normalizer names must be non-empty')

    const unregisterFirst = registerConfigNormalizer({
      name: 'service',
      normalize: () => ({ version: 1 }),
    })
    const unregisterSecond = registerConfigNormalizer({
      name: 'service',
      normalize: () => ({ version: 2 }),
    })
    unregisterFirst()
    expect(composeRegisteredConfig({}, {})).toEqual({ service: { version: 2 } })
    unregisterSecond()
    expect(configRegistryInternals.getRegisteredNames()).toEqual([])

    registerConfigNormalizer({
      name: 'blocked',
      dependencies: ['missing'],
      normalize: () => ({}),
    })
    expect(() => composeRegisteredConfig({}, {})).toThrow('unresolved dependencies: blocked')
  })

  it('reads cache normalizer metadata across cache versions', () => {
    expect(loaderInternals.getNormalizerConfigNames({})).toEqual([])
    expect(loaderInternals.getNormalizerConfigNames({ normalizerConfigNames: ['database'] })).toEqual(['database'])
  })
})
