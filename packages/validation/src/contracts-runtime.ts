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
  isFieldDefinition,
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
  /* v8 ignore next 8 -- public rule builders normalize Date arguments to ISO strings before runtime resolution */
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      return undefined
    }

    return value
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

function formatByteSizeLimit(value: number | string, bytes: number): string {
  if (typeof value === 'number') {
    return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`
  }

  const trimmed = value.trim()
  return `${trimmed.slice(0, -2)} ${trimmed.slice(-2).toUpperCase()}`
}

function getRule(definition: FieldDefinition, name: FieldRule['name']): FieldRule | undefined {
  return definition.rules.find(rule => rule.name === name)
}

function hasRule(definition: FieldDefinition, name: FieldRule['name']): boolean {
  return definition.rules.some(rule => rule.name === name)
}

function isMissingValue(value: unknown, kind: FieldKind): boolean {
  if (typeof value === 'undefined' || value === null) {
    return true
  }

  if (kind === 'string') {
    return typeof value === 'string' && value.trim().length === 0
  }

  if (kind === 'array') {
    return Array.isArray(value) && value.length === 0
  }

  return false
}

function collectRequiredMissingPaths(
  shape: SchemaInputShape,
  data: Record<string, unknown>,
  path: readonly string[] = [],
  target = new Set<string>(),
): Set<string> {
  for (const [key, value] of Object.entries(shape)) {
    const isFieldLike = isPlainObject(value)
      && ('field' in value || (typeof value.kind === 'string' && value.kind === 'field' && 'definition' in value))
    const nextPath = [...path, key]

    if (isFieldLike) {
      const fieldDef = normalizeFieldBuilder(value as unknown as FieldBuilderInput).definition
      if (getRule(fieldDef, 'required') && isMissingValue(data[key], fieldDef.kind)) {
        target.add(toIssuePath(nextPath))
      }
      if (fieldDef.kind === 'array' && fieldDef.item && Array.isArray(data[key])) {
        for (const [index, item] of (data[key] as unknown[]).entries()) {
          const itemPath = [...nextPath, String(index)]
          if (isFieldDefinition(fieldDef.item)) {
            if (getRule(fieldDef.item, 'required') && isMissingValue(item, fieldDef.item.kind)) {
              target.add(toIssuePath(itemPath))
            }
          } else {
            collectRequiredMissingPaths(fieldDef.item, item as Record<string, unknown>, itemPath, target)
          }
        }
      }
      continue
    }

    collectRequiredMissingPaths(value as SchemaInputShape, data[key] as Record<string, unknown>, nextPath, target)
  }

  return target
}

function resolveShapeRuleValue(definition: FieldDefinition, outputValue: unknown, inputValue: unknown): unknown {
  if (!hasRule(definition, 'transform')) {
    return outputValue
  }

  if (getRule(definition, 'default') && isMissingValue(inputValue, definition.kind)) {
    return outputValue
  }

  return inputValue
}

async function applyPostFieldRules(
  definition: FieldDefinition,
  value: unknown,
  inputValue: unknown,
  context: PostValidationContext,
  issues: Record<string, string[]>,
): Promise<void> {
  const shapeRuleValue = resolveShapeRuleValue(definition, value, inputValue)
  const requiredRule = getRule(definition, 'required')
  if (requiredRule && isMissingValue(shapeRuleValue, definition.kind)) {
    prependIssue(issues, context.path, resolveRuleMessage(requiredRule, 'This field is required.'))
    return
  }

  if (typeof shapeRuleValue === 'undefined' || shapeRuleValue === null) {
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
          const rawMimeType = (value as WebFileLike).type
          const mimeType = typeof rawMimeType === 'string' ? rawMimeType : ''
          if (!mimeType.toLowerCase().startsWith('image/')) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, 'The selected file must be an image.'))
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
        const dateValue = shapeRuleValue instanceof Date ? shapeRuleValue : resolveDateRuleValue(shapeRuleValue)
        if (!dateValue) {
          pushIssue(issues, context.path, 'This field must be a valid date.')
          break
        }

        const targetDate = resolveDateRuleValue(rule.args[0])
        const todayStart = startOfToday()
        const todayEnd = endOfToday()

        if (rule.name === 'before' && targetDate && !(dateValue.getTime() < targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `This field must be before ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'after' && targetDate && !(dateValue.getTime() > targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `This field must be after ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'beforeOrEqual' && targetDate && !(dateValue.getTime() <= targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `This field must be before or equal to ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'afterOrEqual' && targetDate && !(dateValue.getTime() >= targetDate.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, `This field must be after or equal to ${targetDate.toISOString()}.`))
        }

        if (rule.name === 'today' && !isSameLocalDay(dateValue, todayStart)) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'This field must be today.'))
        }

        if (rule.name === 'beforeToday' && !(dateValue.getTime() < todayStart.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'This field must be before today.'))
        }

        if ((rule.name === 'todayOrBefore' || rule.name === 'beforeOrToday') && !(dateValue.getTime() <= todayEnd.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'This field must be today or before.'))
        }

        if (rule.name === 'afterToday' && !(dateValue.getTime() > todayEnd.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'This field must be after today.'))
        }

        if ((rule.name === 'todayOrAfter' || rule.name === 'afterOrToday') && !(dateValue.getTime() >= todayStart.getTime())) {
          pushIssue(issues, context.path, resolveRuleMessage(rule, 'This field must be today or after.'))
        }

        break
      }
      case 'max': {
        const fileSize = (shapeRuleValue as WebFileLike).size
        if (definition.kind === 'file' && typeof fileSize === 'number') {
          const rawLimit = rule.args[0] as number | string
          const limit = parseByteSize(rawLimit)
          if (fileSize > limit) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, `The selected file must be ${formatByteSizeLimit(rawLimit, limit)} or smaller.`))
          }
        }
        break
      }
      case 'size': {
        if (definition.kind === 'file' && typeof (shapeRuleValue as WebFileLike).size === 'number' && typeof rule.args[0] === 'number') {
          if ((shapeRuleValue as WebFileLike).size !== rule.args[0]) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, `The selected file must be exactly ${formatByteSizeLimit(rule.args[0], rule.args[0])}.`))
          }
        }
        break
      }
      default:
        break
    }
  }
}

