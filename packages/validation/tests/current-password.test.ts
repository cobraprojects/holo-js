import { describe, expect, it } from 'vitest'
import { field, safeParse, schema, ValidationContractError } from '../src'

describe('currentPassword validation contract', () => {
  it('requires a server auth runtime instead of silently accepting a password', async () => {
    await expect(safeParse({ credential: 'secret' }, schema({ credential: field.string().currentPassword() })))
      .rejects.toThrow('currentPassword requires a configured server auth runtime.')
  })

  it('preserves optional, nullable, required and type validation without invoking auth for absent or invalid values', async () => {
    const contract = schema({
      optional: field.password().currentPassword().optional(),
      nullable: field.string().currentPassword().nullable(),
    })
    expect((await safeParse({ nullable: null }, contract)).valid).toBe(true)
    const required = schema({ credential: field.password().required().currentPassword() })
    expect((await safeParse({ credential: '' }, required)).errors.get('credential')).toEqual(['This field is required.'])
    expect((await safeParse({ credential: 123 }, required)).valid).toBe(false)
  })

  it('rejects unsupported field kinds and empty guard names at schema construction', () => {
    expect(() => field.number().currentPassword()).toThrow(ValidationContractError)
    expect(() => field.string().currentPassword(' ')).toThrow(ValidationContractError)
  })
})
