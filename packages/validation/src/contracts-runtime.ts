import * as v from 'valibot'
import {
  type FieldBuilderInput,
  type FieldDefinition,
  type FieldKind,
  type FormLikeValidationInput,
  type InferSchemaData,
  type InferValidationSchemaData,
  type PostValidationContext,
  type SchemaInputShape,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Result,
  type ValidationResult,
  type ValidationSchema,
  ValidationContractError,
  type WebFileLike,
  type FieldRule,
} from './contracts-types'
import {
  appendIssues,
  coerceFieldValue,
  coerceShapeInput,
  createErrorBag,
  isPlainObject,
  issuesToFlat,
  makeCompiledFieldSchema,
  normalizeFieldBuilder,
  normalizeFormData,
  normalizeRequestInput,
  parseByteSize,
  resolveCompiledSchema,
} from './contracts-support'

function resolveDateRuleValue(value: unknown): Date | undefined {
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

function getRule(definition: FieldDefinition, name: FieldRule['name']): FieldRule | undefined {
  return definition.rules.find(rule => rule.name === name)
}

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
    const isFieldLike = isPlainObject(value)
      && ('field' in value || (typeof value.kind === 'string' && value.kind === 'field' && 'definition' in value))
    if (isFieldLike) {
      const fieldDef = normalizeFieldBuilder(value as unknown as FieldBuilderInput)
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

export function flatToStandardIssues(flat: Record<string, string[]>): StandardSchemaV1Issue[] {
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

export function createSchemaStandardValidate<TShape extends SchemaInputShape>(
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
  await applyPostFieldRules(definition, value, {
    root: value,
    parent: null,
    key: '_value',
    path: [],
  }, issues)

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

export function createFieldStandardValidate<TOutput>(
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

export function summarizeErrors(flattened: Record<string, readonly string[]>): string {
  const firstEntry = Object.entries(flattened)[0]
  if (!firstEntry) {
    return 'Validation failed.'
  }

  const [path, messages] = firstEntry
  return path === '_root'
    ? (messages[0] ?? 'Validation failed.')
    : `${path}: ${messages[0] ?? 'Validation failed.'}`
}

async function normalizeInput(input: FormLikeValidationInput) {
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

export async function validateInternal<TSchema extends ValidationSchema>(
  input: FormLikeValidationInput,
  schemaDefinition: TSchema,
): Promise<ValidationResult<InferValidationSchemaData<TSchema>>> {
  const normalized = await normalizeInput(input)

  try {
    const coerced = coerceShapeInput(schemaDefinition.fields, normalized.value)
    const result = await schemaDefinition['~standard'].validate(normalized.value)

    if (result.issues) {
      const flat = issuesToFlat(result.issues)
      return {
        valid: false,
        submitted: true,
        values: coerced as Partial<InferValidationSchemaData<TSchema>>,
        errors: createErrorBag<InferValidationSchemaData<TSchema>>(flat),
      }
    }

    return {
      valid: true,
      submitted: true,
      data: result.value as InferValidationSchemaData<TSchema>,
      values: result.value as InferValidationSchemaData<TSchema>,
      errors: createErrorBag<InferValidationSchemaData<TSchema>>(),
    }
  } catch (error) {
    const issues: Record<string, string[]> = {
      _root: [error instanceof Error ? error.message : 'Validation failed.'],
    }

    return {
      valid: false,
      submitted: true,
      values: (normalized.value ?? /* v8 ignore next */ {}) as Partial<InferValidationSchemaData<TSchema>>,
      errors: createErrorBag<InferValidationSchemaData<TSchema>>(issues),
    }
  }
}
