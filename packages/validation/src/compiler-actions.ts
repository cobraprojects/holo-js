import * as v from 'valibot'
import type { FieldDefinition, FieldKind } from './contracts-types'

export function exactSizeAction(definition: FieldDefinition, value: number, message?: string) {
  const fallback = message ?? defaultSizeMessage(definition.kind, value)

  if (definition.kind === 'string' || definition.kind === 'array') {
    return v.length(value, fallback)
  }

  return v.check((input: unknown) => input === value, fallback)
}

export function minAction(definition: FieldDefinition, value: number, message?: string) {
  const fallback = message ?? defaultMinMessage(definition.kind, value)

  if (definition.kind === 'string' && !definition.sensitive) {
    return v.check((input: unknown) => typeof input === 'string' && input.trim().length >= value, fallback)
  }

  if (definition.kind === 'string' || definition.kind === 'array') {
    return v.minLength(value, fallback)
  }

  return v.minValue(value, fallback)
}

export function maxAction(definition: FieldDefinition, value: number, message?: string) {
  const fallback = message ?? defaultMaxMessage(definition.kind, value)

  if (definition.kind === 'string' || definition.kind === 'array') {
    return v.maxLength(value, fallback)
  }

  return v.maxValue(value, fallback)
}

function defaultMaxMessage(kind: FieldKind, value: number): string {
  if (kind === 'string') {
    return `This field must be ${value} ${pluralize(value, 'character', 'characters')} or fewer.`
  }

  if (kind === 'array') {
    return `This field must contain ${value} ${pluralize(value, 'item', 'items')} or fewer.`
  }

  return `This field must be ${value} or less.`
}

function defaultMinMessage(kind: FieldKind, value: number): string {
  if (kind === 'string') {
    return `This field must be at least ${value} ${pluralize(value, 'character', 'characters')}.`
  }

  if (kind === 'array') {
    return `This field must contain at least ${value} ${pluralize(value, 'item', 'items')}.`
  }

  return `This field must be ${value} or greater.`
}

function defaultSizeMessage(kind: FieldKind, value: number): string {
  if (kind === 'string') {
    return `This field must be exactly ${value} ${pluralize(value, 'character', 'characters')}.`
  }

  if (kind === 'array') {
    return `This field must contain exactly ${value} ${pluralize(value, 'item', 'items')}.`
  }

  return `This field must be exactly ${value}.`
}

function pluralize(value: number, singular: string, plural: string): string {
  return value === 1 ? singular : plural
}

export function asPipeItem(value: unknown): v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>> {
  return value as v.PipeItem<unknown, unknown, v.BaseIssue<unknown>> | v.PipeItemAsync<unknown, unknown, v.BaseIssue<unknown>>
}

export function stringSchema() { return v.string('This field must be text.') }
export function numberSchema() { return v.number('This field must be a number.') }
export function booleanSchema() { return v.boolean('This field must be true or false.') }
export function dateSchema() { return v.date('This field must be a valid date.') }
export function emailAction(message?: string) { return v.email(message ?? 'This field must be a valid email address.') }
export function urlAction(message?: string) { return v.url(message ?? 'This field must be a valid URL.') }
export function uuidAction(message?: string) { return v.uuid(message ?? 'This field must be a valid UUID.') }
export function integerAction(message?: string) { return v.integer(message ?? 'This field must be an integer.') }
