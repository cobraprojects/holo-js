'use client'

import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation.js'
import { DEFAULT_VALIDATION_BAG, createErrorBag, type ValidationErrorBag } from '@holo-js/validation'
import { VALIDATION_FLASH_COOKIE, parseValidationFlash, validationFlashPage, type ValidationFlash } from './validation-flash'

type BrowserDocument = { cookie: string }

const ValidationFlashContext = createContext<ValidationFlash | undefined>(undefined)

function browserDocument(): BrowserDocument | undefined {
  return (globalThis as { readonly document?: BrowserDocument }).document
}

function readFlashCookie(): string {
  const prefix = `${VALIDATION_FLASH_COOKIE}=`
  const cookie = browserDocument()?.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))
  if (!cookie) return ''
  try {
    return decodeURIComponent(cookie.slice(prefix.length))
  } catch {
    return ''
  }
}

function readableValidationFlash(value: string): ValidationFlash | undefined {
  const flash = parseValidationFlash(value)
  if (!flash) return undefined
  try {
    createErrorBag(flash.errors)
    return flash
  } catch {
    return undefined
  }
}

function clearFlashCookie(): void {
  const document = browserDocument()
  if (document) document.cookie = `${VALIDATION_FLASH_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax`
}

export function HoloValidationErrorsProvider({ initial = '', children }: { readonly initial?: string, readonly children?: ReactNode }): ReactNode {
  const pathname = usePathname()
  const [flash, setFlash] = useState(initial)
  const mounted = useRef(false)
  const shownPath = useRef(pathname)

  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      if (!initial) clearFlashCookie()
      return
    }
    if (shownPath.current !== pathname) {
      shownPath.current = pathname
      clearFlashCookie()
    }
    setFlash(readFlashCookie())
  })

  const value = useMemo(() => readableValidationFlash(flash), [flash])
  return createElement(ValidationFlashContext.Provider, { value }, children)
}

export function useValidationErrors<TData = Record<string, unknown>>(bag = DEFAULT_VALIDATION_BAG): ValidationErrorBag<TData> {
  const flash = useContext(ValidationFlashContext)
  const pathname = usePathname()
  return createErrorBag<TData>(flash?.bag === bag && flash.page === validationFlashPage(pathname) ? flash.errors : {})
}

function validationErrorsClientLayout<TProps extends object>(layout: (props: TProps) => ReactNode): (props: TProps) => ReactNode {
  return props => createElement(HoloValidationErrorsProvider, null, createElement(layout, props))
}

export const adapterNextClientLayoutInternals = {
  validationErrorsClientLayout,
}
