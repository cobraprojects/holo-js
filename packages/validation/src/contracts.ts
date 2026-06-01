import {
  type ArrayFieldBuilderInput,
  type FieldBuilderInput,
  type FieldRule,
  type InferArrayItemOutput,
  type InferFieldOutput,
  type InferSchemaData,
  type InferValidationSchemaData,
  type SchemaInputShape,
  type StandardSchemaV1,
  type StandardSchemaV1Props,
  type StandardSchemaV1Types,
  type ValidationField,
  type ValidationErrorBag,
  type ValidationResult,
  type ValidationSchema,
  type WebFileLike,
  ValidationContractError,
} from './contracts-types'
import {
  appendIssues,
  assignNestedValue,
  assertFiniteNumber,
  assertNonEmptyArray,
  buildErrorTree,
  cloneDefinition,
  coerceShapeInput,
  createErrorBag,
  createField,
  isFieldDefinition,
  isPlainObject,
  isValidationFieldBuilderLike,
  isValidationField,
  issuesToFlat,
  normalizeDateRuleValue,
  normalizeFieldBuilder,
  normalizeFormData,
  normalizeIssuePath,
  normalizeRequestInput,
  normalizeRule,
  normalizeSchemaShape,
  markDefinitionSensitive,
  parseByteSize,
  resolveCompiledSchema,
} from './contracts-support'
import { createFieldStandardValidate, createSchemaStandardValidate, flatToStandardIssues, summarizeErrors, validateInternal } from './contracts-runtime'

