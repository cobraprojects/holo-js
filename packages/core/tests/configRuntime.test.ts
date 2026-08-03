import { describe, expect, it, vi } from 'vitest'
import { configRuntimeInternals, loadInstalledFeatureConfigContributions } from '../src/portable/configRuntime'

describe('@holo-js/core config contribution composition', () => {
  it('loads every installed feature contribution directly', async () => {
    const loadDirect = vi.fn(async (_specifier: string) => {})
    const loadOptional = vi.fn(async () => undefined)

    await loadInstalledFeatureConfigContributions('/project', {
      loadDirect,
      loadOptional,
    })

    expect(loadDirect.mock.calls.map(([specifier]) => specifier)).toEqual(
      configRuntimeInternals.featureConfigContributionSpecifiers,
    )
    expect(loadDirect).toHaveBeenCalledWith('@holo-js/media/config', '/project')
    expect(loadOptional).not.toHaveBeenCalled()
  })

  it('falls back to project resolution and tolerates absent optional features', async () => {
    const loadDirect = vi.fn(async (_specifier: string) => {
      throw new Error('direct resolution failed')
    })
    const loadOptional = vi.fn(async (specifier: string) => {
      return specifier === '@holo-js/auth/config' ? {} : undefined
    })

    await expect(loadInstalledFeatureConfigContributions('/project', {
      loadDirect,
      loadOptional,
    })).resolves.toBeUndefined()
    expect(loadOptional).toHaveBeenCalledTimes(configRuntimeInternals.featureConfigContributionSpecifiers.length)
    expect(loadOptional).toHaveBeenCalledWith('@holo-js/auth/config', '/project')
  })
})
