import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation.js'
import type { ValidationErrorBag } from '@holo-js/validation'
import { DEFAULT_VALIDATION_BAG, createErrorBag } from '@holo-js/validation/internal/error-bag'
import { useRequestValidationFlash } from '@holo-js/adapter-next/internal/request-validation-flash'
import { VALIDATION_FLASH_COOKIE, parseValidationFlash, validationFlashPage, type ValidationFlash } from './validation-flash'

type BrowserDocument = { cookie: string }

// One flash per document, shared by every useValidationErrors() call. `path` is unset until a
// call mounts on a page; a page that mounts without a server-rendered flash drops leftover cookies.
type DocumentFlash = { value: string, path: string | undefined }

let documentFlash: DocumentFlash | undefined
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

function show(flash: DocumentFlash, value: string): void {
  if (flash.value === value) return
  flash.value = value
  for (const listener of listeners) listener()
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

export function useValidationErrors<TData = Record<string, unknown>>(bag = DEFAULT_VALIDATION_BAG): ValidationErrorBag<TData> {
  const pathname = usePathname()
  const requestFlash = useRequestValidationFlash()
  const value = useSyncExternalStore(subscribe, () => (documentFlash ??= { value: requestFlash, path: undefined }).value, () => requestFlash)

  useEffect(() => {
    mountedCalls++
    return () => {
      mountedCalls--
      // Leaving the page unmounts every call; a remount in the same commit keeps the errors.
      setTimeout(() => {
        if (mountedCalls > 0 || !documentFlash) return
        documentFlash.path = undefined
        show(documentFlash, '')
        clearFlashCookie()
      })
    }
  }, [])

  // Runs after every render, so a router refresh after a server action reads the new cookie.
  useEffect(() => {
    const flash = documentFlash ??= { value: requestFlash, path: undefined }
    if (flash.path === undefined) {
      flash.path = pathname
      if (!flash.value) clearFlashCookie()
      return
    }
    if (flash.path !== pathname) {
      flash.path = pathname
      clearFlashCookie()
    }
    show(flash, readFlashCookie())
  })

  const flash = useMemo(() => readableValidationFlash(value), [value])
  return createErrorBag<TData>(flash?.bag === bag && flash.page === validationFlashPage(pathname) ? flash.errors : {})
}
