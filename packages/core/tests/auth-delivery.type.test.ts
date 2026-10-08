import { expectTypeOf, it } from 'vitest'
import { holoRuntimeInternals } from '../src/portable/holo'

it('retains concrete Auth delivery inputs and asynchronous completion', () => {
  const delivery = holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail() {} }, 'https://example.com')
  type VerificationInput = Parameters<typeof delivery.sendEmailVerification>[0]
  type ResetInput = Parameters<typeof delivery.sendPasswordReset>[0]
  expectTypeOf<VerificationInput['email']>().toEqualTypeOf<string>()
  expectTypeOf<VerificationInput['provider']>().toEqualTypeOf<string>()
  expectTypeOf<VerificationInput['token']>().toEqualTypeOf<{
    readonly id: string
    readonly plainTextToken: string
    readonly expiresAt: Date
  }>()
  expectTypeOf<ResetInput['broker']>().toEqualTypeOf<string>()
  expectTypeOf<ResetInput['route']>().toEqualTypeOf<string>()
  expectTypeOf(delivery.sendEmailVerification).returns.toEqualTypeOf<Promise<void>>()
  expectTypeOf(delivery.sendPasswordReset).returns.toEqualTypeOf<Promise<void>>()
  expectTypeOf<ReturnType<typeof holoRuntimeInternals.createAuthNotificationsDeliveryHook>>().toEqualTypeOf<typeof delivery>()
})

function rejectInvalidAuthDeliveryInputs() {
  const delivery = holoRuntimeInternals.createAuthMailDeliveryHook({ async sendMail() {} }, 'https://example.com')
  const input = { provider: 'users', email: 'ava@example.com', token: { id: 'id', plainTextToken: 'token', expiresAt: new Date() }, route: '/reset' }
  // @ts-expect-error Password reset requires its broker
  void delivery.sendPasswordReset(input)
  // @ts-expect-error Email verification requires its user
  void delivery.sendEmailVerification(input)
  // @ts-expect-error Token expiration must be a Date
  void delivery.sendPasswordReset({ ...input, broker: 'users', token: { ...input.token, expiresAt: 'tomorrow' } })
  // @ts-expect-error Email routes remain strings
  void delivery.sendEmailVerification({ ...input, user: { name: 'Ava' }, route: 42 })
}

void rejectInvalidAuthDeliveryInputs