export * from './contracts-types'

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

  sensitive(): ValidationFieldBuilder<TOutput> {
    const nextField = Object.freeze({
      ...this.field,
      definition: markDefinitionSensitive(this.field.definition),
    }) as ValidationField<TOutput>

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

  in<const TValue extends readonly TOutput[]>(values: TValue, message?: string): ValidationFieldBuilder<TValue[number]> {
    assertNonEmptyArray(values, 'in')
    return this.clone<TValue[number]>(normalizeRule('in', [...values], message))
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

  transform<TNextOutput>(transformer: (value: TOutput) => TNextOutput): ValidationFieldBuilder<TNextOutput> {
    if (typeof transformer !== 'function') {
      throw new ValidationContractError('transform must be a function.')
    }

    return this.clone<TNextOutput>(normalizeRule('transform', [transformer]))
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

export function arrayField<TItemInput extends ArrayFieldBuilderInput>(
  item: TItemInput,
): ValidationFieldBuilder<InferArrayItemOutput<TItemInput>[]> {
  const normalized = isValidationFieldBuilderLike(item) || isValidationField(item)
    ? normalizeFieldBuilder(item)
    : normalizeSchemaShape(item as SchemaInputShape)

  const itemDefinition = isValidationField(normalized)
    ? normalized.definition
    : normalized

  return new ValidationFieldBuilder<InferArrayItemOutput<TItemInput>[]>(createField('array', itemDefinition))
}

export const field = Object.freeze({
  string() {
    return new ValidationFieldBuilder<string>(createField('string'))
  },
  password() {
    return new ValidationFieldBuilder<string>(createField('string', undefined, true))
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
export { createErrorBag }

export const DEFAULT_VALIDATION_BAG = 'default'
const validationMetadataSymbol: unique symbol = Symbol('holo.validation.metadata')
const validationValuesSymbol: unique symbol = Symbol('holo.validation.values')
let validationExceptionThrower: (<TData>(exception: ValidationException<TData>) => void) | undefined

export interface ValidationExceptionOptions {
  readonly bag?: string
}

export interface SerializedValidationException<TData = Record<string, unknown>> {
  readonly ok: false
  readonly status: number
  readonly valid: false
  readonly message: string
  readonly bag: string
  readonly values: Partial<TData>
  readonly errors: Record<string, readonly string[]>
  readonly retryAfterSeconds?: number
  readonly retryAt?: string
}

export type ValidationExceptionDigestPayload<TData = Record<string, unknown>> = {
  readonly ok: false
  readonly status: number
  readonly valid: false
  readonly message: string
  readonly bag: string
  readonly errors: Record<string, readonly string[]>
  readonly values?: Partial<TData>
  readonly retryAfterSeconds?: number
  readonly retryAt?: string
}

const VALIDATION_EXCEPTION_DIGEST_PREFIX = 'HOLO_VALIDATION;'

export class ValidationException<TData = Record<string, unknown>> extends Error {
  readonly status = 422
  readonly bag: string
  readonly errors: ValidationErrorBag<TData>
  readonly digest: string
  [validationMetadataSymbol]: Pick<SerializedValidationException<TData>, 'retryAfterSeconds' | 'retryAt'>
  [validationValuesSymbol]: Partial<TData>

  constructor(
    messages: Record<string, readonly string[]>,
    options: ValidationExceptionOptions = {},
  ) {
    super(summarizeErrors(messages))
    this.name = 'ValidationException'
    this.bag = options.bag ?? DEFAULT_VALIDATION_BAG
    this[validationMetadataSymbol] = {}
    this[validationValuesSymbol] = {}
    this.errors = createErrorBag<TData>(messages)
    this.digest = createValidationExceptionDigest(this)
  }

  get values(): Partial<TData> {
    return this[validationValuesSymbol]
  }

  static withMessages<TData = Record<string, unknown>>(
    messages: Record<string, readonly string[]>,
    options: ValidationExceptionOptions = {},
  ): ValidationException<TData> {
    return new ValidationException<TData>(messages, options)
  }

  toJSON(): SerializedValidationException<TData> {
    return {
      ok: false,
      status: this.status,
      valid: false,
      message: this.message,
      bag: this.bag,
      values: serializeValidationValues(this.values),
      errors: this.errors.flatten(),
      ...this[validationMetadataSymbol],
    }
  }
}

function serializeValidationValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }

  if (typeof value === 'undefined' || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') {
    return undefined
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return undefined
  }

  if (Array.isArray(value)) {
    const serialized: unknown[] = []
    for (const item of value) {
      const next = serializeValidationValue(item)
      if (typeof next !== 'undefined') {
        serialized.push(next)
      }
    }

    return serialized
  }

  if (!isSerializablePlainObject(value)) {
    return undefined
  }

  const serialized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const next = serializeValidationValue(item)
    if (typeof next !== 'undefined') {
      serialized[key] = next
    }
  }

  return serialized
}

function isSerializablePlainObject(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) {
    return false
  }

  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function serializeValidationValues<TData>(values: Partial<TData>): Partial<TData> {
  const serialized = serializeValidationValue(values)
  return isSerializablePlainObject(serialized) ? serialized as Partial<TData> : {}
}

function createValidationExceptionDigest<TData>(
  exception: ValidationException<TData>,
): string {
  const payload: ValidationExceptionDigestPayload<TData> = {
    ok: false,
    status: exception.status,
    valid: false,
    message: exception.message,
    bag: exception.bag,
    errors: exception.errors.flatten(),
    ...exception[validationMetadataSymbol],
  }

  return `${VALIDATION_EXCEPTION_DIGEST_PREFIX}${encodeURIComponent(JSON.stringify(payload))}`
}

function parseValidationExceptionDigest<TData = Record<string, unknown>>(
  value: unknown,
): ValidationExceptionDigestPayload<TData> | undefined {
  const digest = value
    && typeof value === 'object'
    && 'digest' in value
    && typeof (value as { readonly digest?: unknown }).digest === 'string'
    ? (value as { readonly digest: string }).digest
    : undefined

  if (!digest?.startsWith(VALIDATION_EXCEPTION_DIGEST_PREFIX)) {
    return undefined
  }

  try {
    const payload = JSON.parse(decodeURIComponent(digest.slice(VALIDATION_EXCEPTION_DIGEST_PREFIX.length))) as unknown
    if (!isPlainObject(payload)
      || payload.ok !== false
      || typeof payload.status !== 'number'
      || payload.valid !== false
      || typeof payload.message !== 'string'
      || typeof payload.bag !== 'string'
      || !isPlainObject(payload.errors)
    ) {
      return undefined
    }

    return {
      ok: false,
      status: payload.status,
      valid: false,
      message: payload.message,
      bag: payload.bag,
      errors: payload.errors as Record<string, readonly string[]>,
      ...(isPlainObject(payload.values) ? { values: payload.values as Partial<TData> } : {}),
      ...(typeof payload.retryAfterSeconds === 'number' ? { retryAfterSeconds: payload.retryAfterSeconds } : {}),
      ...(typeof payload.retryAt === 'string' ? { retryAt: payload.retryAt } : {}),
    }
  } catch {
    return undefined
  }
}

function setValidationExceptionValues<TData>(
  exception: ValidationException<TData>,
  values: Partial<TData>,
): ValidationException<TData> {
  exception[validationValuesSymbol] = values
  return exception
}

function setValidationExceptionStatus<TData>(
  exception: ValidationException<TData>,
  status: number,
): ValidationException<TData> {
  Object.defineProperty(exception, 'status', {
    value: status,
    enumerable: true,
    configurable: true,
  })
  refreshValidationExceptionDigest(exception)
  return exception
}

function setValidationExceptionMetadata<TData>(
  exception: ValidationException<TData>,
  metadata: Pick<SerializedValidationException<TData>, 'retryAfterSeconds' | 'retryAt'>,
): ValidationException<TData> {
  exception[validationMetadataSymbol] = metadata
  refreshValidationExceptionDigest(exception)
  return exception
}

function refreshValidationExceptionDigest<TData>(
  exception: ValidationException<TData>,
): void {
  Object.defineProperty(exception, 'digest', {
    value: createValidationExceptionDigest(exception),
    enumerable: true,
    configurable: true,
  })
}

function setValidationExceptionThrower(
  thrower: (<TData>(exception: ValidationException<TData>) => void) | undefined,
): void {
  validationExceptionThrower = thrower
}

function throwValidationException<TData>(exception: ValidationException<TData>): never {
  validationExceptionThrower?.(exception)
  throw exception
}

export function isValidationException(value: unknown): value is ValidationException {
  if (value instanceof ValidationException) {
    return true
  }

  if (!value || typeof value !== 'object') {
    return false
  }

  const candidate = value as {
    readonly name?: unknown
    readonly toJSON?: () => unknown
  }
  if (candidate.name !== 'ValidationException' || typeof candidate.toJSON !== 'function') {
    return false
  }

  try {
    const payload = candidate.toJSON()
    return isPlainObject(payload)
      && payload.ok === false
      && typeof payload.status === 'number'
      && payload.valid === false
      && typeof payload.bag === 'string'
      && isPlainObject(payload.values)
      && isPlainObject(payload.errors)
  } catch {
    return false
  }
}

export function isValidationSchema(value: unknown): value is ValidationSchema {
  return isPlainObject(value)
    && value.kind === 'schema'
    && isPlainObject(value.fields)
    && isPlainObject(value['~standard'])
    && typeof (value['~standard'] as Record<string, unknown>).validate === 'function'
}

export async function validate<TSchema extends ValidationSchema>(
  input: Request | FormData | URLSearchParams | Record<string, unknown>,
  schemaDefinition: TSchema,
  options: ValidationExceptionOptions = {},
): Promise<InferValidationSchemaData<TSchema>> {
  const result = await validateInternal(input, schemaDefinition)
  if (!result.valid) {
    throwValidationException(setValidationExceptionValues(
      ValidationException.withMessages(result.errors.flatten(), {
        bag: options.bag,
      }),
      result.values,
    ))
  }

  return result.data
}

export async function safeParse<TSchema extends ValidationSchema>(
  input: Request | FormData | URLSearchParams | Record<string, unknown>,
  schemaDefinition: TSchema,
): Promise<ValidationResult<InferValidationSchemaData<TSchema>>> {
  return validateInternal(input, schemaDefinition)
}

export async function parse<TSchema extends ValidationSchema>(
  input: Request | FormData | URLSearchParams | Record<string, unknown>,
  schemaDefinition: TSchema,
): Promise<InferValidationSchemaData<TSchema>> {
  const result = await validateInternal(input, schemaDefinition)
  if (!result.valid) {
    throw new ValidationContractError(summarizeErrors(result.errors.flatten()))
  }

  return result.data
}

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
  parseValidationExceptionDigest,
  resolveCompiledSchema,
  setValidationExceptionMetadata,
  setValidationExceptionStatus,
  setValidationExceptionThrower,
  setValidationExceptionValues,
  throwValidationException,
  issuesToFlat,
  flatToStandardIssues,
}
