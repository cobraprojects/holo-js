import * as v from 'valibot'
import { exactSizeAction, minAction, maxAction, asPipeItem, stringSchema, numberSchema, booleanSchema, dateSchema, emailAction, urlAction, uuidAction, integerAction } from './compiler-actions'
import type { FieldRule, FieldDefinition, SchemaInputShape, SupportedRuleFamily, WebFileLike } from './contracts-types'
import { isFieldDefinition, isValidationFieldBuilderLike, isValidationField, normalizeFieldBuilder, isWebFileLike } from './contracts-support'

import { createExecutionNode, createOrderedSchemaFactory, executeCustomRule, createFieldExecutionSchema, createShapeExecutionSchema, type ExecutionNode, type FieldExecution, type CompiledSchema } from './contracts-execution'

function getRule(definition: FieldDefinition, name: SupportedRuleFamily): FieldRule | undefined {
  return definition.rules.find(rule => rule.name === name)
}

function hasRule(definition: FieldDefinition, name: SupportedRuleFamily): boolean {
  return definition.rules.some(rule => rule.name === name)
}

type SchemaPlan = {
  readonly schema: CompiledSchema | ((node: ExecutionNode) => CompiledSchema)
  readonly hasCustomRules: boolean
}

const rulesRequiringExecution = new Set<SupportedRuleFamily>([
  'required', 'confirmed', 'custom', 'customAsync', 'before', 'after', 'beforeOrEqual',
  'afterOrEqual', 'today', 'beforeToday', 'todayOrBefore', 'beforeOrToday', 'afterToday',
  'todayOrAfter', 'afterOrToday',
])

function makeCompiledArrayItemSchema(plan: SchemaPlan, parent: ExecutionNode): CompiledSchema {
  if (typeof plan.schema !== 'function') return plan.schema
  const compile = plan.schema
  return {
    ...v.unknown(),
    async: true,
    async '~run'(dataset, config) {
      const node = createExecutionNode(parent, String(parent.children.length))
      return compile(node)['~run'](dataset, config)
    },
  }
}

function makeBaseSchema(definition: FieldDefinition, executionFor?: (dataset: object) => FieldExecution, itemPlan?: SchemaPlan): v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  switch (definition.kind) {
    case 'string':
      return stringSchema()
    case 'number':
      return numberSchema()
    case 'boolean':
      return booleanSchema()
    case 'date':
      return dateSchema()
    case 'file':
      return v.custom<WebFileLike>(value => isWebFileLike(value), 'The selected file must be a file.')
    case 'array': {
      if (!executionFor) throw new Error('Validation array execution is missing.')
      if (!itemPlan) throw new Error('Validation array item plan is missing.')
      return {
        ...v.unknown(),
        async: true,
        async '~run'(dataset, config) {
          const node = executionFor(dataset).node
          const item = makeCompiledArrayItemSchema(itemPlan, node)
          const compiledItem = itemPlan.hasCustomRules ? createOrderedSchemaFactory()(item) : item
          return v.arrayAsync(compiledItem, 'This field must be a list.')['~run'](dataset, config)
        },
      }
    }
  }
}

