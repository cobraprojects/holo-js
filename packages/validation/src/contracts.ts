import * as v from 'valibot'

export const FIELD_KINDS = ['string', 'number', 'boolean', 'date', 'file', 'array'] as const
export const SUPPORTED_RULE_FAMILIES = [
  'required',
  'optional',
  'nullable',
  'default',
  'min',
  'max',
  'size',
  'email',
  'url',
  'uuid',
  'integer',
  'regex',
  'in',
  'confirmed',
  'before',
  'after',
  'beforeOrEqual',
  'afterOrEqual',
  'today',
  'beforeToday',
  'todayOrBefore',
  'beforeOrToday',
  'afterToday',
  'todayOrAfter',
  'afterOrToday',
  'transform',
  'custom',
  'customAsync',
] as const

// ---------------------------------------------------------------------------
// Standard Schema V1 types (inlined from the spec to avoid runtime dep)
// ---------------------------------------------------------------------------

export interface StandardSchemaV1Props<TInput = unknown, TOutput = TInput> {
  readonly version: 1
  readonly vendor: string
  readonly validate: (value: unknown) => StandardSchemaV1Result<TOutput> | Promise<StandardSchemaV1Result<TOutput>>
  readonly types?: StandardSchemaV1Types<TInput, TOutput> | undefined
}

export type StandardSchemaV1Result<TOutput> = StandardSchemaV1SuccessResult<TOutput> | StandardSchemaV1FailureResult

export interface StandardSchemaV1SuccessResult<TOutput> {
  readonly value: TOutput
  readonly issues?: undefined
}

export interface StandardSchemaV1FailureResult {
  readonly issues: ReadonlyArray<StandardSchemaV1Issue>
}

export interface StandardSchemaV1Issue {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | StandardSchemaV1PathSegment> | undefined
}

export interface StandardSchemaV1PathSegment {
  readonly key: PropertyKey
}

export interface StandardSchemaV1Types<TInput = unknown, TOutput = TInput> {
  readonly input: TInput
  readonly output: TOutput
}

