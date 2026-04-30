import * as v from 'valibot'
import {
  type FieldBuilderInput,
  type FieldDefinition,
  type FieldKind,
  FIELD_KINDS,
  type NormalizedSchemaShape,
  type SchemaInputShape,
  type StandardSchemaV1Issue,
  type SupportedRuleFamily,
  type ValidationErrorBag,
  type ValidationField,
  type ValidationFieldBuilderLike,
  ValidationContractError,
  type WebFileLike,
  type FieldRule,
} from './contracts-types'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

export function isFieldDefinition(value: unknown): value is FieldDefinition {
  return isPlainObject(value)
    && typeof value.kind === 'string'
    && FIELD_KINDS.includes(value.kind as FieldKind)
    && Array.isArray(value.rules)
}

export function isValidationField(value: unknown): value is ValidationField {
  return isPlainObject(value)
    && value.kind === 'field'
    && isFieldDefinition(value.definition)
}

function isValidationFieldBuilderLike(value: unknown): value is ValidationFieldBuilderLike<unknown> {
  return isPlainObject(value)
    && 'field' in value
    && isValidationField(value.field)
}

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

function isWebFileLike(value: unknown): value is WebFileLike {
  return isBlobLike(value)
    || (
      !!value
      && typeof value === 'object'
      && ('name' in value || 'size' in value || /* v8 ignore next */ 'type' in value)
    )
}

function normalizeMessage(message: string | undefined): string | undefined {
  if (typeof message === 'undefined') {
    return undefined
  }

  const normalized = message.trim()
  if (!normalized) {
    throw new ValidationContractError('Custom error messages must not be empty.')
  }

  return normalized
}

export function normalizeRule(name: SupportedRuleFamily, args: readonly unknown[] = [], message?: string): FieldRule {
  const normalizedMessage = normalizeMessage(message)
  return Object.freeze({
    name,
    args: Object.freeze([...args]),
    ...(normalizedMessage ? { message: normalizedMessage } : {}),
  })
}

export function cloneDefinition(definition: FieldDefinition, rule: FieldRule): FieldDefinition {
  return Object.freeze({
    ...definition,
    rules: Object.freeze([...definition.rules, rule]),
  })
}

export function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ValidationContractError(`${label} must be a finite number.`)
  }
}

export function assertNonEmptyArray<TValue>(value: readonly TValue[], label: string): void {
  if (value.length === 0) {
    throw new ValidationContractError(`${label} must contain at least one value.`)
  }
}

export function normalizeFieldBuilder<TOutput>(input: FieldBuilderInput<TOutput>): ValidationField<TOutput> {
  if (isValidationFieldBuilderLike(input)) {
    return input.field
  }

  if (isValidationField(input)) {
    return input
  }

  throw new ValidationContractError('Schema fields must be created through the validation field builder.')
}

export function normalizeSchemaShape<TShape extends SchemaInputShape>(shape: TShape, path = 'schema'): NormalizedSchemaShape<TShape> {
  if (!isPlainObject(shape) || Object.keys(shape).length === 0) {
    throw new ValidationContractError(`${path} must declare at least one field.`)
  }

  const normalizedEntries = Object.entries(shape).map(([key, value]) => {
    if (!key.trim()) {
      throw new ValidationContractError(`${path} contains an empty field name.`)
    }

    if (isValidationFieldBuilderLike(value) || isValidationField(value)) {
      return [key, normalizeFieldBuilder(value)]
    }

    if (isPlainObject(value)) {
      return [key, normalizeSchemaShape(value as SchemaInputShape, `${path}.${key}`)]
    }

    throw new ValidationContractError(`${path}.${key} must be a field builder or nested schema object.`)
  })

  return Object.freeze(Object.fromEntries(normalizedEntries)) as NormalizedSchemaShape<TShape>
}

export function createField<TOutput>(kind: FieldKind, item?: FieldDefinition): ValidationField<TOutput> {
  return Object.freeze({
    kind: 'field' as const,
    definition: Object.freeze({
      kind,
      item,
      rules: Object.freeze([]),
    }),
  })
}

function pathSegments(path: string): readonly string[] {
  return path.split('.').map(segment => segment.trim()).filter(Boolean)
}

