import { useContext, useMemo } from 'react'
import { usePathname } from 'next/navigation.js'
import { DEFAULT_VALIDATION_BAG, createErrorBag, type ValidationErrorBag } from '@holo-js/validation'
import { ValidationFlashContext } from '@holo-js/adapter-next/internal/validation-errors'
import { parseValidationFlash, validationFlashPage, type ValidationFlash } from './validation-flash'

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
  const value = useContext(ValidationFlashContext)
  const flash = useMemo(() => readableValidationFlash(value), [value])
  const pathname = usePathname()
  return createErrorBag<TData>(flash?.bag === bag && flash.page === validationFlashPage(pathname) ? flash.errors : {})
}