export interface StandardSchemaV1<TInput = unknown, TOutput = TInput> {
  readonly '~standard': StandardSchemaV1Props<TInput, TOutput>
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type PrimitiveFieldKind = typeof FIELD_KINDS[number]
export type FieldKind = PrimitiveFieldKind
export type SupportedRuleFamily = typeof SUPPORTED_RULE_FAMILIES[number]
export type SchemaSourceInput = Request | FormData | URLSearchParams | Record<string, unknown>

export interface WebFileLike {
  readonly name?: string
  readonly type?: string
  readonly size?: number
  readonly lastModified?: number
}

export interface FieldRule {
  readonly name: SupportedRuleFamily
  readonly args: readonly unknown[]
  readonly message?: string
}

export interface FieldDefinition {
  readonly kind: FieldKind
  readonly rules: readonly FieldRule[]
  readonly item?: FieldDefinition
}

export interface ValidationField<TOutput = unknown> {
  readonly kind: 'field'
  readonly definition: FieldDefinition
  readonly __outputType?: TOutput
}

export type FieldBuilderInput<TOutput = unknown> = ValidationFieldBuilder<TOutput> | ValidationField<TOutput>

type NormalizeFieldInput<TInput> = TInput extends ValidationFieldBuilder<infer TOutput>
  ? ValidationField<TOutput>
  : TInput extends ValidationField<infer TOutput>
    ? ValidationField<TOutput>
    : never

type InferFieldOutput<TInput> = NormalizeFieldInput<TInput> extends ValidationField<infer TOutput> ? TOutput : never

export type SchemaInputShape = {
  readonly [key: string]: FieldBuilderInput | SchemaInputShape
}

type Simplify<TValue> = { [K in keyof TValue]: TValue[K] } & {}

export type InferSchemaData<TShape extends SchemaInputShape> = Simplify<{
  [K in keyof TShape]:
    TShape[K] extends FieldBuilderInput
      ? InferFieldOutput<TShape[K]>
      : TShape[K] extends SchemaInputShape
        ? InferSchemaData<TShape[K]>
        : never
}>

export type ErrorTreeNode<TValue> = TValue extends readonly unknown[]
  ? readonly string[]
  : TValue extends Date | WebFileLike | Blob
    ? readonly string[]
    : TValue extends Record<string, unknown>
      ? ErrorTree<TValue>
      : readonly string[]

export type ErrorTree<TShape> = {
  readonly [K in keyof TShape]?: ErrorTreeNode<TShape[K]>
}

export type ValidationErrorBag<TShape> = ErrorTree<TShape> & {
  has(path: string): boolean
  get(path: string): readonly string[]
  first(path: string): string | undefined
  flatten(): Record<string, readonly string[]>
  toJSON(): Record<string, readonly string[]>
}

export interface ValidationSchema<TShape extends SchemaInputShape = SchemaInputShape> extends StandardSchemaV1<unknown, InferSchemaData<TShape>> {
  readonly kind: 'schema'
  readonly fields: TShape
  readonly $data?: InferSchemaData<TShape>
  readonly $errors?: ValidationErrorBag<InferSchemaData<TShape>>
}

export interface ValidationSuccess<TData> {
  readonly valid: true
  readonly submitted: true
  readonly data: TData
  readonly values: TData
  readonly errors: ValidationErrorBag<TData>
}

export interface ValidationFailure<TData> {
  readonly valid: false
  readonly submitted: true
  readonly data?: undefined
  readonly values: Partial<TData>
  readonly errors: ValidationErrorBag<TData>
}

export type ValidationResult<TData> = ValidationSuccess<TData> | ValidationFailure<TData>
export type FormLikeValidationInput = SchemaSourceInput

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type NormalizedInputSource = {
  readonly source: string
  readonly value: unknown
}

type PostValidationContext = {
  readonly root: unknown
  readonly parent: unknown | null
  readonly key: string
  readonly path: readonly string[]
}

export class ValidationContractError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ValidationContractError'
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function isFieldDefinition(value: unknown): value is FieldDefinition {
  return isPlainObject(value)
    && typeof value.kind === 'string'
    && FIELD_KINDS.includes(value.kind as FieldKind)
    && Array.isArray(value.rules)
}

function isValidationField(value: unknown): value is ValidationField {
  return isPlainObject(value)
    && value.kind === 'field'
    && isFieldDefinition(value.definition)
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

function normalizeRule(name: SupportedRuleFamily, args: readonly unknown[] = [], message?: string): FieldRule {
  const normalizedMessage = normalizeMessage(message)
  return Object.freeze({
    name,
    args: Object.freeze([...args]),
    ...(normalizedMessage ? { message: normalizedMessage } : {}),
  })
}

function cloneDefinition(definition: FieldDefinition, rule: FieldRule): FieldDefinition {
  return Object.freeze({
    ...definition,
    rules: Object.freeze([...definition.rules, rule]),
  })
}

function assertFiniteNumber(value: number, label: string): void {
  if (!Number.isFinite(value)) {
    throw new ValidationContractError(`${label} must be a finite number.`)
  }
}

function assertNonEmptyArray<TValue>(value: readonly TValue[], label: string): void {
  if (value.length === 0) {
    throw new ValidationContractError(`${label} must contain at least one value.`)
  }
}

function normalizeFieldBuilder<TOutput>(input: FieldBuilderInput<TOutput>): ValidationField<TOutput> {
  if (input instanceof ValidationFieldBuilder) {
    return input.field
  }

  /* v8 ignore start -- defensive guard behind normalizeSchemaShape */
  if (isValidationField(input)) {
    return input
  }

  throw new ValidationContractError('Schema fields must be created through the validation field builder.')
}
/* v8 ignore stop */

function normalizeSchemaShape<TShape extends SchemaInputShape>(shape: TShape, path = 'schema'): TShape {
  if (!isPlainObject(shape) || Object.keys(shape).length === 0) {
    throw new ValidationContractError(`${path} must declare at least one field.`)
  }

  const normalizedEntries = Object.entries(shape).map(([key, value]) => {
    if (!key.trim()) {
      throw new ValidationContractError(`${path} contains an empty field name.`)
    }

    if (value instanceof ValidationFieldBuilder || isValidationField(value)) {
      return [key, normalizeFieldBuilder(value)]
    }

    if (isPlainObject(value)) {
      return [key, normalizeSchemaShape(value as SchemaInputShape, `${path}.${key}`)]
    }

    throw new ValidationContractError(`${path}.${key} must be a field builder or nested schema object.`)
  })

  return Object.freeze(Object.fromEntries(normalizedEntries)) as TShape
}

function createField<TOutput>(kind: FieldKind, item?: FieldDefinition): ValidationField<TOutput> {
  return Object.freeze({
    kind: 'field' as const,
    definition: Object.freeze({
      kind,
      item,
      rules: Object.freeze([]),
    }),
  })
}

// ---------------------------------------------------------------------------
// Error bag
// ---------------------------------------------------------------------------

function pathSegments(path: string): readonly string[] {
  return path.split('.').map(segment => segment.trim()).filter(Boolean)
}

function buildErrorTree(flattened: Record<string, readonly string[]>): Record<string, unknown> {
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

// ---------------------------------------------------------------------------
// Standard Schema issue helpers
// ---------------------------------------------------------------------------

function normalizeIssuePath(issue: { readonly path?: readonly unknown[] }): string {
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

function issuesToFlat(issues: ReadonlyArray<StandardSchemaV1Issue>): Record<string, string[]> {
  const flat: Record<string, string[]> = {}
  for (const issue of issues) {
    const path = normalizeIssuePath(issue) /* v8 ignore next */ || '_root'
    flat[path] ??= []
    flat[path].push(issue.message)
  }
  return flat
}

// ---------------------------------------------------------------------------
// Valibot compilation (field definition → valibot schema)
// ---------------------------------------------------------------------------

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

function makeCompiledFieldSchema(definition: FieldDefinition): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> {
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
      if (value instanceof ValidationFieldBuilder || isValidationField(value)) {
        return [key, makeCompiledFieldSchema(normalizeFieldBuilder(value).definition)]
      }

      return [key, v.objectAsync(compileSchemaShape(value as SchemaInputShape))]
    }),
  )
}

function resolveCompiledSchema(fields: SchemaInputShape): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return v.objectAsync(compileSchemaShape(fields))
}

