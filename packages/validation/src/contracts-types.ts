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

export interface ValidationFieldBuilderLike<TOutput = unknown> {
  readonly field: ValidationField<TOutput>
}

export type FieldBuilderInput<TOutput = unknown> = ValidationFieldBuilderLike<TOutput> | ValidationField<TOutput>

export type NormalizeFieldInput<TInput> = TInput extends ValidationFieldBuilderLike<infer TOutput>
  ? ValidationField<TOutput>
  : TInput extends ValidationField<infer TOutput>
    ? ValidationField<TOutput>
    : never

export type InferFieldOutput<TInput> = NormalizeFieldInput<TInput> extends ValidationField<infer TOutput> ? TOutput : never

export type NormalizedSchemaShape<TShape extends SchemaInputShape> = {
  readonly [K in keyof TShape]:
    TShape[K] extends FieldBuilderInput
      ? NormalizeFieldInput<TShape[K]>
      : TShape[K] extends SchemaInputShape
        ? NormalizedSchemaShape<TShape[K]>
        : never
}

export type SchemaInputShape = {
  readonly [key: string]: FieldBuilderInput | SchemaInputShape
}

export type Simplify<TValue> = { -readonly [K in keyof TValue]: TValue[K] } & {}

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
  readonly fields: NormalizedSchemaShape<TShape>
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

export type InferValidationSchemaData<TSchema extends ValidationSchema> = TSchema extends ValidationSchema<infer TShape>
  ? InferSchemaData<TShape>
  : never

export type FormLikeValidationInput = SchemaSourceInput

export type NormalizedInputSource = {
  readonly source: string
  readonly value: unknown
}

export type PostValidationContext = {
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
