import type { AuthSessionIdentity, AuthSessionRevocationStore } from '@holo-js/auth'
import { DB, TableQueryBuilder } from '@holo-js/db'

function identityKey(identity: AuthSessionIdentity): string {
  return JSON.stringify([identity.provider, String(identity.userId)])
}

export function createCoreSessionRevocationStore(): AuthSessionRevocationStore {
  return {
    async readMany(identities) {
      const distinct = [...new Map(identities.map(identity => [identityKey(identity), identity])).values()]
      if (!distinct.length) return []
      const rows = await DB.table('auth_session_revocations').where(query => {
        for (const identity of distinct) {
          query = query.orWhere(match => match.where('provider', identity.provider).where('user_id', String(identity.userId)))
        }
        return query
      }).get<{ provider: string, user_id: string, generation: number, retained_session_id: string | null }>()
      const states = new Map(rows.map(row => [identityKey({ provider: row.provider, userId: row.user_id }), row]))
      return distinct.map(identity => {
        const row = states.get(identityKey(identity))
        return {
          ...identity,
          generation: row ? row.generation : 0,
          ...(row?.retained_session_id ? { retainedSessionId: row.retained_session_id } : {}),
        }
      })
    },
    async revokeOthers(identity, currentSession) {
      return DB.connection().writeTransaction(async connection => {
        if (currentSession.generation === 0) {
          await new TableQueryBuilder('auth_session_revocations', connection).insertOrIgnore({
            provider: identity.provider,
            user_id: String(identity.userId),
            generation: 0,
            retained_session_id: null,
          })
        }
        const bindings = [currentSession.id, identity.provider, String(identity.userId), currentSession.generation, currentSession.id]
        const dialect = connection.getDialect()
        const result = await connection.executeCompiled({
          sql: `UPDATE auth_session_revocations SET generation = generation + 1, retained_session_id = ${dialect.createPlaceholder(1)} WHERE provider = ${dialect.createPlaceholder(2)} AND user_id = ${dialect.createPlaceholder(3)} AND (generation = ${dialect.createPlaceholder(4)} OR retained_session_id = ${dialect.createPlaceholder(5)})`,
          bindings,
          source: 'auth_session_revocations',
        })
        return result.affectedRows === 1
      })
    },
  }
}
