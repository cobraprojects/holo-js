export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function isRecordArray(value: unknown): value is readonly Readonly<Record<string, unknown>>[] {
  return Array.isArray(value) && value.every(isRecord)
}
