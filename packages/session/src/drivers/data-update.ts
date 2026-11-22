export function applyDataUpdate(
  data: Readonly<Record<string, unknown>>,
  key: string,
  update: (current: unknown) => unknown,
): { readonly data: Readonly<Record<string, unknown>>, readonly value: unknown } {
  const { [key]: _stored, ...rest } = data
  const value = update(Object.hasOwn(data, key) ? data[key] : undefined)
  return { data: Object.freeze(value === undefined ? rest : { ...rest, [key]: value }), value }
}