export function buildErrorTree(flattened: Record<string, readonly string[]>): Record<string, unknown> {
  const root: Record<string, unknown> = {}

  for (const [path, messages] of Object.entries(flattened)) {
    const segments = pathSegments(path)
    if (segments.length === 0) {
      continue
    }

    let cursor: Record<string, unknown> = root
    for (const [index, segment] of segments.entries()) {
      if (index === segments.length - 1) {
        cursor[segment] = Object.freeze([...messages])
        continue
      }

      const existing = cursor[segment]
      if (!isPlainObject(existing)) {
        cursor[segment] = {}
      }

      cursor = cursor[segment] as Record<string, unknown>
    }
  }

  return root
}

export function createErrorBag<TShape>(
  flattened: Record<string, readonly string[]> = {},
): ValidationErrorBag<TShape> {
  const normalized = Object.freeze(Object.fromEntries(
    Object.entries(flattened).map(([key, messages]) => [key, Object.freeze([...messages])]),
  )) as Record<string, readonly string[]>
  const tree = buildErrorTree(normalized)

  return Object.freeze(Object.assign(tree, {
    has(path: string) {
      return Boolean(normalized[path]?.length)
    },
    get(path: string) {
      return normalized[path] ?? Object.freeze([])
    },
    first(path: string) {
      return normalized[path]?.[0]
    },
    flatten() {
      return normalized
    },
    toJSON() {
      return normalized
    },
  })) as ValidationErrorBag<TShape>
}

export function normalizeIssuePath(issue: { readonly path?: readonly unknown[] }): string {
  const segments = (issue.path ?? [])
    .map((segment) => {
      if (typeof segment === 'string' || typeof segment === 'number') {
        return String(segment)
      }

      if (isPlainObject(segment) && 'key' in segment) {
        const key = segment.key
        return typeof key === 'string' || typeof key === 'number' ? String(key) : ''
      }

      return ''
    })
    .filter(Boolean)

  return segments.join('.')
}

export function issuesToFlat(issues: ReadonlyArray<StandardSchemaV1Issue>): Record<string, string[]> {
  const flat: Record<string, string[]> = {}
  for (const issue of issues) {
    const path = normalizeIssuePath(issue) /* v8 ignore next */ || '_root'
    flat[path] ??= []
    flat[path].push(issue.message)
  }
  return flat
}

function getRule(definition: FieldDefinition, name: SupportedRuleFamily): FieldRule | undefined {
  return definition.rules.find(rule => rule.name === name)
}

function hasRule(definition: FieldDefinition, name: SupportedRuleFamily): boolean {
  return definition.rules.some(rule => rule.name === name)
}

function makeBaseSchema(definition: FieldDefinition): v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  switch (definition.kind) {
    case 'string':
      return v.string()
    case 'number':
      return v.number()
    case 'boolean':
      return v.boolean()
    case 'date':
      return v.date()
    case 'file':
      return v.custom<WebFileLike>(value => isWebFileLike(value), 'Invalid file.')
    case 'array':
      return v.arrayAsync(definition.item ? makeCompiledFieldSchema(definition.item) as v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> : /* v8 ignore next */ v.unknown())
  }
}

function exactSizeAction(definition: FieldDefinition, value: number, message?: string): unknown {
  if (definition.kind === 'string' || definition.kind === 'array') {
    return v.length(value, message)
  }

  return v.check((input: unknown) => input === value, message ?? `Expected exactly ${value}.`)
}

function minAction(definition: FieldDefinition, value: number, message?: string): unknown {
  if (definition.kind === 'string' || definition.kind === 'array') {
    return v.minLength(value, message)
  }

  return v.minValue(value, message)
}

function maxAction(definition: FieldDefinition, value: number, message?: string): unknown {
  if (definition.kind === 'string' || definition.kind === 'array') {
    return v.maxLength(value, message)
  }

  return v.maxValue(value, message)
}

function asPipeItem(value: unknown): v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return value as v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>>
}

