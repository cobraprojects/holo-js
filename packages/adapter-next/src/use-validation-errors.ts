import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react'
import { usePathname } from 'next/navigation.js'
import { LayoutRouterContext } from 'next/dist/shared/lib/app-router-context.shared-runtime.js'
import type { ValidationErrorBag } from '@holo-js/validation'
import { DEFAULT_VALIDATION_BAG, createErrorBag } from '@holo-js/validation/internal/error-bag'
import { documentValidationFlash, useRequestValidationFlash } from '@holo-js/adapter-next/internal/request-validation-flash'
import { VALIDATION_FLASH_COOKIE, parseValidationFlash, validationFlashPage, type ValidationFlash } from './validation-flash'

type BrowserDocument = { cookie: string }
type FlashCookie = { readonly flash: string, readonly seen: boolean }

// A hook that shows a failure marks its cookie seen instead of deleting it, so the server still clears
// it on the next successful submission, and a page load that finds a seen cookie knows it is stale.
const SEEN = '~'

// One flash per document, shared by every useValidationErrors() call. `shownPath` and `shownLocation`
// are the page it was read on, unset until a call mounts.
let shown = ''
let shownPath: string | undefined
let shownLocation: string | undefined
let mountedCalls = 0
const listeners = new Set<() => void>()

function browserDocument(): BrowserDocument | undefined {
  return (globalThis as { readonly document?: BrowserDocument }).document
}

function locationPath(): string | undefined {
  return (globalThis as { readonly location?: { readonly pathname: string } }).location?.pathname
}

function rawFlashCookie(): string {
  const prefix = `${VALIDATION_FLASH_COOKIE}=`
  return browserDocument()?.cookie.split(';').map(part => part.trim()).find(part => part.startsWith(prefix))?.slice(prefix.length) ?? ''
}

function readFlashCookie(): FlashCookie {
  const raw = rawFlashCookie()
  const seen = raw.startsWith(SEEN)
  try {
    return { flash: decodeURIComponent(seen ? raw.slice(SEEN.length) : raw), seen }
  } catch {
    return { flash: '', seen }
  }
}

function markFlashCookieSeen(): void {
  const document = browserDocument()
  const raw = rawFlashCookie()
  if (!document || !raw || raw.startsWith(SEEN)) return
  const secure = (globalThis as { readonly location?: { readonly protocol: string } }).location?.protocol === 'https:' ? '; Secure' : ''
  document.cookie = `${VALIDATION_FLASH_COOKIE}=${SEEN}${raw}; Path=/; SameSite=Lax${secure}`
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

/** Runs when a page first loads the hook. */
function startDocument(): void {
  if (!browserDocument()) return
  shown = documentValidationFlash()
  shownPath = undefined
  shownLocation = undefined
  const cookie = readFlashCookie()
  // Shown on an earlier page load, which this one replaced.
  if (cookie.seen) clearFlashCookie()
  // Posted without JavaScript: the server rendered these errors into this page.
  else if (shown && cookie.flash === shown) markFlashCookieSeen()
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
      // Leaving the page unmounts every call, and Next has moved to the new address by the next task.
      // Calls that unmount on the same page, such as a collapsed summary, keep the errors.
      setTimeout(() => {
        if (mountedCalls > 0 || shownPath === undefined || locationPath() === shownLocation) return
        shownPath = undefined
        shownLocation = undefined
        clearFlashCookie()
        show('')
      })
    }
  }, [])

  useEffect(() => {
    if (shownPath !== undefined && shownPath !== pathname) clearFlashCookie()
    shownPath = pathname
    shownLocation = locationPath()
    const cookie = readFlashCookie()
    if (cookie.flash && !cookie.seen) markFlashCookieSeen()
    show(cookie.flash)
  })

  const flash = useMemo(() => readableValidationFlash(value), [value])
  return createErrorBag<TData>(flash?.bag === bag && flash.page === validationFlashPage(pathname) ? flash.errors : {})
}

export const adapterNextValidationErrorsInternals = {
  startDocument,
}
