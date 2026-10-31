import { createElement, type ReactElement } from 'react'
import { useServerInsertedHTML } from 'next/navigation.js'
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external.js'
import { renderedValidationFlash } from './rendered-validation-flash'
import { VALIDATION_FLASH_ELEMENT_ID } from './validation-flash'

const writtenRequests = new WeakSet<object>()

/**
 * The flash a form posted without JavaScript left for this server render. The render writes
 * it into the page once, so the browser hydrates with the same errors.
 */
export function useRequestValidationFlash(): string {
  const request = workUnitAsyncStorage.getStore()
  const flash = renderedValidationFlash(request) ?? ''
  useServerInsertedHTML((): ReactElement | null => {
    if (!flash || !request || writtenRequests.has(request)) return null
    writtenRequests.add(request)
    return createElement('script', {
      id: VALIDATION_FLASH_ELEMENT_ID,
      type: 'application/json',
      dangerouslySetInnerHTML: { __html: JSON.stringify(flash).replace(/</g, '\\u003c') },
    })
  })
  return flash
}