export function makeCompiledFieldSchema(definition: FieldDefinition): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> {
  let schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> = makeBaseSchema(definition)
  const actions: (v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>>)[] = []

  for (const rule of definition.rules) {
    switch (rule.name) {
      case 'min':
        if (typeof rule.args[0] === 'number') {
          actions.push(asPipeItem(minAction(definition, rule.args[0], rule.message)))
        }
        break
      case 'max':
        if (definition.kind !== 'file' && typeof rule.args[0] === 'number') {
          actions.push(asPipeItem(maxAction(definition, rule.args[0], rule.message)))
        }
        break
      case 'size':
        if (typeof rule.args[0] === 'number' && definition.kind !== 'file') {
          actions.push(asPipeItem(exactSizeAction(definition, rule.args[0], rule.message)))
        }
        break
      case 'email':
        actions.push(asPipeItem(v.email(rule.message)))
        break
      case 'url':
        actions.push(asPipeItem(v.url(rule.message)))
        break
      case 'uuid':
        actions.push(asPipeItem(v.uuid(rule.message)))
        break
      case 'integer':
        actions.push(asPipeItem(v.integer(rule.message)))
        break
      case 'regex':
        if (rule.args[0] instanceof RegExp) {
          actions.push(asPipeItem(v.regex(rule.args[0], rule.message)))
        }
        break
      case 'in': {
        const allowed = new Set(rule.args)
        actions.push(asPipeItem(v.check((input: unknown) => allowed.has(input), rule.message ?? 'Value is not in the allowed list.')))
        break
      }
      case 'transform':
        if (typeof rule.args[0] === 'function') {
          actions.push(asPipeItem(v.transform(rule.args[0] as (input: unknown) => unknown)))
        }
        break
      default:
        break
    }
  }

  if (actions.length > 0) {
    schema = v.pipeAsync(schema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, ...actions)
  }

  const defaultRule = getRule(definition, 'default')
  const hasNullable = hasRule(definition, 'nullable')
  const hasOptional = hasRule(definition, 'optional') || typeof defaultRule !== 'undefined'

  if (hasNullable) {
    schema = v.nullable(schema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, defaultRule?.args[0] as never)
  }

  if (hasOptional) {
    schema = v.optional(schema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, defaultRule?.args[0] as never)
  }

  return schema
}

function compileSchemaShape(shape: SchemaInputShape): v.ObjectEntries {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => {
      if (isValidationFieldBuilderLike(value) || isValidationField(value)) {
        return [key, makeCompiledFieldSchema(normalizeFieldBuilder(value).definition)]
      }

      return [key, v.objectAsync(compileSchemaShape(value as SchemaInputShape))]
    }),
  )
}

export function resolveCompiledSchema(fields: SchemaInputShape): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return v.objectAsync(compileSchemaShape(fields))
}

function parsePathTokens(path: string): readonly (string | number | '')[] {
  const tokens: (string | number | '')[] = []
  const pattern = /([^[.\]]+)|\[(.*?)\]/g

  for (const match of path.matchAll(pattern)) {
    const segment = match[1] ?? match[2] ?? /* v8 ignore next */ ''
    if (segment === '') {
      tokens.push('')
      continue
    }

    if (/^\d+$/.test(segment)) {
      tokens.push(Number(segment))
      continue
    }

    tokens.push(segment)
  }

  return tokens
}

function createContainer(next: string | number | '' | undefined): Record<string, unknown> | unknown[] {
  return typeof next === 'number' || next === '' ? [] : {}
}

export function assignNestedValue(target: Record<string, unknown> | unknown[], path: string, value: unknown): void {
  const tokens = parsePathTokens(path)
  if (tokens.length === 0) {
    return
  }

  let cursor: Record<string, unknown> | unknown[] = target

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]
    const last = index === tokens.length - 1

    if (Array.isArray(cursor)) {
      if (token === '') {
        if (last) {
          cursor.push(value)
          return
        }

        const container = createContainer(next)
        cursor.push(container)
        cursor = container
        continue
      }

      if (typeof token !== 'number') {
        throw new ValidationContractError(`Invalid array path segment "${String(token)}" in "${path}".`)
      }

      if (last) {
        cursor[token] = value
        return
      }

      const existing = cursor[token]
      if (!existing || /* v8 ignore next */ typeof existing !== 'object') {
        cursor[token] = createContainer(next)
      }

      cursor = cursor[token] as Record<string, unknown> | unknown[]
      continue
    }

    if (typeof token !== 'string') {
      throw new ValidationContractError(`Invalid object path segment "${String(token)}" in "${path}".`)
    }

    if (last) {
      const existing = cursor[token]
      if (typeof existing === 'undefined') {
        cursor[token] = value
      } else if (Array.isArray(existing)) {
        existing.push(value)
      } else {
        cursor[token] = [existing, value]
      }
      return
    }

    const existing = cursor[token]
    if (!existing || typeof existing !== 'object') {
      cursor[token] = createContainer(next)
    }

    cursor = cursor[token] as Record<string, unknown> | unknown[]
  /* v8 ignore next 2 */
  }
}

export function normalizeFormData(input: FormData | URLSearchParams): Record<string, unknown> {
  const output: Record<string, unknown> = {}

  for (const [key, value] of input.entries()) {
    assignNestedValue(output, key, value)
  }

  return output
}

