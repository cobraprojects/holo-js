export function stableStringify(value: unknown): string {
  return stableStringifyValue(value, new WeakSet<object>())
}

function stableStringifyValue(value: unknown, ancestors: WeakSet<object>): string {
  if (!value || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (ancestors.has(value)) {
    return '"[Circular]"'
  }

  ancestors.add(value)

  if (Array.isArray(value)) {
    let result = '['
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) {
        result += ','
      }

      result += stableStringifyValue(value[index], ancestors)
    }

    ancestors.delete(value)
    return `${result}]`
  }

  const keys = Object.keys(value).sort((left, right) => left.localeCompare(right))
  let result = '{'
  let first = true
  for (const key of keys) {
    if (first) {
      first = false
    } else {
      result += ','
    }

    result += `${JSON.stringify(key)}:${stableStringifyValue((value as Readonly<Record<string, unknown>>)[key], ancestors)}`
  }

  ancestors.delete(value)
  return `${result}}`
}
