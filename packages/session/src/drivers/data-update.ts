export function applyDataUpdate(
  data: Readonly<Record<string, unknown>>,
  key: string,
  update: (current: unknown) => unknown,
): { readonly data: Readonly<Record<string, unknown>>, readonly value: unknown } {
  const { [key]: current, ...rest } = data
  const value = update(current)
  return { data: Object.freeze(value === undefined ? rest : { ...rest, [key]: value }), value }
}
