import { describe, expect, it } from 'vitest'
import { field, schema, validate, validationInternals } from '../src'

async function captureFailure(input: Parameters<typeof validate>[0], definition: Parameters<typeof validate>[1]) {
  try {
    await validate(input, definition)
  } catch (error) {
    return error
  }

  throw new Error('Expected validation to fail.')
}

describe('sensitive input in validation failures', () => {
  it('strips passwords and sensitive fields from thrown failures at every depth', async () => {
    const registration = schema({
      email: field.string().required().email(),
      password: field.password().required(),
      current_password: field.string(),
      apiKey: field.string().sensitive(),
      profile: {
        nationalId: field.string().sensitive(),
        password: field.string(),
        city: field.string(),
      },
      accounts: field.array({
        login: field.string(),
        password: field.string(),
        pin: field.string().sensitive(),
        devices: field.array({
          name: field.string(),
          secret: field.string().sensitive(),
          password_confirmation: field.string(),
        }),
      }),
      recoveryCodes: field.array(field.string().sensitive()),
      tags: field.array(field.string()),
    })

    const error = await captureFailure({
      email: 'invalid',
      password: 'top-password',
      current_password: 'old-password',
      apiKey: 'api-key-value',
      profile: { nationalId: 'national-id', password: 'profile-password', city: 'Cairo' },
      accounts: [{
        login: 'ava',
        password: 'account-password',
        pin: 'account-pin',
        devices: [{ name: 'phone', secret: 'device-secret', password_confirmation: 'device-password' }],
      }],
      recoveryCodes: ['recovery-one', 'recovery-two'],
      tags: ['first'],
    }, registration)

    const expected = {
      email: 'invalid',
      profile: { city: 'Cairo' },
      accounts: [{ login: 'ava', devices: [{ name: 'phone' }] }],
      tags: ['first'],
    }
    const payload = validationInternals.serializeValidationException(error)
    expect(payload?.values).toEqual(expected)
    expect((error as { readonly values: unknown }).values).toEqual(expected)
    const serialized = JSON.stringify(error)
    for (const secret of ['top-password', 'old-password', 'api-key-value', 'national-id', 'profile-password', 'account-password', 'account-pin', 'device-secret', 'device-password', 'recovery-one']) {
      expect(serialized).not.toContain(secret)
    }
  })
})
