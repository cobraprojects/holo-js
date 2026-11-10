import { DatabaseError } from '../core/errors'
import { readNumericValue } from '../schema/normalization'
import type { Entity } from './Entity'
import type { RelationAggregateKind } from './types'

export type RelationAggregateDefinition = {
  readonly relation: string
  readonly kind: RelationAggregateKind
  readonly column?: string
  readonly alias?: string
}

export type RelationAggregateComputation = {
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
        return Object.freeze({ value: numbers.length === 0 ? null : sum / numbers.length })
      }
      case 'min':
      case 'max':
        return this.computeExtremeValue(kind, numbers)
    }
  }

  private computeExtremeValue(
    kind: 'min' | 'max',
    numbers: readonly number[],
  ): RelationAggregateComputation {
    const value = numbers.length === 0
      ? null
      : kind === 'min' ? Math.min(...numbers) : Math.max(...numbers)
    return Object.freeze({ value })
  }

  private requireNumericValue(
    value: unknown,
    kind: Exclude<RelationAggregateKind, 'count' | 'exists'>,
    column: string,
  ): number {
    const numericValue = readNumericValue(value)
    if (numericValue === undefined) {
      throw new DatabaseError(`Relation aggregate "${kind}" requires numeric values for column "${column}".`)
    }
    return numericValue
  }
}
