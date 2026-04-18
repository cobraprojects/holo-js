import { useEffect, useRef, useState } from 'react'
import type { InferSchemaData } from '@holo-js/forms'
import {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type UseFormOptions,
  type UseFormResult,
  useForm as createForm,
} from '@holo-js/forms/client'

export {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/client'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Blob)
}

function areEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true
  }

  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime()
  }

  if (left instanceof Blob || right instanceof Blob) {
    return false
  }

  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((value, index) => areEqual(value, right[index]))
  }

  if (isPlainObject(left) && isPlainObject(right)) {
    const leftKeys = Object.keys(left)
    const rightKeys = Object.keys(right)

    return leftKeys.length === rightKeys.length
      && leftKeys.every(key => key in right && areEqual(left[key], right[key]))
  }

  return false
}

function areOptionsEqual<TData>(left: UseFormOptions<TData>, right: UseFormOptions<TData>): boolean {
  return left.action === right.action
    && left.method === right.method
    && left.csrf === right.csrf
    && left.validateOn === right.validateOn
    && Boolean(left.submitter) === Boolean(right.submitter)
    && areEqual(left.initialValues, right.initialValues)
    && areEqual(left.initialState, right.initialState)
}

function createSubmitterBridge<TData>(
  optionsRef: { current: UseFormOptions<TData> | undefined },
): ((context: ClientSubmitContext<TData>) => Promise<ClientSubmitResult<TData>> | ClientSubmitResult<TData>) {
  return (context) => {
    const submitter = optionsRef.current?.submitter

    if (!submitter) {
      throw new TypeError('Expected submitter to be defined.')
    }

    return submitter(context)
  }
}

export function useForm<TSchema extends Parameters<typeof createForm>[0]>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferSchemaData<TSchema['fields']>> = {},
): UseFormResult<InferSchemaData<TSchema['fields']>> {
  type TData = InferSchemaData<TSchema['fields']>

  const formRef = useRef<UseFormResult<TData>>()
  const previousSchemaRef = useRef<TSchema>()
  const previousOptionsRef = useRef<UseFormOptions<TData>>()
  const latestOptionsRef = useRef<UseFormOptions<TData>>()
  const submitterBridgeRef = useRef<UseFormOptions<TData>['submitter']>()
  const [, setVersion] = useState(0)

  latestOptionsRef.current = options

  if (options.submitter && !submitterBridgeRef.current) {
    submitterBridgeRef.current = createSubmitterBridge<TData>(latestOptionsRef)
  }

  const resolvedOptions: UseFormOptions<TData> = options.submitter
    ? {
        ...options,
        submitter: submitterBridgeRef.current,
      }
    : options

  if (
    !formRef.current
    || previousSchemaRef.current !== schemaDefinition
  ) {
    formRef.current = createForm(schemaDefinition, resolvedOptions)
    previousSchemaRef.current = schemaDefinition
    previousOptionsRef.current = options
  } else {
    const previousOptions = previousOptionsRef.current as UseFormOptions<TData>
    if (!areOptionsEqual(previousOptions, options)) {
      formRef.current = createForm(schemaDefinition, resolvedOptions)
      previousOptionsRef.current = options
    }
  }

  const form = formRef.current

  useEffect(() => form.subscribe(() => setVersion(version => version + 1)), [form])

  return form
}
