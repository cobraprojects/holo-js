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

const repeatedFormValues = new WeakSet<unknown[]>()

const UNSAFE_PATH_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype'])

const MAX_INPUT_VARIABLES = 1_000

export class MalformedInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MalformedInputError'
  }
}

const INVALID_FIELD_NAME = 'The request contains an invalid field name.'
const INVALID_LIST_INDEX = 'The request contains an invalid list index.'

type ArrayIndexes = Map<unknown[], Set<number>>

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

export { isValidationFieldBuilderLike }

function isBlobLike(value: unknown): value is Blob {
  return typeof Blob !== 'undefined' && value instanceof Blob
}

export function isWebFileLike(value: unknown): value is WebFileLike {
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

export function markDefinitionSensitive(definition: FieldDefinition): FieldDefinition {
  return Object.freeze({
    ...definition,
    sensitive: true as const,
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

  /* v8 ignore next */
  throw new ValidationContractError('Schema fields must be created through the validation field builder.')
}

export function normalizeSchemaShape<TShape extends SchemaInputShape>(shape: TShape, path = 'schema'): NormalizedSchemaShape<TShape> {
  if (!isPlainObject(shape)) {
    throw new ValidationContractError(`${path} must be a schema object.`)
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

export function createField<TOutput>(kind: FieldKind, item?: FieldDefinition['item'], sensitive = false): ValidationField<TOutput> {
  return Object.freeze({
    kind: 'field' as const,
    definition: Object.freeze({
      kind,
      item,
      ...(sensitive ? { sensitive: true as const } : {}),
      rules: Object.freeze([]),
    }),
  })
}

function createObjectContainer(): Record<string, unknown> {
  return Object.create(null) as Record<string, unknown>
}

function hasOwnContainerValue(container: Record<string, unknown> | unknown[], key: string | number): boolean {
  return Object.prototype.hasOwnProperty.call(container, key)
}

function assertSafePathSegment(segment: string, path: string): void {
  if (UNSAFE_PATH_SEGMENTS.has(segment)) {
    throw new ValidationContractError(`Unsafe path segment "${segment}" in "${path}".`)
  }
}

function pathSegments(path: string): readonly string[] {
  const segments = path.split('.').map(segment => segment.trim()).filter(Boolean)
  for (const segment of segments) {
    assertSafePathSegment(segment, path)
  }

  return segments
}

export function buildErrorTree(flattened: Record<string, readonly string[]>): Record<string, unknown> {
  const root = createObjectContainer()

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

      const existing = hasOwnContainerValue(cursor, segment) ? cursor[segment] : undefined
      if (!isPlainObject(existing)) {
        cursor[segment] = createObjectContainer()
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

function parsePathTokens(path: string): readonly (string | number | '')[] {
  const tokens: (string | number | '')[] = []
  const pattern = /([^[.\]]+)|\[(.*?)\]/g

  for (const match of path.matchAll(pattern)) {
    const segment = (match[1] ?? match[2])!
    if (segment === '') {
      tokens.push('')
      continue
    }

    if (/^\d+$/.test(segment)) {
      tokens.push(Number(segment))
      continue
    }

    if (UNSAFE_PATH_SEGMENTS.has(segment)) {
      throw new MalformedInputError(INVALID_FIELD_NAME)
    }
    tokens.push(segment)
  }

  return tokens
}

type SlotKind = 'value' | 'appended' | 'indexed' | 'object'

const slotKinds = new WeakMap<object, Map<string, SlotKind>>()

function slotKindFor(next: string | number | '' | undefined): SlotKind {
  if (next === undefined) return 'value'
  if (typeof next === 'number') return 'indexed'
  return next === '' ? 'appended' : 'object'
}

function joinSlotKinds(established: SlotKind, requested: SlotKind, replaceValues: boolean): SlotKind {
  if (established === requested) {
    return established === 'value' && !replaceValues ? 'appended' : established
  }

  if ((established === 'value' && requested === 'appended') || (established === 'appended' && requested === 'value')) {
    return 'appended'
  }

  throw new MalformedInputError(INVALID_FIELD_NAME)
}

function claimSlot(container: object, key: string, requested: SlotKind, replaceValues: boolean): SlotKind {
  const kinds = slotKinds.get(container) ?? new Map<string, SlotKind>()
  slotKinds.set(container, kinds)
  const established = kinds.get(key)
  const resolved = established === undefined ? requested : joinSlotKinds(established, requested, replaceValues)
  kinds.set(key, resolved)
  return resolved
}

type Container = Record<string, unknown> | unknown[]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readSlot(container: Container, key: string | number): unknown {
  return Array.isArray(container) ? container[Number(key)] : container[String(key)]
}

function writeSlot(container: Container, key: string | number, value: unknown): void {
  if (Array.isArray(container)) {
    container[Number(key)] = value
    return
  }
  container[String(key)] = value
}

function appendedList(container: Container, key: string | number, existing: unknown): unknown[] {
  if (Array.isArray(existing)) return existing
  const list = existing === undefined ? [] : [existing]
  if (existing !== undefined) repeatedFormValues.add(list)
  writeSlot(container, key, list)
  return list
}

function openContainer(container: Container, key: string | number, kind: SlotKind, existing: unknown): Container {
  if (kind === 'appended') return appendedList(container, key, existing)
  if (Array.isArray(existing) || isRecord(existing)) return existing
  const created: Container = kind === 'object' ? createObjectContainer() : []
  writeSlot(container, key, created)
  return created
}

function recordArrayIndex(indexes: ArrayIndexes, array: unknown[], index: number): void {
  const recorded = indexes.get(array) ?? new Set<number>()
  recorded.add(index)
  indexes.set(array, recorded)
}

export function assignNestedValue(
  target: Record<string, unknown> | unknown[],
  path: string,
  value: unknown,
  indexes: ArrayIndexes = new Map(),
  indexLimit = Number.POSITIVE_INFINITY,
): void {
  const tokens = parsePathTokens(path)
  if (tokens.length === 0) {
    return
  }

  let cursor: Container = target

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    const next = tokens[index + 1]
    const last = index === tokens.length - 1
    const requested = slotKindFor(next)

    if (Array.isArray(cursor) && token === '') {
      if (last) {
        cursor.push(value)
        return
      }

      const element: Container = requested === 'object' ? createObjectContainer() : []
      cursor.push(element)
      cursor = element
      continue
    }

    let key: string | number
    if (Array.isArray(cursor)) {
      if (typeof token !== 'number') {
        throw new MalformedInputError(INVALID_FIELD_NAME)
      }

      if (token >= indexLimit) {
        throw new MalformedInputError(INVALID_LIST_INDEX)
      }

      recordArrayIndex(indexes, cursor, token)
      key = token
    } else {
      if (typeof token !== 'string') {
        throw new MalformedInputError(INVALID_FIELD_NAME)
      }

      key = token
    }

    const kind = claimSlot(cursor, String(key), requested, Array.isArray(cursor))
    const existing = hasOwnContainerValue(cursor, key) ? readSlot(cursor, key) : undefined

    if (last) {
      if (kind === 'value') {
        writeSlot(cursor, key, value)
      } else {
        appendedList(cursor, key, existing).push(value)
      }
      return
    }

    cursor = openContainer(cursor, key, kind, existing)
  }
}

export function normalizeFormData(input: FormData | URLSearchParams): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  const indexes: ArrayIndexes = new Map()
  const entries = Array.from(input.entries())
  if (entries.filter(([, value]) => !isBlobLike(value)).length > MAX_INPUT_VARIABLES) {
    throw new MalformedInputError('The request contains too many input variables.')
  }

  for (const [key, value] of entries) {
    assignNestedValue(output, key, value, indexes, entries.length)
  }

  for (const recorded of indexes.values()) {
    for (const index of recorded) {
      if (index >= recorded.size) {
        throw new MalformedInputError(INVALID_LIST_INDEX)
      }
    }
  }

  return output
}

function parseJsonInput(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

async function parseFormBody(input: Request): Promise<FormData> {
  try {
    return await input.formData()
  } catch {
    return new FormData()
  }
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
      value: parseJsonInput(await input.text()),
    }
  }

  if (contentType === 'multipart/form-data' || contentType === 'application/x-www-form-urlencoded') {
    return {
      source: 'form-data',
      value: normalizeFormData(await parseFormBody(input)),
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
  return Array.isArray(value) && repeatedFormValues.has(value) ? value[value.length - 1] : value
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

export function declaredListLimit(definition: FieldDefinition): { readonly rule: FieldRule, readonly value: number } | undefined {
  let limit: { readonly rule: FieldRule, readonly value: number } | undefined
  for (const rule of definition.rules) {
    const value = rule.args[0]
    if ((rule.name === 'max' || rule.name === 'size') && typeof value === 'number' && (!limit || value < limit.value)) {
      limit = { rule, value }
    }
  }
  return limit
}

export function coerceFieldValue(definition: FieldDefinition, value: unknown): unknown {
  if (definition.kind === 'array') {
    if (value === undefined || (value === null && definition.rules.some(rule => rule.name === 'nullable'))) {
      return value
    }

    const rawItems = Array.isArray(value) ? value : [value]
    const limit = declaredListLimit(definition)
    if (!definition.item || (limit && rawItems.length > limit.value)) {
      return rawItems
    }

    if (isFieldDefinition(definition.item)) {
      return rawItems.map(item => coerceFieldValue(definition.item as FieldDefinition, item))
    }

    return rawItems.map(item => coerceShapeInput(definition.item as NormalizedSchemaShape<SchemaInputShape>, item))
  }

  const normalizedValue = lastValue(value)

  if (definition.kind === 'file' && isWebFileLike(normalizedValue)) {
    const file = normalizedValue as WebFileLike
    if (file.size === 0 && (
      typeof file.name !== 'string'
      || file.name === ''
      || file.type === 'application/octet-stream'
    )) {
      return undefined
    }
  }

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
