'use client'

import { useEffect, useRef, useState } from 'react'
import type { FormSchema, InferFormData } from '@holo-js/forms'
import {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type InferFormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  createFormClient,
  markClientSubmitControlFlowError,
} from '@holo-js/forms/internal/client'
import { createNextRenderableError, normalizeNextClientHttpError, renderNextClientHttpErrorPage } from './client-errors'

export {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/internal/client'

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

function areOptionsEqual<TData, TSuccess>(
  left: UseFormOptions<TData, TSuccess>,
  right: UseFormOptions<TData, TSuccess>,
): boolean {
  return left.action === right.action
    && left.method === right.method
    && left.validateOn === right.validateOn
    && Boolean(left.submitter) === Boolean(right.submitter)
    && areEqual(left.initialValues, right.initialValues)
    && areEqual(left.initialState, right.initialState)
}

function isNextRedirectError(error: unknown): boolean {
  if (!error || (typeof error !== 'object' && typeof error !== 'function') || !('digest' in error)) {
    return false
  }

  return typeof error.digest === 'string' && error.digest.startsWith('NEXT_REDIRECT')
}

function createSubmitterBridge<TData, TSuccess>(
  optionsRef: { current: UseFormOptions<TData, TSuccess> | undefined },
  onHttpError: (error: Error) => void,
): (
  context: ClientSubmitContext<TData>,
) => Promise<ClientSubmitResult<TData, TSuccess> | void> | ClientSubmitResult<TData, TSuccess> | void {
  return async (context) => {
    const submitter = optionsRef.current?.submitter

    if (!submitter) {
      throw new TypeError('Expected submitter to be defined.')
    }

    try {
      return await submitter(context)
    } catch (error) {
      if (isNextRedirectError(error)) {
        throw markClientSubmitControlFlowError(error)
      }

      const httpError = normalizeNextClientHttpError(error)

      if (httpError) {
        renderNextClientHttpErrorPage(httpError)
        onHttpError(createNextRenderableError(httpError))
      }

      throw error
    }
  }
}

export function useForm<TSchema extends FormSchema, TSuccess = unknown>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferFormData<TSchema>, TSuccess> = {},
): UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>> {
  type TData = InferFormData<TSchema>

  const formRef = useRef<UseFormResult<TData, TSuccess, InferFormFieldTree<TSchema>> | undefined>(undefined)
  const previousSchemaRef = useRef<TSchema | undefined>(undefined)
  const previousOptionsRef = useRef<UseFormOptions<TData, TSuccess> | undefined>(undefined)
  const latestOptionsRef = useRef<UseFormOptions<TData, TSuccess> | undefined>(undefined)
  const submitterBridgeRef = useRef<UseFormOptions<TData, TSuccess>['submitter']>(undefined)
  const [httpError, setHttpError] = useState<Error | undefined>(undefined)
  const [, setVersion] = useState(0)

  if (httpError) {
    throw httpError
  }

  latestOptionsRef.current = options

  if (options.submitter && !submitterBridgeRef.current) {
    submitterBridgeRef.current = createSubmitterBridge<TData, TSuccess>(latestOptionsRef, setHttpError)
  }

  const resolvedOptions: UseFormOptions<TData, TSuccess> = options.submitter
    ? {
        ...options,
        submitter: submitterBridgeRef.current,
      }
    : options

  if (
    !formRef.current
    || previousSchemaRef.current !== schemaDefinition
  ) {
    formRef.current = createFormClient(schemaDefinition, resolvedOptions)
    previousSchemaRef.current = schemaDefinition
    previousOptionsRef.current = options
  } else {
    const previousOptions = previousOptionsRef.current as UseFormOptions<TData, TSuccess>
    if (!areOptionsEqual(previousOptions, options)) {
      formRef.current = createFormClient(schemaDefinition, resolvedOptions)
      previousOptionsRef.current = options
    }
  }

  const form = formRef.current!

  useEffect(() => form.subscribe(() => setVersion(version => version + 1)), [form])

  return form
}
