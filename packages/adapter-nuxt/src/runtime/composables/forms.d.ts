import type { FormSchema, InferFormData } from '@holo-js/forms'
import type { ValidationErrorBag } from '@holo-js/forms'
import type {
  InferFormFieldTree,
  UseFormOptions,
  UseFormResult,
} from '@holo-js/forms/internal/client'

export type {
  ClientSubmitContext,
  ClientSubmitResult,
  FormFieldState,
  FormFieldTree,
  InferFormFieldTree,
  UseFormOptions,
  UseFormResult,
  ValidateOnMode,
} from '@holo-js/forms/internal/client'

export declare function useForm<TSchema extends FormSchema, TSuccess = unknown>(
  schemaDefinition: TSchema,
  options?: UseFormOptions<InferFormData<TSchema>, TSuccess>,
): UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>>

export declare function useValidationErrors<TData = Record<string, unknown>>(
  bag?: string,
): ValidationErrorBag<TData>
