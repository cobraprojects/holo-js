'use client'

import { createContext, createElement, useEffect, useRef, useState, type ReactNode } from 'react'
import { usePathname } from 'next/navigation.js'
import { VALIDATION_FLASH_COOKIE } from './validation-flash-cookie'

type BrowserDocument = { cookie: string }

// Every root layout renders this provider, so it only tracks the raw flash and leaves
// parsing and @holo-js/validation to useValidationErrors(), which ships only where it's used.
export const ValidationFlashContext = createContext('')

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

  return createElement(ValidationFlashContext.Provider, { value: flash }, children)
}
