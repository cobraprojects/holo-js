import {
  type FieldBuilderInput,
  type FieldRule,
  type InferFieldOutput,
  type InferSchemaData,
  type InferValidationSchemaData,
  type SchemaInputShape,
  type StandardSchemaV1,
  type StandardSchemaV1Props,
  type StandardSchemaV1Types,
  type ValidationField,
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
  isValidationField,
  issuesToFlat,
  normalizeDateRuleValue,
  normalizeFieldBuilder,
  normalizeFormData,
  normalizeIssuePath,
  normalizeRequestInput,
  normalizeRule,
  normalizeSchemaShape,
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
): Promise<ValidationResult<InferValidationSchemaData<TSchema>>> {
  return validateInternal(input, schemaDefinition)
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
  resolveCompiledSchema,
  issuesToFlat,
  flatToStandardIssues,
}
