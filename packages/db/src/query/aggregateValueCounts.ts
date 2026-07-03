import type { DatabaseQueryAggregateValueCountObservation } from '../cache'

export function createAggregateValueCounts(
  values: readonly number[],
): readonly DatabaseQueryAggregateValueCountObservation[] {
  const counts = new Map<number, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }

  return Object.freeze([...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([value, count]) => Object.freeze({ count, value })))
}
