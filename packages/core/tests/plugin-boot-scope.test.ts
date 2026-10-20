import { describe, expect, it, vi } from 'vitest'
import * as firstCopy from '../src/portable/pluginRuntime'

describe('plugin boot scope across core copies', () => {
  it('detects a boot hook running under one core copy from a guard in another copy', async () => {
    vi.resetModules()
    const secondCopy = await import('../src/portable/pluginRuntime')
    expect(secondCopy).not.toBe(firstCopy)

    let detected: unknown
    await firstCopy.bootConfiguredHoloPluginModule('/tmp/holo-boot-scope-project', {} as never, {
      plugin: { packageName: 'holo-plugin-boot-scope' },
      runtime: './boot.mjs',
      module: {
        default: () => {
          try {
            secondCopy.assertOutsidePluginBoot('Shared boot guard')
          } catch (error) {
            detected = error
          }
        },
      },
    } as never)

    expect(detected).toBeInstanceOf(Error)
    expect((detected as Error).message).toMatch(/Shared boot guard cannot run inside a plugin boot hook/)
  })
})
