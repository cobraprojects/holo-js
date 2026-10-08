import * as v from 'valibot'
import type { FieldDefinition, FieldKind, FieldRule, WebFileLike } from './contracts-types'
import { isPlainObject } from './contracts-support'

export type CompiledSchema = v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>>

export type RuleValue = {
  readonly rule: FieldRule
  readonly value: unknown
}

export type FieldExecution = {
  readonly definition: FieldDefinition
  readonly node: ExecutionNode
  readonly inputValue: unknown
  readonly requiredMissing: boolean
  shapeValue: unknown
  baseValid: boolean
  readonly checks: RuleValue[]
  readonly customIssues: Map<FieldRule, string>
  readonly confirmationResults: Map<FieldRule, boolean>
}

export type ExecutionNode = {
  readonly path: readonly string[]
  readonly parent?: ExecutionNode
  readonly children: ExecutionNode[]
  input?: unknown
  output?: unknown
  field?: FieldExecution
}

export function resolveRuleMessage(rule: FieldRule | undefined, fallback: string): string {
  return rule?.message ?? fallback
}

export async function executeCustomRule(field: FieldExecution, rule: FieldRule, value: unknown): Promise<void> {
  const validator = rule.args[0]
  if (typeof validator === 'function') {
    const result = rule.name === 'customAsync'
      ? await (validator as (input: unknown) => Promise<boolean | string>)(value)
      : (validator as (input: unknown) => boolean | string)(value)
    if (result === false) {
      field.customIssues.set(rule, resolveRuleMessage(rule, 'Validation failed.'))
    } else if (typeof result === 'string' && result.trim()) {
      field.customIssues.set(rule, result)
    }
  } else if (validator === 'image') {
    const rawMimeType = (value as WebFileLike).type
    const mimeType = typeof rawMimeType === 'string' ? rawMimeType : ''
    if (!mimeType.toLowerCase().startsWith('image/')) {
      field.customIssues.set(rule, resolveRuleMessage(rule, 'The selected file must be an image.'))
    }
  }
}

export function checkFieldConfirmations(field: FieldExecution, output: unknown, input: unknown, rawInput?: unknown): void {
  const confirmationKey = `${field.node.path.at(-1) ?? '_value'}Confirmation`
  for (const { rule, value } of field.checks) {
    if (field.confirmationResults.has(rule)) continue
    const transformed = field.definition.rules.slice(0, field.definition.rules.indexOf(rule))
      .some(previous => previous.name === 'transform')
    const parent = transformed && isPlainObject(output) && Object.hasOwn(output, confirmationKey)
      ? output
      : isPlainObject(input) && Object.hasOwn(input, confirmationKey) ? input : rawInput
    if (isPlainObject(parent)) field.confirmationResults.set(rule, parent[confirmationKey] === value)
  }
}

export function createOrderedSchemaFactory(): (compiled: CompiledSchema) => CompiledSchema {
  let previous: Promise<void | Awaited<ReturnType<CompiledSchema['~run']>>> = Promise.resolve()
  return compiled => ({
    ...v.unknown(),
    async: true,
    '~run'(dataset, config) {
      const result = previous.then(() => compiled['~run'](dataset, config))
      previous = result
      return result
    },
  })
}

export function createExecutionNode(parent?: ExecutionNode, key?: string): ExecutionNode {
  const node: ExecutionNode = {
    path: parent && key !== undefined ? [...parent.path, key] : [],
    parent,
    children: [],
  }
  parent?.children.push(node)
  return node
}

export function isMissingValue(value: unknown, kind: FieldKind): boolean {
  if (value === undefined || value === null) return true
  if (kind === 'string') return typeof value === 'string' && value.trim().length === 0
  if (kind === 'array') return Array.isArray(value) && value.length === 0
  return false
}

export function createFieldExecutionSchema(
  definition: FieldDefinition,
  node: ExecutionNode,
  compile: (field: FieldExecution, dataset: object) => CompiledSchema,
): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return {
    ...v.unknown(),
    async: true,
    async '~run'(dataset, config) {
      const defaultRule = definition.rules.find(rule => rule.name === 'default')
      const useDefault = dataset.value === undefined
        || (dataset.value === null && definition.rules.some(rule => rule.name === 'nullable'))
      const shapeValue = useDefault && defaultRule ? defaultRule.args[0] : dataset.value
      const field: FieldExecution = {
        definition,
        node,
        inputValue: shapeValue,
        shapeValue,
        requiredMissing: definition.rules.some(rule => rule.name === 'required') && isMissingValue(shapeValue, definition.kind),
        baseValid: false,
        checks: [],
        customIssues: new Map(),
        confirmationResults: new Map(),
      }
      node.field = field
      return compile(field, dataset)['~run'](dataset, config)
    },
  }
}

export function createShapeExecutionSchema(compiled: CompiledSchema, node: ExecutionNode): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return {
    ...v.unknown(),
    async: true,
    async '~run'(dataset, config) {
      node.input = dataset.value
      const result = await compiled['~run'](dataset, config)
      node.output = result.value
      for (const child of node.children) {
        if (child.field) checkFieldConfirmations(child.field, node.output, node.input)
      }
      for (const child of node.children) {
        if (!child.field) continue
        for (const [rule, matches] of child.field.confirmationResults) {
          if (!matches) {
            return v.rawCheck(({ addIssue }) => {
              addIssue({ message: resolveRuleMessage(rule, 'This field does not match its confirmation.') })
            })['~run'](result, config)
          }
        }
      }
      return result
    },
  }
}

export function createCompiledFieldSchema(
  definition: FieldDefinition,
  compiled: CompiledSchema,
  node: ExecutionNode,
): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return createFieldExecutionSchema(definition, node, field => ({
    ...v.unknown(),
    async: true,
    async '~run'(dataset, config) {
      const result = await compiled['~run'](dataset, config)
      field.baseValid = result.typed
      if (result.typed && !field.requiredMissing && field.shapeValue !== undefined && field.shapeValue !== null) {
        for (const rule of definition.rules) {
          if (rule.name === 'confirmed') field.checks.push({ rule, value: field.shapeValue })
        }
      }
      return result
    },
  }))
}