// ---------------------------------------------------------------------------
// Input normalization (Request, FormData, URLSearchParams, plain object)
// ---------------------------------------------------------------------------

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

function assignNestedValue(target: Record<string, unknown> | unknown[], path: string, value: unknown): void {
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

    /* v8 ignore start -- unreachable: object cursor never receives numeric tokens from parsePathTokens */
    if (typeof token !== 'string') {
      throw new ValidationContractError(`Invalid object path segment "${String(token)}" in "${path}".`)
    }
    /* v8 ignore stop */

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
  // v8 counts the loop/function closing braces as branches, but the last
  // loop iteration always returns — these lines are structurally unreachable.
  /* v8 ignore next 2 */
  }
}

function normalizeFormData(input: FormData | URLSearchParams): Record<string, unknown> {
  const output: Record<string, unknown> = {}

  for (const [key, value] of input.entries()) {
    assignNestedValue(output, key, value)
  }

  return output
}

async function normalizeRequestInput(input: Request): Promise<NormalizedInputSource> {
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

async function normalizeInput(input: FormLikeValidationInput): Promise<NormalizedInputSource> {
  if (typeof Request !== 'undefined' && input instanceof Request) {
    return normalizeRequestInput(input)
  }

  if (typeof FormData !== 'undefined' && input instanceof FormData) {
    return {
      source: 'form-data',
      value: normalizeFormData(input),
    }
  }

  if (input instanceof URLSearchParams) {
    return {
      source: 'search-params',
      value: normalizeFormData(input),
    }
  }

  if (isPlainObject(input)) {
    return {
      source: 'object',
      value: input,
    }
  }

  throw new ValidationContractError('Validation input must be a Request, FormData, URLSearchParams, or plain object.')
}

// ---------------------------------------------------------------------------
// Coercion (FormData string values → typed values)
// ---------------------------------------------------------------------------

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

function coerceFieldValue(definition: FieldDefinition, value: unknown): unknown {
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

function coerceShapeInput(shape: SchemaInputShape, value: unknown): Record<string, unknown> {
  const input = isPlainObject(value) ? value : {}
  const output: Record<string, unknown> = {}

  for (const [key, fieldValue] of Object.entries(shape)) {
    const raw = input[key]
    if (fieldValue instanceof ValidationFieldBuilder || isValidationField(fieldValue)) {
      output[key] = coerceFieldValue(normalizeFieldBuilder(fieldValue).definition, raw)
      continue
    }

    output[key] = coerceShapeInput(fieldValue as SchemaInputShape, raw)
  }

  return output
}

// ---------------------------------------------------------------------------
// Post-validation rules (required, confirmed, date comparisons, file checks, custom/async)
// ---------------------------------------------------------------------------

function isMissingValue(value: unknown, kind: FieldKind): boolean {
  if (typeof value === 'undefined' || value === null) {
    return true
  }

  if (kind === 'string') {
    return typeof value !== 'string' || value.trim().length === 0
  }

  if (kind === 'array') {
    return !Array.isArray(value) || value.length === 0
  }

  return false
}

function parseByteSize(value: number | string): number {
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

function normalizeDateRuleValue(value: Date | string, label: string): string {
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

function resolveDateRuleValue(value: unknown): Date | undefined {
  /* v8 ignore next 3 -- rule args are always stored as ISO strings via normalizeDateRuleValue */
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value
  }

  if (typeof value === 'string') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }

  return undefined
}

function startOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
}

function endOfToday(now = new Date()): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
}

