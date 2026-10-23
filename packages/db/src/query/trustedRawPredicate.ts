import type { QueryRawPredicate } from './ast'

const trustedRawPredicates = new WeakSet<QueryRawPredicate>()

export function createTrustedRawPredicate(predicate: Omit<QueryRawPredicate, 'trusted'>): QueryRawPredicate {
  const created: QueryRawPredicate = Object.freeze({ ...predicate })
  trustedRawPredicates.add(created)
  return created
}

export function isTrustedRawPredicate(predicate: QueryRawPredicate): boolean {
  return trustedRawPredicates.has(predicate)
}
