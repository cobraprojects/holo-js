import type { DatabaseQueryPredicateObservation } from './predicate-matching'

export type DatabaseQueryObservation = {
  readonly connectionName: string
  readonly dependencies: readonly string[]
  readonly predicates: readonly DatabaseQueryPredicateObservation[]
  readonly primaryKey?: string
  readonly tableName: string
}

export type DatabaseQueryRead = DatabaseQueryObservation & {
  readonly observedResult?: unknown
  readonly result?: unknown
  readonly serializedSources?: readonly unknown[]
}
