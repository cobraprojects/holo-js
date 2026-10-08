import { expectTypeOf, it } from 'vitest'
import { defineConfig, env, type loadConfigDirectory } from '../src'

it('preserves concrete environment and config callback inference', () => {
  const config = defineConfig({
    owner: env('OWNER'),
    retries: env<number>('RETRIES', 3),
    enabled: env<boolean>('ENABLED', true),
    later: () => env('OWNER'),
  })

  expectTypeOf(config).toEqualTypeOf<Readonly<{
    owner: string
    retries: number
    enabled: boolean
    later: () => string
  }>>()
  expectTypeOf<Awaited<ReturnType<typeof loadConfigDirectory<{ services: typeof config }>>>['custom']['services']>()
    .toEqualTypeOf<typeof config>()

  // @ts-expect-error Numeric environment fallbacks must retain a numeric result.
  const retries: string = config.retries
  // @ts-expect-error Config callbacks must retain their concrete string return.
  const later: () => boolean = config.later
  void retries
  void later
})
