'use client'

import { createContext, createElement, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { refreshUser as refreshCurrentUser } from '../client'
import type { AuthClientRequestOptions, HoloAuthUser } from '../contracts'

export type { HoloAuthUser } from '../contracts'

type UseAuthRequestOptions = Pick<AuthClientRequestOptions, 'endpoint' | 'guard' | 'headers'>

export type UseAuthOptions = UseAuthRequestOptions & {
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

function hasExplicitUseAuthOptions(options: UseAuthOptions | undefined): options is UseAuthOptions {
  return typeof options !== 'undefined'
    && Object.values(options).some(value => typeof value !== 'undefined')
}

function useAuthState(
  options: UseAuthOptions = {},
  stateOptions: { readonly refreshOnMount?: boolean } = {},
): UseAuthResult {
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
    if (stateOptions.refreshOnMount !== false && typeof initialUser === 'undefined') {
      void refreshUser()
    }
  }, [initialUser, refreshUser, stateOptions.refreshOnMount])

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
  const hasOptions = hasExplicitUseAuthOptions(options)
  const localAuth = useAuthState(options, {
    refreshOnMount: hasOptions || !context,
  })

  if (!hasOptions && context) {
    return context
  }

  return localAuth
}
