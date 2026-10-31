import { VALIDATION_FLASH_ELEMENT_ID } from './validation-flash'

type BrowserDocument = { getElementById(id: string): { readonly textContent: string | null } | null }

let hydrationFlash: string | undefined

function readHydrationFlash(): string {
  const text = (globalThis as { readonly document?: BrowserDocument }).document?.getElementById(VALIDATION_FLASH_ELEMENT_ID)?.textContent
  if (!text) return ''
  try {
    const flash: unknown = JSON.parse(text)
    return typeof flash === 'string' ? flash : ''
  } catch {
    return ''
  }
}

/** The flash the server render wrote into the page, so hydration shows the same errors. */
export function documentValidationFlash(): string {
  return hydrationFlash ??= readHydrationFlash()
}

export function useRequestValidationFlash(): string {
  return documentValidationFlash()
}
