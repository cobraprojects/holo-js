'use client'

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { refreshUser as refreshCurrentUser } from '@holo-js/auth/client'
import type { AuthClientRequestOptions, HoloAuthUser } from '@holo-js/auth/client'
import type { FormSchema, InferFormData } from '@holo-js/forms'
import {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type InferFormFieldTree,
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
export type { HoloAuthUser } from '@holo-js/auth/client'

export type UseAuthOptions = AuthClientRequestOptions & {
  readonly initialUser?: HoloAuthUser | null
}

export type UseAuthResult = {
  readonly authenticated: boolean
  readonly user: HoloAuthUser | null
  readonly refreshUser: () => Promise<HoloAuthUser | null>
}

export type AuthProviderProps = UseAuthOptions & {
  readonly children: ReactNode
}

const AuthContext = createContext<UseAuthResult | null>(null)

function useAuthState(options: UseAuthOptions = {}): UseAuthResult {
  const { initialUser, ...requestOptions } = options
  const [currentUser, setCurrentUser] = useState<HoloAuthUser | null>(initialUser ?? null)
  const requestOptionsRef = useRef<AuthClientRequestOptions>(requestOptions)

  requestOptionsRef.current = requestOptions

  const refreshUser = useCallback(async () => {
    const nextUser = await refreshCurrentUser(requestOptionsRef.current)
    setCurrentUser(nextUser)
    return nextUser
  }, [])

  useEffect(() => {
    if (typeof initialUser === 'undefined') {
      void refreshUser()
    }
  }, [initialUser, refreshUser])

  return {
    authenticated: currentUser !== null,
    user: currentUser,
    refreshUser,
  }
}

export function AuthProvider({ children, ...options }: AuthProviderProps): ReactNode {
  const auth = useAuthState(options)

  return createElement(AuthContext.Provider, { value: auth }, children)
}

export function useAuth(options?: UseAuthOptions): UseAuthResult {
  const context = useContext(AuthContext)
  if (!options && context) {
    return context
  }

  return useAuthState(options)
}

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
    && left.csrf === right.csrf
    && left.validateOn === right.validateOn
    && Boolean(left.submitter) === Boolean(right.submitter)
    && areEqual(left.initialValues, right.initialValues)
    && areEqual(left.initialState, right.initialState)
}

function createSubmitterBridge<TData, TSuccess>(
  optionsRef: { current: UseFormOptions<TData, TSuccess> | undefined },
): (
  context: ClientSubmitContext<TData>,
) => Promise<ClientSubmitResult<TData, TSuccess>> | ClientSubmitResult<TData, TSuccess> {
  return (context) => {
    const submitter = optionsRef.current?.submitter

    if (!submitter) {
      throw new TypeError('Expected submitter to be defined.')
    }

    return submitter(context)
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
  const [, setVersion] = useState(0)

  latestOptionsRef.current = options

  if (options.submitter && !submitterBridgeRef.current) {
    submitterBridgeRef.current = createSubmitterBridge<TData, TSuccess>(latestOptionsRef)
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
    formRef.current = createForm(schemaDefinition, resolvedOptions)
    previousSchemaRef.current = schemaDefinition
    previousOptionsRef.current = options
  } else {
    const previousOptions = previousOptionsRef.current as UseFormOptions<TData, TSuccess>
    if (!areOptionsEqual(previousOptions, options)) {
      formRef.current = createForm(schemaDefinition, resolvedOptions)
      previousOptionsRef.current = options
    }
  }

  const form = formRef.current!

  useEffect(() => form.subscribe(() => setVersion(version => version + 1)), [form])

  return form
}
