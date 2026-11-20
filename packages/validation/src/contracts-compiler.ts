import * as v from 'valibot'
import { exactSizeAction, digitsAction, minAction, maxAction, asPipeItem, stringSchema, numberSchema, booleanSchema, dateSchema, emailAction, urlAction, uuidAction, integerAction } from './compiler-actions'
import type { FieldRule, FieldDefinition, SchemaInputShape, SupportedRuleFamily, WebFileLike } from './contracts-types'
import { assertDigitCount, declaredListLimit, isFieldDefinition, isPlainObject, isValidationFieldBuilderLike, isValidationField, normalizeFieldBuilder, isWebFileLike } from './contracts-support'

import { confirmationFieldKey, createExecutionNode, createOrderedSchemaFactory, executeCustomRule, createFieldExecutionSchema, createShapeExecutionSchema, usesConfirmationOutput, type ExecutionNode, type FieldExecution, type CompiledSchema } from './contracts-execution'
import { unionBranchIssue } from './contracts-runtime'
import { createObjectContainer } from './error-bag'
import { validateCurrentPassword } from './current-password'

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
  'required', 'confirmed', 'currentPassword', 'custom', 'customAsync', 'before', 'after', 'beforeOrEqual',
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

function makeUnionAlternative(plan: SchemaPlan, field: ExecutionNode): CompiledSchema {
  if (typeof plan.schema !== 'function') return plan.schema
  const compile = plan.schema
  return {
    ...v.unknown(),
    async: true,
    async '~run'(dataset, config) {
      const node: ExecutionNode = { path: field.path, parent: field.parent, rawInput: field.rawInput, children: [] }
      const result = await compile(node)['~run'](dataset, config)
      const issue = result.typed ? await unionBranchIssue(node, result.issues ? undefined : config) : undefined
      return issue === undefined ? result : v.check(() => false, issue)['~run'](result, config)
    },
  }
}

function makeConstraintAction(definition: FieldDefinition, rule: FieldRule) {
  const value = rule.args[0]
  if (typeof value !== 'number') return undefined
  switch (rule.name) {
    case 'min':
      return asPipeItem(minAction(definition, value, rule.message))
    case 'max':
      if (definition.kind !== 'file') return asPipeItem(maxAction(definition, value, rule.message))
      break
    case 'size':
      if (definition.kind !== 'file') return asPipeItem(exactSizeAction(definition, value, rule.message))
      break
  }
  return undefined
}

function makeListLimitSchema(definition: FieldDefinition): CompiledSchema {
  const actions = []
  for (const rule of definition.rules) {
    if (rule.name === 'transform') break
    const action = makeConstraintAction(definition, rule)
    if (action) actions.push(action)
  }
  return v.pipeAsync(v.unknown(), ...actions)
}

function makeBaseSchema(definition: FieldDefinition, executionFor?: (dataset: object) => FieldExecution, itemPlan?: SchemaPlan, alternatives: readonly SchemaPlan[] = []): CompiledSchema {
  switch (definition.kind) {
    case 'string':
      return stringSchema(definition.typeMessage)
    case 'number':
      return numberSchema(definition.typeMessage)
    case 'boolean':
      return booleanSchema(definition.typeMessage)
    case 'date':
      return dateSchema(definition.typeMessage)
    case 'file':
      return v.custom<WebFileLike>(value => isWebFileLike(value), 'The selected file must be a file.')
    case 'union': {
      if (!executionFor) throw new Error('Validation union execution is missing.')
      return {
        ...v.unknown(),
        async: true,
        async '~run'(dataset, config) {
          const node = executionFor(dataset).node
          const branches = alternatives.map(plan => makeUnionAlternative(plan, node))
          const result = await v.unionAsync(branches, 'This field must match one of the allowed types.')['~run'](dataset, config)
          return Object.assign(dataset, result)
        },
      }
    }
    case 'array': {
      if (!executionFor) throw new Error('Validation array execution is missing.')
      if (!itemPlan) throw new Error('Validation array item plan is missing.')
      const listLimit = declaredListLimit(definition)
      const listLimitSchema = listLimit === undefined ? undefined : makeListLimitSchema(definition)
      return {
        ...v.unknown(),
        async: true,
        async '~run'(dataset, config) {
          if (listLimit !== undefined && listLimitSchema && Array.isArray(dataset.value) && dataset.value.length > listLimit) {
            const limited = await listLimitSchema['~run'](dataset, config)
            return Object.assign(limited, { typed: false as const })
          }
          const node = executionFor(dataset).node
          const item = makeCompiledArrayItemSchema(itemPlan, node)
          const compiledItem = itemPlan.hasCustomRules ? createOrderedSchemaFactory()(item) : item
          return v.arrayAsync(compiledItem, 'This field must be a list.')['~run'](dataset, config)
        },
      }
    }
  }
}

