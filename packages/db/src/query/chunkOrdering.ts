export function compareChunkValuesAscending(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (typeof a === 'undefined' || a === null) return -1
  if (typeof b === 'undefined' || b === null) return 1
  return a < b ? -1 : 1
}

export function compareChunkValuesDescending(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (typeof a === 'undefined' || a === null) return 1
  if (typeof b === 'undefined' || b === null) return -1
  return a < b ? 1 : -1
}