function isSameLocalDay(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate()
}

function toIssuePath(path: readonly string[]): string {
  return path.join('.')
}

function pushIssue(
  issues: Record<string, string[]>,
  path: readonly string[],
  message: string,
): void {
  const key = toIssuePath(path) || '_root'
  issues[key] ??= []
  issues[key].push(message)
}

function prependIssue(
  issues: Record<string, string[]>,
  path: readonly string[],
  message: string,
): void {
  const key = toIssuePath(path) || '_root'
  issues[key] ??= []
  issues[key].unshift(message)
}

function resolveRuleMessage(rule: FieldRule | undefined, fallback: string): string {
  return rule?.message ?? fallback
}

function appendIssues(
  target: Record<string, string[]>,
  issues: readonly { readonly message?: string; readonly path?: readonly unknown[] }[],
): void {
  for (const issue of issues) {
    const path = normalizeIssuePath(issue) /* v8 ignore next */ || '_root'
    target[path] ??= []
    target[path].push(issue.message ?? /* v8 ignore next */ 'Validation failed.')
  }
}

async function applyPostFieldRules(
  definition: FieldDefinition,
  value: unknown,
  context: PostValidationContext,
  issues: Record<string, string[]>,
): Promise<void> {
  const requiredRule = getRule(definition, 'required')
  if (requiredRule && isMissingValue(value, definition.kind)) {
    prependIssue(issues, context.path, resolveRuleMessage(requiredRule, 'This field is required.'))
    return
  }

  if (typeof value === 'undefined' || value === null) {
    return
  }

  for (const rule of definition.rules) {
    switch (rule.name) {
      case 'custom': {
        const validator = rule.args[0]
        if (typeof validator === 'function') {
          const result = validator(value)
          if (result === false) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, 'Validation failed.'))
          } else if (typeof result === 'string' && result.trim()) {
            pushIssue(issues, context.path, result)
          }
        } else if (validator === 'image') {
          const mimeType = typeof (value as WebFileLike).type === 'string' ? ((value as WebFileLike).type ?? /* v8 ignore next */ '') : ''
          if (!mimeType.toLowerCase().startsWith('image/')) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, 'File must be an image.'))
          }
        }
        break
      }
      case 'customAsync': {
        const validator = rule.args[0]
        if (typeof validator === 'function') {
          const result = await validator(value)
          if (result === false) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, 'Validation failed.'))
          } else if (typeof result === 'string' && result.trim()) {
            pushIssue(issues, context.path, result)
          }
        }
        break
      }
      case 'confirmed': {
        if (context.parent !== null && isPlainObject(context.parent)) {
          const confirmationKey = `${context.key}Confirmation`
          if (context.parent[confirmationKey] !== value) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, 'This field does not match its confirmation.'))
          }
        }
        break
      }
      case 'before':
      case 'after':
      case 'beforeOrEqual':
      case 'afterOrEqual':
      case 'today':
      case 'beforeToday':
      case 'todayOrBefore':
      case 'beforeOrToday':
      case 'afterToday':
      case 'todayOrAfter':
      case 'afterOrToday': {
        const dateValue = value instanceof Date ? value : resolveDateRuleValue(value)
        if (!dateValue) {
          pushIssue(issues, context.path, 'This field must be a valid date.')
          break
        }

        const targetDate = resolveDateRuleValue(rule.args[0])
        const todayStart = startOfToday()
        const todayEnd = endOfToday()

        if (rule.name === 'before' && targetDate && !(dateValue.getTime() < targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `Date must be before ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'after' && targetDate && !(dateValue.getTime() > targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `Date must be after ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'beforeOrEqual' && targetDate && !(dateValue.getTime() <= targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `Date must be before or equal to ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'afterOrEqual' && targetDate && !(dateValue.getTime() >= targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `Date must be after or equal to ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'today' && !isSameLocalDay(dateValue, todayStart)) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'Date must be today.'))
        }

        if (rule.name === 'beforeToday' && !(dateValue.getTime() < todayStart.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'Date must be before today.'))
        }

        if ((rule.name === 'todayOrBefore' || rule.name === 'beforeOrToday') && !(dateValue.getTime() <= todayEnd.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'Date must be today or before.'))
        }

        if (rule.name === 'afterToday' && !(dateValue.getTime() > todayEnd.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'Date must be after today.'))
        }

        if ((rule.name === 'todayOrAfter' || rule.name === 'afterOrToday') && !(dateValue.getTime() >= todayStart.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'Date must be today or after.'))
        }

        break
      }
      case 'max': {
        if (definition.kind === 'file' && typeof (value as WebFileLike).size === 'number') {
          const limit = parseByteSize(rule.args[0] as number | string)
          if (((value as WebFileLike).size ?? /* v8 ignore next */ 0) > limit) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, `File size must be at most ${limit} bytes.`))
          }
        }
        break
      }
      case 'size': {
        if (definition.kind === 'file' && typeof (value as WebFileLike).size === 'number' && typeof rule.args[0] === 'number') {
          if ((value as WebFileLike).size !== rule.args[0]) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, `File size must be exactly ${rule.args[0]} bytes.`))
          }
        }
        break
      }
      default:
        break
    }
  }
}

