import * as v from 'valibot'
import type { FieldDefinition, FieldKind, FieldRule } from './contracts-types'

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
}

export type ExecutionNode = {
  readonly path: readonly string[]
  readonly parent?: ExecutionNode
  readonly children: ExecutionNode[]
  input?: unknown
  output?: unknown
  field?: FieldExecution
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
