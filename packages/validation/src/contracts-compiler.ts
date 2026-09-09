import * as v from 'valibot'
import { exactSizeAction, minAction, maxAction, asPipeItem, stringSchema, numberSchema, booleanSchema, dateSchema, emailAction, urlAction, uuidAction, integerAction } from './compiler-actions'
import type { FieldRule, FieldDefinition, SchemaInputShape, SupportedRuleFamily, WebFileLike } from './contracts-types'
import { isFieldDefinition, isValidationFieldBuilderLike, isValidationField, normalizeFieldBuilder, isWebFileLike } from './contracts-support'

function getRule(definition: FieldDefinition, name: SupportedRuleFamily): FieldRule | undefined {
  return definition.rules.find(rule => rule.name === name)
}

function hasRule(definition: FieldDefinition, name: SupportedRuleFamily): boolean {
  return definition.rules.some(rule => rule.name === name)
}

function makeCompiledArrayItemSchema(item: FieldDefinition['item']): v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  if (!item) return v.unknown()
  if (isFieldDefinition(item)) {
    return makeCompiledFieldSchema(item)
  }

  return v.objectAsync(compileSchemaShape(item))
}

function makeBaseSchema(definition: FieldDefinition): v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
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
    case 'array':
      return v.arrayAsync(makeCompiledArrayItemSchema(definition.item) as v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>>, 'This field must be a list.')
  }
}

export function makeCompiledFieldSchema(definition: FieldDefinition): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> {
  let schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>> | v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> = makeBaseSchema(definition)
  const actions: (v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>>)[] = []

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
      case 'transform':
        if (typeof rule.args[0] === 'function') {
          actions.push(asPipeItem(v.transform(rule.args[0] as (input: unknown) => unknown)))
        }
        break
      default:
        break
    }
  }

  if (actions.length > 0) {
    schema = v.pipeAsync(schema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, ...actions)
  }

  const defaultRule = getRule(definition, 'default')
  const hasNullable = hasRule(definition, 'nullable')
  const hasOptional = hasRule(definition, 'optional') || typeof defaultRule !== 'undefined'

  if (hasNullable) {
    schema = v.nullable(schema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, defaultRule?.args[0] as never)
  }

  if (hasOptional) {
    schema = v.optional(schema as v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>, defaultRule?.args[0] as never)
  }

  return schema
}

function compileSchemaShape(shape: SchemaInputShape): v.ObjectEntries {
  return Object.fromEntries(
    Object.entries(shape).map(([key, value]) => {
      if (isValidationFieldBuilderLike(value) || isValidationField(value)) {
        return [key, makeCompiledFieldSchema(normalizeFieldBuilder(value).definition)]
      }

      return [key, v.objectAsync(compileSchemaShape(value as SchemaInputShape))]
    }),
  )
}

export function resolveCompiledSchema(fields: SchemaInputShape): v.BaseSchemaAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return v.objectAsync(compileSchemaShape(fields))
}

