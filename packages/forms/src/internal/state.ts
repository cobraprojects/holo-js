import { createErrorBag, type ValidationErrorBag } from '@holo-js/validation'
import type { FormFailurePayload, FormSuccessPayload, SerializedFormSubmission } from '../contracts'
import { areFormValuesEqual, cloneFormValue, isPlainFormObject } from './formValues'

export function collectFormDirtyPaths(current: unknown, initial: unknown, prefix = ''): readonly string[] {
  if (areFormValuesEqual(current, initial)) return []
  if (Array.isArray(current) && Array.isArray(initial)) {
    const paths = Array.from({ length: Math.max(current.length, initial.length) }, (_, index) =>
      collectFormDirtyPaths(current[index], initial[index], prefix ? `${prefix}.${index}` : String(index)),
    ).flat()
    return paths.length > 0 ? paths : [prefix]
  }
  if (isPlainFormObject(current) && isPlainFormObject(initial)) {
    return [...new Set([...Object.keys(current), ...Object.keys(initial)])].flatMap(key =>
      collectFormDirtyPaths(current[key], initial[key], prefix ? `${prefix}.${key}` : key),
    )
  }
  return prefix ? [prefix] : []
}

export class FormClientState<TValues, TSuccess = unknown> {
  values: TValues
  initialValues: TValues
  flattenedErrors: Record<string, readonly string[]>
  touched = new Set<string>()
  dirty = new Set<string>()
  lastSubmission?: SerializedFormSubmission<TValues> | FormFailurePayload<TValues> | FormSuccessPayload<TSuccess>
  readonly listeners = new Set<() => void>()
  validationSequence = 0
  readonly #submissions = new Set<symbol>()

  constructor(values: TValues, initialState?: SerializedFormSubmission<TValues> | FormFailurePayload<TValues>) {
    this.values = cloneFormValue(values)
    this.initialValues = cloneFormValue(values)
    this.flattenedErrors = { ...initialState?.errors }
    this.lastSubmission = initialState
  }

  get submitting(): boolean {
    return this.#submissions.size > 0
  }

  get errors(): ValidationErrorBag<TValues> {
    return createErrorBag<TValues>(this.flattenedErrors)
  }

  get dirtyPaths(): readonly string[] {
    return collectFormDirtyPaths(this.values, this.initialValues)
  }

  replace(values: TValues, initialValues: TValues, errors: Record<string, readonly string[]>, touched: ReadonlySet<string>): void {
    this.values = values
    this.initialValues = initialValues
    this.flattenedErrors = errors
    this.touched = new Set(touched)
    this.dirty = new Set(this.dirtyPaths)
  }

  startSubmission(signal?: AbortSignal): () => void {
    const id = Symbol()
    const finish = (): void => {
      signal?.removeEventListener('abort', finish)
      this.#submissions.delete(id)
    }
    if (!signal?.aborted) {
      this.#submissions.add(id)
      signal?.addEventListener('abort', finish, { once: true })
    }
    return finish
  }
}