export async function normalizeRequestInput(input: Request): Promise<{ readonly source: string, readonly value: unknown }> {
  const method = input.method.toUpperCase()
  const contentType = input.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()

  if (method === 'GET' || method === 'HEAD') {
    return {
      source: 'search-params',
      value: normalizeFormData(new URL(input.url).searchParams),
    }
  }

  if (contentType === 'application/json') {
    return {
      source: 'request',
      value: await input.json(),
    }
  }

  if (contentType === 'multipart/form-data' || contentType === 'application/x-www-form-urlencoded') {
    return {
      source: 'form-data',
      value: normalizeFormData(await input.formData()),
    }
  }

  const text = await input.text()
  if (!text.trim()) {
    return {
      source: 'request',
      value: {},
    }
  }

  throw new ValidationContractError(`Unsupported request content type: ${contentType ?? /* v8 ignore next */ '(missing)'}.`)
}

function lastValue(value: unknown): unknown {
  return Array.isArray(value) ? value[value.length - 1] : value
}

function coerceBoolean(value: unknown): unknown {
  if (typeof value === 'boolean') {
    return value
  }

  if (typeof value !== 'string') {
    return value
  }

  const normalized = value.trim().toLowerCase()
  if (['1', 'true', 'on', 'yes'].includes(normalized)) {
    return true
  }

  if (['0', 'false', 'off', 'no'].includes(normalized)) {
    return false
  }

  return value
}

function coerceNumber(value: unknown): unknown {
  if (typeof value === 'number') {
    return value
  }

  if (typeof value !== 'string') {
    return value
  }

  const normalized = value.trim()
  if (!normalized) {
    return undefined
  }

  const parsed = Number(normalized)
  return Number.isFinite(parsed) ? parsed : value
}

function coerceDate(value: unknown): unknown {
  if (value instanceof Date) {
    return value
  }

  if (typeof value !== 'string') {
    return value
  }

  const normalized = value.trim()
  if (!normalized) {
    return undefined
  }

  const parsed = new Date(normalized)
  return Number.isNaN(parsed.getTime()) ? value : parsed
}

export function coerceFieldValue(definition: FieldDefinition, value: unknown): unknown {
  if (definition.kind === 'array') {
    if (typeof value === 'undefined') {
      return undefined
    }

    const rawItems = Array.isArray(value) ? value : [value]
    return rawItems.map(item => definition.item ? coerceFieldValue(definition.item, item) : item)
  }

  const normalizedValue = lastValue(value)

  if (normalizedValue === '' && definition.kind !== 'string') {
    return undefined
  }

  switch (definition.kind) {
    case 'boolean':
      return coerceBoolean(normalizedValue)
    case 'number':
      return coerceNumber(normalizedValue)
    case 'date':
      return coerceDate(normalizedValue)
    default:
      return normalizedValue
  }
}

export function coerceShapeInput(shape: SchemaInputShape, value: unknown): Record<string, unknown> {
  const input = isPlainObject(value) ? value : {}
  const output: Record<string, unknown> = {}

  for (const [key, fieldValue] of Object.entries(shape)) {
    const raw = input[key]
    if (isValidationFieldBuilderLike(fieldValue) || isValidationField(fieldValue)) {
      output[key] = coerceFieldValue(normalizeFieldBuilder(fieldValue).definition, raw)
      continue
    }

    output[key] = coerceShapeInput(fieldValue as SchemaInputShape, raw)
  }

  return output
}

export function parseByteSize(value: number | string): number {
  if (typeof value === 'number') {
    assertFiniteNumber(value, 'maxSize')
    return value
  }

  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)(kb|mb|gb)$/)
  if (!match) {
    throw new ValidationContractError(`Unsupported size string "${value}". Use formats like "2mb".`)
  }

  const amount = Number(match[1])
  const unit = match[2]
  const multiplier = unit === 'kb' ? 1024 : unit === 'mb' ? 1024 ** 2 : 1024 ** 3
  return Math.floor(amount * multiplier)
}

export function normalizeDateRuleValue(value: Date | string, label: string): string {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new ValidationContractError(`${label} must be a valid Date.`)
    }

    return value.toISOString()
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationContractError(`${label} must be a valid date value.`)
  }

  return parsed.toISOString()
}

export function appendIssues(
  target: Record<string, string[]>,
  issues: readonly { readonly message?: string; readonly path?: readonly unknown[] }[],
): void {
  for (const issue of issues) {
    const path = normalizeIssuePath(issue) /* v8 ignore next */ || '_root'
    target[path] ??= []
    target[path].push(issue.message ?? /* v8 ignore next */ 'Validation failed.')
  }
}