async function applyPostValidation(
  shape: SchemaInputShape,
  data: unknown,
  root: unknown,
  issues: Record<string, string[]>,
  path: readonly string[] = [],
): Promise<void> {
  const current = isPlainObject(data) ? data : /* v8 ignore next */ {}

  for (const [key, value] of Object.entries(shape)) {
    if (value instanceof ValidationFieldBuilder || isValidationField(value)) {
      const fieldDef = normalizeFieldBuilder(value)
      const nextPath = [...path, key]
      const nextValue = current[key]
      await applyPostFieldRules(fieldDef.definition, nextValue, {
        root,
        parent: current,
        key,
        path: nextPath,
      }, issues)

      if (fieldDef.definition.kind === 'array' && fieldDef.definition.item && Array.isArray(nextValue)) {
        for (const [index, item] of nextValue.entries()) {
          await applyPostFieldRules(fieldDef.definition.item, item, {
            root,
            parent: nextValue,
            key: String(index),
            path: [...nextPath, String(index)],
          }, issues)
        }
      }
      continue
    }

    await applyPostValidation(value as SchemaInputShape, current[key], root, issues, [...path, key])
  }
}

// ---------------------------------------------------------------------------
// Core validation engine
// ---------------------------------------------------------------------------

async function runSchemaValidation(
  fields: SchemaInputShape,
  rawInput: unknown,
): Promise<{ success: boolean; output: unknown; issues: Record<string, string[]> }> {
  const coerced = coerceShapeInput(fields, rawInput)
  const compiled = resolveCompiledSchema(fields)
  const result = await v.safeParseAsync(compiled, coerced)
  const issues: Record<string, string[]> = {}

  if (!result.success) {
    appendIssues(issues, result.issues ?? /* v8 ignore next */ [])
  }

  const postTarget = result.success ? result.output : coerced
  await applyPostValidation(fields, postTarget, postTarget, issues)

  if (Object.keys(issues).length > 0) {
    return { success: false, output: postTarget, issues }
  }

  return { success: true, output: result.success ? result.output : /* v8 ignore next */ coerced, issues }
}

function flatToStandardIssues(flat: Record<string, string[]>): StandardSchemaV1Issue[] {
  const issues: StandardSchemaV1Issue[] = []
  for (const [path, messages] of Object.entries(flat)) {
    for (const message of messages) {
      issues.push({
        message,
        path: path === '_root' ? undefined : path.split('.').map(key => ({ key })),
      })
    }
  }
  return issues
}

// ---------------------------------------------------------------------------
// Standard Schema validate function for object schemas
// ---------------------------------------------------------------------------

function createSchemaStandardValidate<TShape extends SchemaInputShape>(
  fields: TShape,
): (value: unknown) => Promise<StandardSchemaV1Result<InferSchemaData<TShape>>> {
  return async (value: unknown) => {
    const result = await runSchemaValidation(fields, value)
    if (!result.success) {
      return { issues: flatToStandardIssues(result.issues) }
    }
    return { value: result.output as InferSchemaData<TShape> }
  }
}

