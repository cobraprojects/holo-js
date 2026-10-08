import * as v from 'valibot'
import {
  type FieldDefinition,
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
  normalizeFormData,
  normalizeRequestInput,
  parseByteSize,
} from './contracts-support'

import { createExecutionNode, type CompiledSchema, type ExecutionNode, type FieldExecution } from './contracts-execution'

type RuntimePostValidationContext = PostValidationContext & {
  readonly inputParent?: unknown
  readonly rawInputParent?: unknown
}

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

function hasRuleBefore(definition: FieldDefinition, selectedRule: FieldRule, name: FieldRule['name']): boolean {
  const selectedRuleIndex = definition.rules.indexOf(selectedRule)
  return definition.rules.slice(0, selectedRuleIndex).some(rule => rule.name === name)
}

function hasOwnProperty(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key)
}

function resolveConfirmationParent(context: RuntimePostValidationContext, confirmationKey: string, useOutputParent: boolean): unknown {
  if (useOutputParent && isPlainObject(context.parent) && hasOwnProperty(context.parent, confirmationKey)) {
    return context.parent
  }

  if (isPlainObject(context.inputParent) && hasOwnProperty(context.inputParent, confirmationKey)) {
    return context.inputParent
  }

  return context.rawInputParent
}

async function applyFieldChecks(
  execution: FieldExecution,
  context: RuntimePostValidationContext,
  issues: Record<string, string[]>,
): Promise<void> {
  const { definition, shapeValue: shapeRuleValue } = execution
  const requiredRule = getRule(definition, 'required')
  if (requiredRule && execution.requiredMissing) {
    delete issues[toIssuePath(context.path) || '_root']
    prependIssue(issues, context.path, resolveRuleMessage(requiredRule, 'This field is required.'))
    return
  }

  if (!execution.baseValid || shapeRuleValue === undefined || shapeRuleValue === null) return

  const captured = new Map(execution.checks.map(check => [check.rule, check.value]))
  for (const rule of definition.rules) {
    if ((rule.name === 'custom' || rule.name === 'customAsync' || rule.name === 'confirmed') && !captured.has(rule)) continue
    const orderedRuleValue = captured.get(rule)
    switch (rule.name) {
      case 'custom': {
        const validator = rule.args[0]
        if (typeof validator === 'function') {
          const result = validator(orderedRuleValue)
          if (result === false) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, 'Validation failed.'))
          } else if (typeof result === 'string' && result.trim()) {
            pushIssue(issues, context.path, result)
          }
        } else if (validator === 'image') {
          const rawMimeType = (orderedRuleValue as WebFileLike).type
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
          const result = await validator(orderedRuleValue)
          if (result === false) {
            pushIssue(issues, context.path, resolveRuleMessage(rule, 'Validation failed.'))
          } else if (typeof result === 'string' && result.trim()) {
            pushIssue(issues, context.path, result)
          }
        }
        break
      }
      case 'confirmed': {
        const confirmationKey = `${context.key}Confirmation`
        const parent = resolveConfirmationParent(context, confirmationKey, hasRuleBefore(definition, rule, 'transform'))
        if (parent !== null && isPlainObject(parent)) {
          if (parent[confirmationKey] !== orderedRuleValue) {
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

function valueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const key of path) {
    if (Array.isArray(current)) current = current[Number(key)]
    else if (isPlainObject(current) && hasOwnProperty(current, key)) current = current[key]
    else return undefined
  }
  return current
}

async function applyExecutionChecks(
  node: ExecutionNode,
  output: unknown,
  rawInput: unknown,
  issues: Record<string, string[]>,
): Promise<void> {
  if (node.field) {
    const parentPath = node.path.slice(0, -1)
    await applyFieldChecks(node.field, {
      root: output,
      parent: node.parent?.field ? node.parent.field.shapeValue : node.parent?.output ?? null,
      inputParent: node.parent?.field ? node.parent.field.inputValue : node.parent?.input ?? null,
      rawInputParent: node.path.length ? valueAtPath(rawInput, parentPath) : null,
      key: node.path.at(-1) ?? '_value',
      path: node.path,
    }, issues)
  }
  for (const child of node.children) {
    await applyExecutionChecks(child, output, rawInput, issues)
  }
}

async function runValidation(
  coerced: unknown,
  rawInput: unknown,
  compile: (node: ExecutionNode) => CompiledSchema,
): Promise<{ success: boolean; output: unknown; issues: Record<string, string[]> }> {
  const execution = createExecutionNode()
  const compiled = compile(execution)
  const result = await v.safeParseAsync(compiled, coerced)
  const issues: Record<string, string[]> = {}

  if (!result.success) {
    appendIssues(issues, result.issues)
  }

  await applyExecutionChecks(execution, result.output, rawInput, issues)

  return { success: Object.keys(issues).length === 0, output: result.output, issues }
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
  compile: (node: ExecutionNode) => CompiledSchema,
): (value: unknown) => Promise<StandardSchemaV1Result<InferSchemaData<TShape>>> {
  return async (value: unknown) => {
    const result = await runValidation(coerceShapeInput(fields, value), value, compile)
    if (!result.success) {
      return { issues: flatToStandardIssues(result.issues) }
    }
    return { value: result.output as InferSchemaData<TShape> }
  }
}

export function createFieldStandardValidate<TOutput>(
  definition: FieldDefinition,
  compile: (node: ExecutionNode) => CompiledSchema,
): (value: unknown) => Promise<StandardSchemaV1Result<TOutput>> {
  return async (value: unknown) => {
    const result = await runValidation(coerceFieldValue(definition, value), value, compile)
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