function compileFieldPipeline(definition: FieldDefinition, executionFor?: (dataset: object) => FieldExecution, itemPlan?: SchemaPlan, alternatives?: readonly SchemaPlan[]): CompiledSchema {
  const actions: (v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>>)[] = []
  if (executionFor) actions.push(v.rawCheck(({ dataset, addIssue }) => {
    const execution = executionFor(dataset)
    execution.shapeValue = dataset.value
    execution.baseValid = dataset.typed
    if (execution.requiredMissing) addIssue({ message: 'This field is required.' })
  }))

  for (const rule of definition.rules) {
    if (executionFor && definition.kind === 'file' && (rule.name === 'max' || rule.name === 'size')) {
      actions.push(v.rawCheck(({ dataset }) => {
        executionFor(dataset).sizedValues.set(rule, dataset.value)
      }))
    }
    switch (rule.name) {
      case 'min':
      case 'max':
      case 'size': {
        const action = makeConstraintAction(definition, rule)
        if (action) actions.push(action)
        break
      }
      case 'digits':
      case 'minDigits':
      case 'maxDigits': {
        const count = rule.args[0]
        assertDigitCount(count, rule.name)
        actions.push(asPipeItem(digitsAction(rule.name, count, rule.message)))
        break
      }
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
          const pattern = new RegExp(rule.args[0])
          actions.push(asPipeItem(v.check((input: string) => {
            pattern.lastIndex = 0
            return pattern.test(input)
          }, rule.message ?? 'This field format is invalid.')))
        }
        break
      case 'in': {
        const allowed = new Set(rule.args)
        actions.push(asPipeItem(v.check((input: unknown) => allowed.has(input), rule.message ?? 'This field must be one of the allowed values.')))
        break
      }
      case 'currentPassword':
        if (!executionFor) throw new Error('Validation rule execution is missing.')
        actions.push(v.rawCheckAsync(async ({ dataset, addIssue }) => {
          const execution = executionFor(dataset)
          if (dataset.typed && !execution.requiredMissing
            && !await validateCurrentPassword(dataset.value, rule.args[0])) {
            const message = rule.message ?? 'The password is incorrect.'
            execution.customIssues.set(rule, message)
            addIssue({ message })
          }
        }))
        break
      case 'custom':
      case 'customAsync':
        if (!executionFor) throw new Error('Validation rule execution is missing.')
        actions.push(v.rawCheckAsync(async ({ dataset, addIssue }) => {
          const execution = executionFor(dataset)
          if (dataset.typed && !execution.requiredMissing) {
            await executeCustomRule(execution, rule, dataset.value)
            const message = execution.customIssues.get(rule)
            if (message !== undefined) addIssue({ message })
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

  let schema: v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> = v.pipeAsync(makeBaseSchema(definition, executionFor, itemPlan, alternatives), ...actions)

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

function compileFieldPlan(definition: FieldDefinition, strict = false): SchemaPlan {
  const item = definition.item
  const itemPlan = definition.kind !== 'array' ? undefined : !item
    ? { schema: v.unknown(), hasCustomRules: false }
    : isFieldDefinition(item) ? compileFieldPlan(item, strict) : compileShapePlan(item, strict)
  const alternatives = definition.alternatives?.map(alternative => compileFieldPlan(alternative, true))
  const hasCustomRules = definition.rules.some(rule => rule.name === 'custom' || rule.name === 'customAsync')
    || (itemPlan?.hasCustomRules ?? false)
    || (alternatives?.some(plan => plan.hasCustomRules) ?? false)
  const needsExecution = definition.kind === 'array' || definition.kind === 'union'
    || definition.rules.some(rule => rulesRequiringExecution.has(rule.name)
      || (definition.kind === 'file' && (rule.name === 'max' || rule.name === 'size')))
  if (!needsExecution) return { schema: compileFieldPipeline(definition), hasCustomRules }

  const executions = new WeakMap<object, FieldExecution>()
  const compiled = compileFieldPipeline(definition, dataset => {
    const execution = executions.get(dataset)
    if (!execution) throw new Error('Validation field execution is missing.')
    return execution
  }, itemPlan, alternatives)
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

function unionUsesConfirmationOutput(definition: FieldDefinition): boolean {
  return definition.alternatives?.some(branch =>
    branch.rules.some(rule => rule.name === 'confirmed' && usesConfirmationOutput(branch, rule))
    || unionUsesConfirmationOutput(branch)) ?? false
}

type ShapeEntry = { readonly key: string; readonly confirmationKey?: string; readonly schema: CompiledSchema }
type SchemaRun = CompiledSchema['~run']

function compileShapeEntries(entries: readonly ShapeEntry[], parent: ExecutionNode, hasCustomRules: boolean): Record<string, CompiledSchema> {
  const ordered = hasCustomRules ? createOrderedSchemaFactory() : undefined
  if (!entries.some(entry => entry.confirmationKey !== undefined)) {
    return Object.fromEntries(entries.map(({ key, schema }) => [key, ordered ? ordered(schema) : schema]))
  }

  const byKey = new Map(entries.map((entry, index) => [entry.key, { ...entry, index }]))
  const output = createObjectContainer()
  parent.output = output
  const runs = new Map<string, Promise<Awaited<ReturnType<SchemaRun>>>>()
  const waiting = new Set<string>()
  function run(entry: ShapeEntry, dataset: Parameters<SchemaRun>[0], config: Parameters<SchemaRun>[1]) {
    const existing = runs.get(entry.key)
    if (existing) return existing
    const pending = Promise.resolve().then(async () => {
      const result = await entry.schema['~run'](dataset, config)
      output[entry.key] = result.value
      return result
    })
    runs.set(entry.key, pending)
    return pending
  }

  function canRunWhileWaiting(entry: ShapeEntry): boolean {
    let current: ShapeEntry | undefined = entry
    while (current) {
      if (waiting.has(current.key)) return false
      current = current.confirmationKey === undefined ? undefined : byKey.get(current.confirmationKey)
    }
    return true
  }

  parent.resolveConfirmation = async (field, config) => {
    const source = byKey.get(field)
    const peer = byKey.get(confirmationFieldKey(field))
    const input = parent.input
    if (!source || !peer || !isPlainObject(input) || !Object.hasOwn(input, peer.key)) return

    waiting.add(field)
    try {
      if (ordered) {
        for (const entry of entries.slice(source.index + 1, peer.index)) {
          if (Object.hasOwn(input, entry.key) && canRunWhileWaiting(entry)) {
            await run(entry, { value: input[entry.key] }, config)
          }
        }
      }
      await run(peer, { value: input[peer.key] }, config)
    } finally {
      waiting.delete(field)
    }
  }

  return Object.fromEntries(entries.map(entry => {
    const schema: CompiledSchema = {
      ...entry.schema,
      async: true,
      '~run': (dataset, config) => run(entry, dataset, config),
    }
    return [entry.key, ordered ? ordered(schema) : schema]
  }))
}

function isRecordInput(value: unknown): value is Record<string, unknown> {
  if (!isPlainObject(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === null || prototype === Object.prototype
}

function compileShapePlan(shape: SchemaInputShape, strict = false): SchemaPlan {
  const entries = Object.entries(shape).map(([key, value]) => {
    if (isValidationFieldBuilderLike(value) || isValidationField(value)) {
      const definition = normalizeFieldBuilder(value).definition
      return {
        key,
        plan: compileFieldPlan(definition, strict),
        confirmationKey: unionUsesConfirmationOutput(definition) ? confirmationFieldKey(key) : undefined,
      }
    }
    return { key, plan: compileShapePlan(value as SchemaInputShape, strict) }
  })
  const strictInput = strict ? v.pipe(
    v.custom<Record<string, unknown>>(isRecordInput, 'This field must be an object.'),
    v.transform((input): unknown => Object.fromEntries(entries.map(({ key }) => [key, Object.hasOwn(input, key) ? input[key] : undefined]))),
  ) : undefined
  const hasCustomRules = entries.some(({ plan }) => plan.hasCustomRules)
  return {
    hasCustomRules,
    schema: parent => {
      const compiledEntries = entries.map(({ key, plan, confirmationKey }) => {
        const compiled = typeof plan.schema === 'function' ? plan.schema(createExecutionNode(parent, key)) : plan.schema
        return { key, confirmationKey, schema: compiled }
      })
      const compiled = createShapeExecutionSchema(v.objectAsync(compileShapeEntries(compiledEntries, parent, hasCustomRules)), parent)
      return strictInput ? v.pipeAsync(strictInput, compiled) : compiled
    },
  }
}

export function resolveCompiledSchema(fields: SchemaInputShape, node = createExecutionNode()): CompiledSchema {
  const plan = compileShapePlan(fields)
  return typeof plan.schema === 'function' ? plan.schema(node) : plan.schema
}
