import * as v from 'valibot'
import { fileContentSampleBytes, inspectFileContent } from '@holo-js/kernel/file-content'
import type { DecodedImageVerification } from '@holo-js/kernel/image-decoding'
import type { FieldDefinition, FieldKind, FieldRule } from './contracts-types'
import { isPlainObject, parseByteSize } from './contracts-support'

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
  readonly imageVerifications: Map<Blob, Map<FieldRule, Promise<DecodedImageVerification | undefined>>>
  readonly sizedValues: Map<FieldRule, unknown>
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

const decodableImageMimeTypes = new Set(['image/avif', 'image/gif', 'image/jpeg', 'image/png', 'image/tiff', 'image/webp'])

function imageRuleSegment(definition: FieldDefinition, rule: FieldRule): readonly FieldRule[] {
  const index = definition.rules.indexOf(rule)
  let start = index
  let end = index + 1
  while (start > 0 && definition.rules[start - 1]!.name !== 'transform') start -= 1
  while (end < definition.rules.length && definition.rules[end]!.name !== 'transform') end += 1
  return definition.rules.slice(start, end)
}

function exceedsDeclaredFileSize(rules: readonly FieldRule[], value: Blob): boolean {
  return rules.some(rule => (rule.name === 'max' && (typeof rule.args[0] === 'number' || typeof rule.args[0] === 'string') && value.size > parseByteSize(rule.args[0]))
    || (rule.name === 'size' && typeof rule.args[0] === 'number' && value.size > rule.args[0]))
}

async function verifyRasterImage(value: Blob, aspectRatios: readonly (readonly number[])[], decode: boolean): Promise<DecodedImageVerification | undefined> {
  const sample = new Uint8Array(await value.slice(0, fileContentSampleBytes).arrayBuffer())
  const { mimeType, passive } = await inspectFileContent(sample)
  if (!passive || !mimeType || !decodableImageMimeTypes.has(mimeType)) return { valid: false, aspectRatios: [] }
  if (!decode) return undefined
  const { verifyDecodedImage } = await import('@holo-js/kernel/image-decoding')
  return verifyDecodedImage(new Uint8Array(await value.arrayBuffer()), mimeType, aspectRatios)
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
  } else if (validator === 'image' || validator === 'imageAspectRatio') {
    const segment = imageRuleSegment(field.definition, rule)
    const ratioRules = segment.filter(candidate => candidate.name === 'custom' && candidate.args[0] === 'imageAspectRatio')
    let verification: DecodedImageVerification | undefined = { valid: false, aspectRatios: [] }
    if (value instanceof Blob) {
      const verifications = field.imageVerifications.get(value) ?? new Map<FieldRule, Promise<DecodedImageVerification | undefined>>()
      field.imageVerifications.set(value, verifications)
      const segmentKey = segment[0]!
      let pending = verifications.get(segmentKey)
      if (!pending) {
        pending = verifyRasterImage(
          value,
          ratioRules.map(candidate => candidate.args.slice(1).filter((ratio): ratio is number => typeof ratio === 'number')),
          !exceedsDeclaredFileSize(segment, value),
        )
        verifications.set(segmentKey, pending)
      }
      verification = await pending
    }
    if (!verification) return
    const valid = verification.valid && (validator === 'image' || verification.aspectRatios[ratioRules.indexOf(rule)] === true)
    if (!valid) {
      field.customIssues.set(rule, resolveRuleMessage(rule, validator === 'image'
        ? 'The selected file must be an image.'
        : 'The selected image must have an allowed aspect ratio.'))
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
        imageVerifications: new Map(),
        sizedValues: new Map(),
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