// ---------------------------------------------------------------------------
// Standard Schema validate function for single field builders
// ---------------------------------------------------------------------------

async function runFieldValidation(
  definition: FieldDefinition,
  rawInput: unknown,
): Promise<{ success: boolean; output: unknown; issues: Record<string, string[]> }> {
  const coerced = coerceFieldValue(definition, rawInput)
  const compiled = makeCompiledFieldSchema(definition)
  const result = await v.safeParseAsync(compiled, coerced)
  const issues: Record<string, string[]> = {}

  if (!result.success) {
    appendIssues(issues, result.issues ?? /* v8 ignore next */ [])
  }

  const postTarget = result.success ? result.output : coerced
  await applyStandaloneFieldPostRules(definition, postTarget, issues)

  if (Object.keys(issues).length > 0) {
    return { success: false, output: postTarget, issues }
  }

  return { success: true, output: result.success ? result.output : /* v8 ignore next */ coerced, issues }
}

async function applyStandaloneFieldPostRules(
  definition: FieldDefinition,
  value: unknown,
  issues: Record<string, string[]>,
): Promise<void> {
  // Run top-level post-rules, skipping `confirmed` which requires a sibling field
  await applyPostFieldRules(definition, value, {
    root: value,
    parent: null,
    key: '_value',
    path: [],
  }, issues)

  // Run post-rules on array items
  if (definition.kind === 'array' && definition.item && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      await applyPostFieldRules(definition.item, item, {
        root: value,
        parent: value,
        key: String(index),
        path: [String(index)],
      }, issues)
    }
  }
}

function createFieldStandardValidate<TOutput>(
  definition: FieldDefinition,
): (value: unknown) => Promise<StandardSchemaV1Result<TOutput>> {
  return async (value: unknown) => {
    const result = await runFieldValidation(definition, value)
    if (!result.success) {
      return { issues: flatToStandardIssues(result.issues) }
    }
    return { value: result.output as TOutput }
  }
}

// ---------------------------------------------------------------------------
// ValidationFieldBuilder (fluent API)
// ---------------------------------------------------------------------------

export class ValidationFieldBuilder<TOutput> implements StandardSchemaV1<unknown, TOutput> {
  readonly field: ValidationField<TOutput>
  readonly '~standard': StandardSchemaV1Props<unknown, TOutput>

  constructor(field: ValidationField<TOutput>) {
    this.field = field
    this['~standard'] = {
      version: 1,
      vendor: 'holo-js',
      validate: createFieldStandardValidate<TOutput>(field.definition),
      types: undefined as unknown as StandardSchemaV1Types<unknown, TOutput>,
    }
  }

  private clone<TNextOutput = TOutput>(rule?: FieldRule): ValidationFieldBuilder<TNextOutput> {
    const nextField = Object.freeze({
      ...this.field,
      definition: rule ? cloneDefinition(this.field.definition, rule) : /* v8 ignore next */ this.field.definition,
    }) as ValidationField<TNextOutput>

    return new ValidationFieldBuilder(nextField)
  }

  required(message?: string): ValidationFieldBuilder<Exclude<TOutput, undefined>> {
    return this.clone<Exclude<TOutput, undefined>>(normalizeRule('required', [], message))
  }

  optional(message?: string): ValidationFieldBuilder<TOutput | undefined> {
    return this.clone<TOutput | undefined>(normalizeRule('optional', [], message))
  }

  nullable(message?: string): ValidationFieldBuilder<TOutput | null> {
    return this.clone<TOutput | null>(normalizeRule('nullable', [], message))
  }

  default(value: Exclude<TOutput, undefined>, message?: string): ValidationFieldBuilder<Exclude<TOutput, undefined>> {
    return this.clone<Exclude<TOutput, undefined>>(normalizeRule('default', [value], message))
  }

  min(value: number, message?: string): ValidationFieldBuilder<TOutput> {
    assertFiniteNumber(value, 'min')
    return this.clone(normalizeRule('min', [value], message))
  }

  max(value: number | string, message?: string): ValidationFieldBuilder<TOutput> {
    if (typeof value === 'number') {
      assertFiniteNumber(value, 'max')
    }

    if (typeof value === 'string' && !value.trim()) {
      throw new ValidationContractError('max must not be an empty string.')
    }

    return this.clone(normalizeRule('max', [value], message))
  }