function compileFieldPipeline(definition: FieldDefinition, executionFor?: (dataset: object) => FieldExecution, itemPlan?: SchemaPlan): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> {
  const actions: (v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>>)[] = []
  if (executionFor) actions.push(v.rawCheck(({ dataset, addIssue }) => {
    const execution = executionFor(dataset)
    execution.shapeValue = dataset.value
    execution.baseValid = dataset.typed
    if (execution.requiredMissing) addIssue({ message: 'This field is required.' })
  }))

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
        actions.push(asPipeItem(emailAction(rule.message)))
        break
      case 'url':
        actions.push(asPipeItem(urlAction(rule.message)))
        break
      case 'uuid':
        actions.push(asPipeItem(uuidAction(rule.message)))
        break
      case 'integer':
        actions.push(asPipeItem(integerAction(rule.message)))
        break
      case 'regex':
        if (rule.args[0] instanceof RegExp) {
          actions.push(asPipeItem(v.regex(rule.args[0], rule.message ?? 'This field format is invalid.')))
        }
        break
      case 'in': {
        const allowed = new Set(rule.args)
        actions.push(asPipeItem(v.check((input: unknown) => allowed.has(input), rule.message ?? 'This field must be one of the allowed values.')))
        break
      }
      case 'custom':
      case 'customAsync':
        if (!executionFor) throw new Error('Validation rule execution is missing.')
        actions.push(v.rawCheckAsync(async ({ dataset }) => {
          const execution = executionFor(dataset)
          if (dataset.typed && !execution.requiredMissing) {
            await executeCustomRule(execution, rule, dataset.value)
          }
        }))
        break
      case 'confirmed':
        if (!executionFor) throw new Error('Validation rule execution is missing.')
        actions.push(v.rawCheck(({ dataset }) => {
          const execution = executionFor(dataset)
          if (dataset.typed && !execution.requiredMissing) {
            execution.checks.push({ rule, value: dataset.value })
          }
        }))
        break
      case 'transform':
        if (typeof rule.args[0] === 'function') {
          actions.push(asPipeItem(v.transform(rule.args[0] as (input: unknown) => unknown)))
        }
        break
      default:
        break
    }
  }

  let schema: v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> = v.pipeAsync(makeBaseSchema(definition, executionFor, itemPlan), ...actions)

  const defaultRule = getRule(definition, 'default')
  const hasNullable = hasRule(definition, 'nullable')
  const hasOptional = hasRule(definition, 'optional') || typeof defaultRule !== 'undefined'

  if (hasNullable) {
    schema = v.nullableAsync(schema, defaultRule?.args[0])
  }

  if (hasOptional) {
    schema = v.optionalAsync(schema, defaultRule?.args[0])
  }

  return schema
}

function compileFieldPlan(definition: FieldDefinition): SchemaPlan {
  const item = definition.item
  const itemPlan = definition.kind !== 'array' ? undefined : !item
    ? { schema: v.unknown(), hasCustomRules: false }
    : isFieldDefinition(item) ? compileFieldPlan(item) : compileShapePlan(item)
  const hasCustomRules = definition.rules.some(rule => rule.name === 'custom' || rule.name === 'customAsync')
    || (itemPlan?.hasCustomRules ?? false)
  const needsExecution = definition.kind === 'array'
    || definition.rules.some(rule => rulesRequiringExecution.has(rule.name)
      || (definition.kind === 'file' && (rule.name === 'max' || rule.name === 'size')))
  if (!needsExecution) return { schema: compileFieldPipeline(definition), hasCustomRules }

  const executions = new WeakMap<object, FieldExecution>()
  const compiled = compileFieldPipeline(definition, dataset => {
    const execution = executions.get(dataset)
    if (!execution) throw new Error('Validation field execution is missing.')
    return execution
  }, itemPlan)
  return {
    hasCustomRules,
    schema: node => createFieldExecutionSchema(definition, node, (execution, dataset) => {
      executions.set(dataset, execution)
      return compiled
    }),
  }
}

export function makeCompiledFieldSchema(definition: FieldDefinition, node = createExecutionNode()): CompiledSchema {
  const plan = compileFieldPlan(definition)
  return typeof plan.schema === 'function' ? plan.schema(node) : plan.schema
}

function compileShapePlan(shape: SchemaInputShape): SchemaPlan {
  const entries = Object.entries(shape).map(([key, value]) => {
    const plan = isValidationFieldBuilderLike(value) || isValidationField(value)
      ? compileFieldPlan(normalizeFieldBuilder(value).definition)
      : compileShapePlan(value as SchemaInputShape)
    return { key, plan }
  })
  const hasCustomRules = entries.some(({ plan }) => plan.hasCustomRules)
  return {
    hasCustomRules,
    schema: parent => {
      const ordered = hasCustomRules ? createOrderedSchemaFactory() : undefined
      return createShapeExecutionSchema(v.objectAsync(Object.fromEntries(
        entries.map(({ key, plan }) => {
          const compiled = typeof plan.schema === 'function' ? plan.schema(createExecutionNode(parent, key)) : plan.schema
          return [key, ordered ? ordered(compiled) : compiled]
        }),
      )), parent)
    },
  }
}

export function resolveCompiledSchema(fields: SchemaInputShape, node = createExecutionNode()): CompiledSchema {
  const plan = compileShapePlan(fields)
  return typeof plan.schema === 'function' ? plan.schema(node) : plan.schema
}
