import { describe, expect, it } from 'vitest'
import {
  normalizeAccessTokenRecord,
  normalizeEmailVerificationTokenRecord,
  normalizePasswordResetTokenRecord,
  serializeAccessTokenRecord,
  serializeEmailVerificationTokenRecord,
  serializePasswordResetTokenRecord,
} from '../src/portable/authPersistence'

describe('auth persistence serialization', () => {
  it('normalizes and serializes access tokens', () => {
    const normalized = normalizeAccessTokenRecord({
      id: 1,
      provider: 'users',
      user_id: 2,
      name: 'browser',
      abilities: '["read"]',
      token_hash: 'hash',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: '2026-01-02T00:00:00.000Z',
      expires_at: '2026-02-01T00:00:00.000Z',
    })

    expect(normalized.abilities).toEqual(['read'])
    expect(serializeAccessTokenRecord(normalized)).toMatchObject({
      user_id: '2',
      abilities: '["read"]',
      last_used_at: '2026-01-02T00:00:00.000Z',
    })

    const malformed = normalizeAccessTokenRecord({
      id: '2',
      provider: 'users',
      user_id: '3',
      name: 'api',
      abilities: 'invalid',
      token_hash: 'hash',
      created_at: new Date('2026-01-01T00:00:00.000Z'),
    })
    expect(malformed.abilities).toEqual([])
    expect(serializeAccessTokenRecord(malformed)).toMatchObject({ last_used_at: null, expires_at: null })
  })

  it('normalizes and serializes verification and password reset tokens', () => {
    const verification = normalizeEmailVerificationTokenRecord({
      id: 1,
      provider: 'users',
      user_id: 2,
      email: 'user@example.com',
      token_hash: 'verification',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    })
    expect(serializeEmailVerificationTokenRecord(verification)).toMatchObject({
      user_id: '2',
      used_at: null,
    })

    const reset = normalizePasswordResetTokenRecord({
      id: 1,
      email: 'user@example.com',
      __holo_table: 'password_reset_tokens',
      token_hash: 'reset',
      created_at: '2026-01-01T00:00:00.000Z',
      expires_at: '2026-01-02T00:00:00.000Z',
    })
    expect(reset).toMatchObject({ provider: 'users', table: 'password_reset_tokens' })
    expect(serializePasswordResetTokenRecord(reset)).toMatchObject({ provider: 'users', used_at: null })

    expect(normalizePasswordResetTokenRecord({
      ...reset,
      provider: 'admins',
      __holo_table: 1,
      token_hash: reset.tokenHash,
      created_at: reset.createdAt,
      expires_at: reset.expiresAt,
    })).toMatchObject({ provider: 'admins', table: undefined })
  })
})
