'use client'

// A barrel of side-effect-free modules, so bundlers ship only the hooks a page imports.
export { adapterNextClientInternals, useForm } from '@holo-js/adapter-next/internal/use-form'
export { useValidationErrors } from '@holo-js/adapter-next/internal/use-validation-errors'

export {
  type ClientCsrfOptions,
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type FormRequestCredentials,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/internal/client'
