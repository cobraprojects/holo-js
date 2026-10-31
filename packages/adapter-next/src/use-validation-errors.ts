import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation.js'
import { LayoutRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import type { ValidationErrorBag } from '@holo-js/validation'
import { DEFAULT_VALIDATION_BAG, createErrorBag } from '@holo-js/validation/internal/error-bag'
import { documentValidationFlash, useRequestValidationFlash } from '@holo-js/adapter-next/internal/request-validation-flash'
import { VALIDATION_FLASH_COOKIE, parseValidationFlash, validationFlashPage, type ValidationFlash } from './validation-flash'

type BrowserDocument = { cookie: string }

// One flash per document, shared by every useValidationErrors() call. `path` is the page the flash
// was read on, unset until a call mounts.
let shown = ''
let shownPath: string | undefined
let mountedCalls = 0
const listeners = new Set<() => void>()

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

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function show(flash: string): void {
  if (shown === flash) return
  shown = flash
  for (const listener of listeners) listener()
}

/**
 * Runs once when a page first loads the hook, before any of its forms can post: a cookie found now
 * was left by an earlier page load, unless the server rendered its errors into this page.
 */
function startDocument(): void {
  if (!browserDocument()) return
  shown = documentValidationFlash()
  shownPath = undefined
  if (!shown) clearFlashCookie()
}

startDocument()

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

export function useValidationErrors<TData = Record<string, unknown>>(bag = DEFAULT_VALIDATION_BAG): ValidationErrorBag<TData> {
  const pathname = usePathname()
  // Next gives this context a new value whenever the router applies a refresh, such as the one after
  // a server action sets the error cookie, so even memoized components rerender and read it.
  useContext(LayoutRouterContext)
  const requestFlash = useRequestValidationFlash()
  const value = useSyncExternalStore(subscribe, () => shown, () => requestFlash)

  useEffect(() => {
    mountedCalls++
    return () => {
      mountedCalls--
      // Leaving the page unmounts every call; a remount in the same commit keeps the errors.
      setTimeout(() => {
        if (mountedCalls > 0 || shownPath === undefined) return
        shownPath = undefined
        clearFlashCookie()
        show('')
      })
    }
  }, [])

  useEffect(() => {
    if (shownPath !== undefined && shownPath !== pathname) clearFlashCookie()
    shownPath = pathname
    show(readFlashCookie())
  })

  const flash = useMemo(() => readableValidationFlash(value), [value])
  return createErrorBag<TData>(flash?.bag === bag && flash.page === validationFlashPage(pathname) ? flash.errors : {})
}

export const adapterNextValidationErrorsInternals = {
  startDocument,
}
