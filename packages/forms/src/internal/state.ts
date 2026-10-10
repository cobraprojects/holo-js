import { createErrorBag, type ValidationErrorBag } from '@holo-js/validation'
import type { FormFailurePayload, FormSuccessPayload, SerializedFormSubmission } from '../contracts'
import { areFormValuesEqual, cloneFormValue, getFormValueAtPath, isPlainFormObject, mergeFormValues, setFormValueAtPath } from './formValues'

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
  readonly touched = new Set<string>()
  lastSubmission?: SerializedFormSubmission<TValues> | FormFailurePayload<TValues> | FormSuccessPayload<TSuccess>
  readonly listeners = new Set<() => void>()
  #validationSequence = 0
  #submissionSequence = 0
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

  notify(): void {
    for (const listener of this.listeners) listener()
  }

  invalidateEffects(): void {
    this.#validationSequence += 1
    this.#submissionSequence += 1
  }

  beginValidation(): number {
    return ++this.#validationSequence
  }

  isLatestValidation(sequence: number): boolean {
    return sequence === this.#validationSequence
  }

  beginSubmissionEffects(): number {
    this.#validationSequence += 1
    return ++this.#submissionSequence
  }

  ownsSubmissionEffects(sequence: number): boolean {
    return sequence === this.#submissionSequence
  }

  touch(path: string): void {
    this.touched.add(path)
  }

  edit(path: string, value: unknown): void {
    this.invalidateEffects()
    setFormValueAtPath(this.values as Record<string, unknown>, path, value)
    this.touch(path)
  }

  isDirty(path: string): boolean {
    return !areFormValuesEqual(getFormValueAtPath(this.values, path), getFormValueAtPath(this.initialValues, path))
  }

  applyValidation(sequence: number, errors: Record<string, readonly string[]>, values?: Partial<TValues>): void {
    if (!this.isLatestValidation(sequence)) return
    if (values) this.values = mergeFormValues(this.values, values)
    this.flattenedErrors = errors
    this.notify()
  }

  applyFieldValidation(sequence: number, path: string, errors: Record<string, readonly string[]>): void {
    if (!this.isLatestValidation(sequence)) return
    const prefix = `${path}.`
    const merged = Object.fromEntries(Object.entries(this.flattenedErrors).filter(([key]) => key !== path && !key.startsWith(prefix)))
    for (const [key, messages] of Object.entries(errors)) {
      if (key === path || key.startsWith(prefix)) merged[key] = messages
    }
    this.applyValidation(sequence, merged)
  }

  applyServer(values: TValues, errors: Record<string, readonly string[]>, submission: FormClientState<TValues, TSuccess>['lastSubmission']): void {
    this.#validationSequence += 1
    this.values = values
    this.flattenedErrors = errors
    this.lastSubmission = submission
    this.notify()
  }

  reset(values?: Partial<TValues>): void {
    const next = mergeFormValues(this.initialValues, values)
    this.invalidateEffects()
    this.values = cloneFormValue(next)
    this.initialValues = cloneFormValue(next)
    this.flattenedErrors = {}
    this.touched.clear()
    this.lastSubmission = undefined
    this.notify()
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