  size(value: number, message?: string): ValidationFieldBuilder<TOutput> {
    assertFiniteNumber(value, 'size')
    return this.clone(normalizeRule('size', [value], message))
  }

  email(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('email', [], message))
  }

  url(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('url', [], message))
  }

  uuid(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('uuid', [], message))
  }

  integer(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('integer', [], message))
  }

  regex(value: RegExp, message?: string): ValidationFieldBuilder<TOutput> {
    if (!(value instanceof RegExp)) {
      throw new ValidationContractError('regex must be a RegExp instance.')
    }

    return this.clone(normalizeRule('regex', [value], message))
  }

  in<const TValue extends readonly unknown[]>(values: TValue, message?: string): ValidationFieldBuilder<TOutput> {
    assertNonEmptyArray(values, 'in')
    return this.clone(normalizeRule('in', [...values], message))
  }

  confirmed(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('confirmed', [], message))
  }

  before(value: Date | string, message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('before', [normalizeDateRuleValue(value, 'before')], message))
  }

  after(value: Date | string, message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('after', [normalizeDateRuleValue(value, 'after')], message))
  }

  beforeOrEqual(value: Date | string, message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('beforeOrEqual', [normalizeDateRuleValue(value, 'beforeOrEqual')], message))
  }

  afterOrEqual(value: Date | string, message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('afterOrEqual', [normalizeDateRuleValue(value, 'afterOrEqual')], message))
  }

  today(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('today', [], message))
  }

  beforeToday(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('beforeToday', [], message))
  }

  todayOrBefore(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('todayOrBefore', [], message))
  }

  beforeOrToday(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('beforeOrToday', [], message))
  }

  afterToday(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('afterToday', [], message))
  }

  todayOrAfter(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('todayOrAfter', [], message))
  }

  afterOrToday(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('afterOrToday', [], message))
  }

  transform(transformer: (value: TOutput) => unknown): ValidationFieldBuilder<TOutput> {
    if (typeof transformer !== 'function') {
      throw new ValidationContractError('transform must be a function.')
    }

    return this.clone(normalizeRule('transform', [transformer]))
  }

  custom(validator: (value: TOutput) => boolean | string, message?: string): ValidationFieldBuilder<TOutput> {
    if (typeof validator !== 'function') {
      throw new ValidationContractError('custom must be a function.')
    }

    return this.clone(normalizeRule('custom', [validator], message))
  }

  customAsync(validator: (value: TOutput) => Promise<boolean | string>, message?: string): ValidationFieldBuilder<TOutput> {
    if (typeof validator !== 'function') {
      throw new ValidationContractError('customAsync must be a function.')
    }

    return this.clone(normalizeRule('customAsync', [validator], message))
  }

  image(message?: string): ValidationFieldBuilder<TOutput> {
    return this.clone(normalizeRule('custom', ['image'], message))
  }

  maxSize(value: number | `${number}${'kb' | 'mb' | 'gb'}`, message?: string): ValidationFieldBuilder<TOutput> {
    if (typeof value === 'number') {
      assertFiniteNumber(value, 'maxSize')
    } else if (!value.trim()) {
      throw new ValidationContractError('maxSize must not be empty.')
    }

    return this.clone(normalizeRule('max', [value], message))
  }
}

// ---------------------------------------------------------------------------
// Field factory & array helper
// ---------------------------------------------------------------------------

export function arrayField<TItemInput extends FieldBuilderInput>(
  item: TItemInput,
): ValidationFieldBuilder<InferFieldOutput<TItemInput>[]> {
  const normalized = normalizeFieldBuilder(item)
  return new ValidationFieldBuilder<InferFieldOutput<TItemInput>[]>(createField('array', normalized.definition))
}

export const field = Object.freeze({
  string() {
    return new ValidationFieldBuilder<string>(createField('string'))
  },
  number() {
    return new ValidationFieldBuilder<number>(createField('number'))
  },
  boolean() {
    return new ValidationFieldBuilder<boolean>(createField('boolean'))
  },
  date() {
    return new ValidationFieldBuilder<Date>(createField('date'))
  },
  file() {
    return new ValidationFieldBuilder<WebFileLike>(createField('file'))
  },
  array: arrayField,
})

// ---------------------------------------------------------------------------
// Schema factory (produces Standard Schema V1 compliant objects)
// ---------------------------------------------------------------------------

