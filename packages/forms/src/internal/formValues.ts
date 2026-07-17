type SchemaFieldLike = {
  readonly kind: 'field'
  readonly definition: object
}

export function isPlainFormObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function isSchemaFieldLike(value: unknown): value is SchemaFieldLike {
  return !!value
    && typeof value === 'object'
    && (value as { kind?: unknown }).kind === 'field'
    && !!(value as { definition?: unknown }).definition
    && typeof (value as { definition?: unknown }).definition === 'object'
}

export function areFormValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true
  if (left instanceof Date && right instanceof Date) return left.getTime() === right.getTime()
  if (left instanceof Blob || right instanceof Blob) return false

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => areFormValuesEqual(value, right[index]))
  }

  if (isPlainFormObject(left) && isPlainFormObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)
    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => key in right && areFormValuesEqual(left[key], right[key]))
  }

  return false
}

export function cloneFormValue<TValue>(value: TValue): TValue {
  if (Array.isArray(value)) return value.map(item => cloneFormValue(item)) as TValue
  if (value instanceof Date) return new Date(value.getTime()) as TValue
  if (isPlainFormObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneFormValue(entry)]),
    ) as TValue
  }
  return value
}

export function isFormLeafValue(value: unknown): boolean {
  return Array.isArray(value)
    || value instanceof Date
    || value instanceof Blob
    || isSchemaFieldLike(value)
    || !isPlainFormObject(value)
}

export function normalizeFormObject<TData>(value: Partial<TData> | TData | undefined): TData {
  return (isPlainFormObject(value) ? cloneFormValue(value) : {}) as TData
}

export function mergeFormValues<TData>(base: TData, override: Partial<TData> | undefined): TData {
  if (!override || !isPlainFormObject(override)) return cloneFormValue(base)

  const output = cloneFormValue(base) as Record<string, unknown>
  for (const [key, value] of Object.entries(override)) {
    if (typeof value === 'undefined' && key in output) continue
    if (isPlainFormObject(value) && isPlainFormObject(output[key])) {
      output[key] = mergeFormValues(output[key] as Record<string, unknown>, value)
      continue
    }
    output[key] = cloneFormValue(value)
  }
  return output as TData
}

function splitFormPath(path: string): readonly string[] {
  return path.split('.').map(part => part.trim()).filter(Boolean)
}

export function getFormValueAtPath(root: unknown, path: string): unknown {
  let cursor = root
  for (const part of splitFormPath(path)) {
    if (!isPlainFormObject(cursor) && !Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[part]
  }
  return cursor
}

export function setFormValueAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = splitFormPath(path)
  let cursor: Record<string, unknown> | unknown[] = root

  for (const [index, part] of parts.entries()) {
    const last = index === parts.length - 1
    const nextPart = parts[index + 1]
    if (!nextPart && !last) return

    if (Array.isArray(cursor)) {
      const offset = Number(part)
      if (!Number.isInteger(offset) || offset < 0) return
      if (last) {
        cursor[offset] = value
        return
      }
      const existing = cursor[offset]
      if (!isPlainFormObject(existing) && !Array.isArray(existing)) cursor[offset] = /^\d+$/.test(nextPart!) ? [] : {}
      cursor = cursor[offset] as Record<string, unknown> | unknown[]
      continue
    }

    if (last) {
      cursor[part] = value
      return
    }
    const existing = cursor[part]
    if (!isPlainFormObject(existing) && !Array.isArray(existing)) cursor[part] = /^\d+$/.test(nextPart!) ? [] : {}
    cursor = cursor[part] as Record<string, unknown> | unknown[]
  }
}

export function flattenFormLeafPaths(value: unknown, prefix = ''): readonly string[] {
  if (isFormLeafValue(value)) return [prefix].filter(Boolean)
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) => {
    return flattenFormLeafPaths(nested, prefix ? `${prefix}.${key}` : key)
  })
}

export function buildFormData(value: unknown, path = '', formData: FormData = new FormData()): FormData {
  if (typeof value === 'undefined') return formData
  if (value instanceof Date) {
    formData.append(path, value.toISOString())
    return formData
  }
  if (value instanceof Blob) {
    formData.append(path, value)
    return formData
  }
  if (Array.isArray(value)) {
    for (const item of value) buildFormData(item, `${path}[]`, formData)
    return formData
  }
  if (isPlainFormObject(value)) {
    for (const [key, nested] of Object.entries(value)) buildFormData(nested, path ? `${path}.${key}` : key, formData)
    return formData
  }
  formData.append(path, String(value))
  return formData
}
