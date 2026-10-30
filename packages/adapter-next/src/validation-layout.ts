import { createElement, type ReactElement, type ReactNode } from 'react'
import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external.js'
import { HoloValidationErrorsProvider } from '@holo-js/adapter-next/internal/validation-errors'
import { renderedValidationFlash } from './rendered-validation-flash'

function validationErrorsLayout<TProps extends object>(layout: (props: TProps) => ReactNode | Promise<ReactNode>): (props: TProps) => ReactElement {
  return props => createElement(
    HoloValidationErrorsProvider,
    { initial: renderedValidationFlash(workUnitAsyncStorage.getStore()) },
    createElement(layout, props),
  )
}

export const adapterNextLayoutInternals = {
  validationErrorsLayout,
}