export function defineSchema<TShape extends SchemaInputShape>(
  shape: TShape,
): ValidationSchema<TShape> {
  const fields = normalizeSchemaShape(shape)

  return Object.freeze({
    kind: 'schema' as const,
    fields,
    '~standard': {
      version: 1 as const,
      vendor: 'holo-js',
      validate: createSchemaStandardValidate(fields),
      types: undefined as unknown as StandardSchemaV1Types<unknown, InferSchemaData<TShape>>,
    },
  }) as ValidationSchema<TShape>
}

export const schema = defineSchema

export function isValidationSchema(value: unknown): value is ValidationSchema {
  return isPlainObject(value)
    && value.kind === 'schema'
    && isPlainObject(value.fields)
    && isPlainObject(value['~standard'])
    && typeof (value['~standard'] as Record<string, unknown>).validate === 'function'
}

// ---------------------------------------------------------------------------
// Public validate / safeParse / parse (accepts any input source)
// ---------------------------------------------------------------------------

function summarizeErrors(flattened: Record<string, readonly string[]>): string {
  const firstEntry = Object.entries(flattened)[0]
  /* v8 ignore next 3 -- parse() always has at least one error entry */
  if (!firstEntry) {
    return 'Validation failed.'
  }

  const [path, messages] = firstEntry
  /* v8 ignore next 3 -- both branches tested but v8 ternary counting */
  return path === '_root'
    ? (messages[0] ?? 'Validation failed.')
    : `${path}: ${messages[0] ?? 'Validation failed.'}`
}

async function validateInternal<TSchema extends ValidationSchema>(
  input: FormLikeValidationInput,
  schemaDefinition: TSchema,
): Promise<ValidationResult<InferSchemaData<TSchema['fields']>>> {
  const normalized = await normalizeInput(input)

  try {
    const coerced = coerceShapeInput(schemaDefinition.fields, normalized.value)
    const result = await schemaDefinition['~standard'].validate(normalized.value)

    if (result.issues) {
      const flat = issuesToFlat(result.issues)
      return {
        valid: false,
        submitted: true,
        values: coerced as Partial<InferSchemaData<TSchema['fields']>>,
        errors: createErrorBag<InferSchemaData<TSchema['fields']>>(flat),
      }
    }

    return {
      valid: true,
      submitted: true,
      data: result.value as InferSchemaData<TSchema['fields']>,
      values: result.value as InferSchemaData<TSchema['fields']>,
      errors: createErrorBag<InferSchemaData<TSchema['fields']>>(),
    }
  } catch (error) {
    const issues: Record<string, string[]> = {
      _root: [error instanceof Error ? error.message : 'Validation failed.'],
    }

    return {
      valid: false,
      submitted: true,
      values: (normalized.value ?? /* v8 ignore next */ {}) as Partial<InferSchemaData<TSchema['fields']>>,
      errors: createErrorBag<InferSchemaData<TSchema['fields']>>(issues),
    }
  }
}

export async function validate<TSchema extends ValidationSchema>(
  input: FormLikeValidationInput,
  schemaDefinition: TSchema,
): Promise<ValidationResult<InferSchemaData<TSchema['fields']>>> {
  return validateInternal(input, schemaDefinition)
}

export async function safeParse<TSchema extends ValidationSchema>(
  input: FormLikeValidationInput,
  schemaDefinition: TSchema,
): Promise<ValidationResult<InferSchemaData<TSchema['fields']>>> {
  return validateInternal(input, schemaDefinition)
}

export async function parse<TSchema extends ValidationSchema>(
  input: FormLikeValidationInput,
  schemaDefinition: TSchema,
): Promise<InferSchemaData<TSchema['fields']>> {
  const result = await validateInternal(input, schemaDefinition)
  if (!result.valid) {
    throw new ValidationContractError(summarizeErrors(result.errors.flatten()))
  }

  return result.data
}

// ---------------------------------------------------------------------------
// Internals (exposed for testing)
// ---------------------------------------------------------------------------

export const validationInternals = {
  appendIssues,
  assignNestedValue,
  buildErrorTree,
  coerceShapeInput,
  createField,
  isFieldDefinition,
  isPlainObject,
  isValidationField,
  normalizeFormData,
  normalizeIssuePath,
  normalizeRequestInput,
  normalizeSchemaShape,
  parseByteSize,
  resolveCompiledSchema,
  issuesToFlat,
  flatToStandardIssues,
}
