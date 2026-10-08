import { describe, expectTypeOf, it } from 'vitest'
import { type HoloRuntime, holoRuntimeInternals } from '../src/portable'
import type { HoloAdapterProjectAccessors } from '../src/adapter'
import type { LoadedHoloConfig } from '@holo-js/config'

type CustomConfig = {
  services: {
    mailgun: {
      secret: string
    }
  }
}

describe('@holo-js/core runtime typing', () => {
  it('infers concrete session records through runtime and framework accessors', () => {
    const rotateSession = async (runtime: HoloRuntime) => {
      const record = await runtime.session?.rotate('session-id', {
        data: { userId: 'user-1' },
        renewLifetime: true,
      })
      return record?.expiresAt
    }
    const createSession = async (accessors: HoloAdapterProjectAccessors) => {
      const session = await accessors.getSession()
      const record = await session?.create({ name: 'message', value: { text: 'hello' } })
      return record?.id
    }

    expectTypeOf(rotateSession).returns.toEqualTypeOf<Promise<Date | undefined>>()
    expectTypeOf(createSession).returns.toEqualTypeOf<Promise<string | undefined>>()
  })

  it('infers concrete token and multi-factor records from core persistence', () => {
    const readToken = async (config: LoadedHoloConfig) => {
      const stores = await holoRuntimeInternals.createCoreAuthPersistence('/project', config)
      const token = await stores.tokens.findById('token-id')
      return token?.abilities
    }
    const readRecoveryCodes = async (config: LoadedHoloConfig) => {
      const stores = await holoRuntimeInternals.createCoreAuthPersistence('/project', config)
      const credential = await stores.multiFactor.find('users', 'user-1')
      return credential?.recoveryCodeHashes
    }

    expectTypeOf(readToken).returns.toEqualTypeOf<Promise<readonly string[] | undefined>>()
    expectTypeOf(readRecoveryCodes).returns.toEqualTypeOf<Promise<readonly string[] | undefined>>()

    const redeemVerification = async (config: LoadedHoloConfig) => {
      const persistence = await holoRuntimeInternals.createCoreAuthPersistence('/project', config)
      const record = await persistence.emailVerificationTokens.findById('verification-id')
      if (!record) return null
      return persistence.emailVerificationTokens.redeem(record, async () => ({ verified: true as const }))
    }
    const redeemReset = async (config: LoadedHoloConfig) => {
      const persistence = await holoRuntimeInternals.createCoreAuthPersistence('/project', config)
      const record = await persistence.passwordResetTokens.findById('reset-id')
      if (!record) return null
      return persistence.passwordResetTokens.redeem(record, async () => ({ passwordChanged: true as const }))
    }

    expectTypeOf(redeemVerification).returns.toEqualTypeOf<Promise<{ verified: true } | null>>()
    expectTypeOf(redeemReset).returns.toEqualTypeOf<Promise<{ passwordChanged: true } | null>>()
    expectTypeOf(redeemVerification).returns.not.toEqualTypeOf<Promise<{ passwordChanged: true } | null>>()
    expectTypeOf(redeemReset).returns.not.toEqualTypeOf<Promise<{ verified: true } | null>>()
  })

  it('preserves inference for runtime config accessors', () => {
    type ServicesResult = HoloRuntime<CustomConfig> extends {
      useConfig: (key: 'services') => infer TResult
    }
      ? TResult
      : never
    type NestedUseConfigResult = HoloRuntime<CustomConfig> extends {
      useConfig: (path: 'services.mailgun.secret') => infer TResult
    }
      ? TResult
      : never
    type SecretResult = HoloRuntime<CustomConfig> extends {
      config: (path: 'services.mailgun.secret') => infer TResult
    }
      ? TResult
      : never

    const services: ServicesResult = {
      mailgun: {
        secret: 'secret',
      },
    }
    const nestedUseConfigSecret: NestedUseConfigResult = 'secret'
    const secret: SecretResult = 'secret'

    void services
    void nestedUseConfigSecret
    void secret
  })
})