async function applyPostFieldRulesRecursively(
  definition: FieldDefinition,
  value: unknown,
  inputValue: unknown,
  context: PostValidationContext,
  issues: Record<string, string[]>,
): Promise<void> {
  await applyPostFieldRules(definition, value, inputValue, context, issues)

  if (definition.kind !== 'array' || !definition.item || !Array.isArray(value)) {
    return
  }

  const inputItems = Array.isArray(inputValue) ? inputValue : /* v8 ignore next */ value

  for (const [index, item] of value.entries()) {
    const key = String(index)
    const nextPath = [...context.path, key]

    if (isFieldDefinition(definition.item)) {
      await applyPostFieldRulesRecursively(definition.item, item, inputItems[index], {
        root: context.root,
        parent: value,
        key,
        path: nextPath,
      }, issues)
      continue
    }

    await applyPostValidation(definition.item, item, context.root, issues, nextPath, inputItems[index])
  }
}

async function applyPostValidation(
  shape: SchemaInputShape,
  data: unknown,
  root: unknown,
  issues: Record<string, string[]>,
  path: readonly string[] = [],
  inputData: unknown = data,
): Promise<void> {
  const current = isPlainObject(data) ? data : /* v8 ignore next */ {}
  const inputCurrent = isPlainObject(inputData) ? inputData : /* v8 ignore next */ current

  for (const [key, value] of Object.entries(shape)) {
    const isFieldLike = isPlainObject(value)
      && ('field' in value || (typeof value.kind === 'string' && value.kind === 'field' && 'definition' in value))
    if (isFieldLike) {
      const fieldDef = normalizeFieldBuilder(value as unknown as FieldBuilderInput)
      const nextPath = [...path, key]
      const nextValue = current[key]
      await applyPostFieldRulesRecursively(fieldDef.definition, nextValue, inputCurrent[key], {
        root,
        parent: current,
        key,
        path: nextPath,
      }, issues)
      continue
    }

    await applyPostValidation(value as SchemaInputShape, current[key], root, issues, [...path, key], inputCurrent[key])
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
  const requiredMissingPaths = collectRequiredMissingPaths(fields, coerced)

  if (!result.success) {
    appendIssues(issues, result.issues)
    for (const path of requiredMissingPaths) {
      delete issues[path]
    }
  }

  const postTarget = result.success ? result.output : coerced
  await applyPostValidation(fields, postTarget, postTarget, issues, [], coerced)

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
    appendIssues(issues, result.issues)
    if (getRule(definition, 'required') && isMissingValue(coerced, definition.kind)) {
      delete issues._root
    }
  }

  const postTarget = result.success ? result.output : coerced
  await applyStandaloneFieldPostRules(definition, postTarget, coerced, issues)

  if (Object.keys(issues).length > 0) {
    return { success: false, output: postTarget, issues }
  }

  return { success: true, output: result.success ? result.output : /* v8 ignore next */ coerced, issues }
}

async function applyStandaloneFieldPostRules(
  definition: FieldDefinition,
  value: unknown,
  inputValue: unknown,
  issues: Record<string, string[]>,
): Promise<void> {
  await applyPostFieldRulesRecursively(definition, value, inputValue, {
    root: value,
    parent: null,
    key: '_value',
    path: [],
  }, issues)
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
      values: normalized.value as Partial<InferValidationSchemaData<TSchema>>,
      errors: createErrorBag<InferValidationSchemaData<TSchema>>(issues),
    }
  }
}
