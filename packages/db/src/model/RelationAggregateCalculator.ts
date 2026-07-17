import type { DatabaseQueryAggregateObservation } from '../cache'
import { DatabaseError } from '../core/errors'
import { createAggregateValueCounts } from '../query/aggregateValueCounts'
import type { Entity } from './Entity'
import type { RelationAggregateKind } from './types'

export type RelationAggregateDefinition = {
  readonly relation: string
  readonly kind: RelationAggregateKind
  readonly column?: string
  readonly alias?: string
}

export type RelationAggregateComputation = {
  readonly metadata?: DatabaseQueryAggregateObservation
  readonly value: number | null
}

export class RelationAggregateCalculator {
  getAttributeKey(aggregate: RelationAggregateDefinition): string {
    if (aggregate.alias) return aggregate.alias
    if (aggregate.kind === 'count' || aggregate.kind === 'exists') {
      return `${aggregate.relation}_${aggregate.kind}`
    }
    return `${aggregate.relation}_${aggregate.kind}_${aggregate.column}`
  }

  computeValue(
    kind: Exclude<RelationAggregateKind, 'count' | 'exists'>,
    entities: readonly Entity[],
    column: string,
  ): RelationAggregateComputation {
    const values = entities.map(entity => entity.toAttributes()[column as keyof ReturnType<typeof entity.toAttributes>])
    const numbers = values.map(value => this.requireNumericValue(value, kind, column))

    switch (kind) {
      case 'sum':
        return Object.freeze({ value: numbers.reduce((sum, value) => sum + value, 0) })
      case 'avg': {
        const sum = numbers.reduce((total, value) => total + value, 0)
        const metadata = Object.freeze({ column, count: numbers.length, kind, sum })
        return Object.freeze({ metadata, value: numbers.length === 0 ? null : sum / numbers.length })
      }
      case 'min':
      case 'max':
        return this.computeExtremeValue(kind, column, numbers)
    }
  }

  private computeExtremeValue(
    kind: 'min' | 'max',
    column: string,
    numbers: readonly number[],
  ): RelationAggregateComputation {
    const value = numbers.length === 0
      ? null
      : kind === 'min' ? Math.min(...numbers) : Math.max(...numbers)
    const metadata = Object.freeze({
      column,
      currentValueCount: typeof value === 'number'
        ? numbers.filter(number => number === value).length
        : 0,
      kind,
      valueCounts: createAggregateValueCounts(numbers),
    })
    return Object.freeze({ metadata, value })
  }

  private requireNumericValue(
    value: unknown,
    kind: Exclude<RelationAggregateKind, 'count' | 'exists'>,
    column: string,
  ): number {
    if (typeof value !== 'number' || Number.isNaN(value)) {
      throw new DatabaseError(`Relation aggregate "${kind}" requires numeric values for column "${column}".`)
    }
    return value
  }
}
