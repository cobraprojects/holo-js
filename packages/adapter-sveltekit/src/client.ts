import { createSubscriber } from 'svelte/reactivity'
import {
  DEFAULT_VALIDATION_BAG,
  createErrorBag,
  type FormFailurePayload,
  type FormSchema,
  type InferFormData,
  type ValidationErrorBag,
} from '@holo-js/forms'
import {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type InferFormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  createFormClient,
  runWithBrowserFormElement,
} from '@holo-js/forms/internal/client'
import { normalizeSvelteKitClientHttpError, renderSvelteKitClientHttpErrorPage } from './client-errors'
import { createReactiveView } from './reactive-view'

type InitialFormState<TData> = UseFormOptions<TData>['initialState']
type FlashedValidationPayload<TData> = FormFailurePayload<TData> & {
  readonly bag?: string
}

type BrowserDocument = {
  cookie?: string
  querySelectorAll?(selector: string): ArrayLike<BrowserFormControl> | Iterable<BrowserFormControl>
}

type BrowserWindow = {
  requestAnimationFrame?(callback: () => void): number
  setTimeout?(callback: () => void, delay?: number): number
}

type BrowserFormControl = {
  readonly name?: string
  readonly type?: string
  value?: string
  checked?: boolean
}

type BrowserEventTarget = {
  addEventListener(
    type: string,
    listener: (event: BrowserSubmitEvent | Event) => void,
    options?: boolean | object,
  ): void
}

type SvelteKitCookieOptions = {
  path: string
  maxAge?: number
  httpOnly?: boolean
  sameSite?: 'lax' | 'strict' | 'none'
}

type SvelteKitRequestEvent = {
  readonly url?: URL
  readonly cookies: {
    get(name: string): string | undefined
    set(name: string, value: string, options: SvelteKitCookieOptions): void
  }
}

type SvelteKitRequestEventStore = {
  getStore(): SvelteKitRequestEvent | undefined
}

type BrowserSubmitEvent = {
  readonly target: EventTarget | BrowserFormElement | null
  preventDefault(): void
  stopImmediatePropagation(): void
}

type BrowserFormElement = {
  readonly tagName?: string
  readonly action?: string
  readonly method?: string
  submit?(): void
}

type FormHttpFailure = {
  readonly ok: false
  readonly status: number
  readonly errors?: Record<string, readonly string[]>
}

type SvelteKitActionFailureResult = {
  readonly type: 'failure'
  readonly status: number
  readonly data: string
}

type SvelteKitActionErrorResult = {
  readonly type: 'error'
  readonly error: unknown
}

type SvelteKitActionRedirectResult = {
  readonly type: 'redirect'
  readonly status: number
  readonly location: string
}

type SvelteKitActionSuccessResult = {
  readonly type: 'success'
  readonly status: number
  readonly data?: unknown
}

type SvelteKitActionResult =
  | SvelteKitActionFailureResult
  | SvelteKitActionErrorResult
  | SvelteKitActionRedirectResult
  | SvelteKitActionSuccessResult

type RegisteredForm = {
  readonly paths: readonly string[]
  submit(form: BrowserFormElement): Promise<void>
}

const registeredForms = new Set<RegisteredForm>()
const invalidActionFailureMessage = 'Unable to read the form response. Please try again.'
const validationFlashCookie = 'HOLO-SVELTEKIT-VALIDATION'
let submitListenerTarget: BrowserEventTarget | undefined

export {
  type ClientSubmitContext,
  type ClientSubmitResult,
  type FormFieldState,
  type FormFieldTree,
  type UseFormOptions,
  type UseFormResult,
  type ValidateOnMode,
} from '@holo-js/forms/internal/client'

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value
    && typeof value === 'object'
    && !Array.isArray(value)
    && !(value instanceof Date)
    && !(value instanceof Blob)
}

function isSchemaField(value: unknown): boolean {
  return isPlainObject(value)
    && value.kind === 'field'
    && isPlainObject(value.definition)
}

function collectSchemaPaths(value: unknown, prefix = ''): readonly string[] {
  if (isSchemaField(value)) {
    return [prefix].filter(Boolean)
  }

  if (!isPlainObject(value)) {
    return []
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return collectSchemaPaths(nested, next)
  })
}

function collectValuePaths(value: unknown, prefix = ''): readonly string[] {
  if (!isPlainObject(value)) {
    return [prefix].filter(Boolean)
  }

  return Object.entries(value).flatMap(([key, nested]) => {
    const next = prefix ? `${prefix}.${key}` : key
    return collectValuePaths(nested, next)
  })
}

function flattenRestorableValues(value: unknown, prefix = ''): readonly [string, string][] {
  if (typeof value === 'undefined' || value instanceof Blob) {
    return []
  }

  if (Array.isArray(value)) {
    return value.flatMap(item => flattenRestorableValues(item, prefix))
  }

  if (isPlainObject(value)) {
    return Object.entries(value).flatMap(([key, nested]) => {
      const next = prefix ? `${prefix}.${key}` : key
      return flattenRestorableValues(nested, next)
    })
  }

  return prefix ? [[prefix, String(value)]] : []
}

function restoreBrowserFormValues(values: Record<string, unknown>): void {
  const controls = (globalThis as { readonly document?: BrowserDocument }).document
    ?.querySelectorAll?.('input[name], textarea[name], select[name]')
  if (!controls) {
    return
  }

  const valuesByName = new Map<string, string[]>()
  for (const [name, value] of flattenRestorableValues(values)) {
    valuesByName.set(name, [...(valuesByName.get(name) ?? []), value])
  }

  for (const control of Array.from(controls)) {
    const name = control.name
    const nextValues = name ? valuesByName.get(name) : undefined
    if (!name || !nextValues) {
      continue
    }

    const type = control.type?.toLowerCase()
    if (type === 'file') {
      continue
    }

    if (type === 'checkbox' || type === 'radio') {
      control.checked = nextValues.includes(control.value ?? 'on')
      continue
    }

    control.value = nextValues[0] as string
  }
}

function scheduleBrowserFormValueRestore(values: Record<string, unknown>): void {
  restoreBrowserFormValues(values)

  const browserWindow = (globalThis as { readonly window?: BrowserWindow }).window
  const restore = () => restoreBrowserFormValues(values)
  queueMicrotask(restore)

  if (typeof browserWindow?.requestAnimationFrame === 'function') {
    browserWindow.requestAnimationFrame(restore)
    return
  }

  browserWindow?.setTimeout?.(restore, 0)
}

function isFormState<TData>(value: unknown): value is NonNullable<InitialFormState<TData>> {
  return isPlainObject(value)
    && typeof value.valid === 'boolean'
    && isPlainObject(value.values)
    && isPlainObject(value.errors)
}

function stateMatchesSchema<TData>(schemaDefinition: FormSchema, state: NonNullable<InitialFormState<TData>>): boolean {
  const schemaPaths = collectSchemaPaths(schemaDefinition.fields)
  const statePaths = [
    ...Object.keys(state.errors),
    ...collectValuePaths(state.values),
  ]

  return statePaths.every(path => path === '_root' || schemaPaths.includes(path))
}

function parseJsonObject(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

function createInvalidActionFailure<TData>(
  values: TData,
  status: number,
): FormFailurePayload<TData> {
  return {
    ok: false,
    status,
    valid: false,
    values: values as Partial<TData>,
    errors: {
      _root: [invalidActionFailureMessage],
    },
  }
}

function getHttpFailureMessage(result: FormHttpFailure): string | undefined {
  return result.errors?._root?.[0]
}

function renderFormHttpFailure(result: unknown): void {
  if (!isPlainObject(result) || result.ok !== false || typeof result.status !== 'number' || result.status === 422) {
    return
  }

  const httpError = normalizeSvelteKitClientHttpError({
    status: result.status,
    message: getHttpFailureMessage(result as FormHttpFailure),
  })

  if (httpError) {
    renderSvelteKitClientHttpErrorPage(httpError)
  }
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function isFormFailurePayload<TData>(value: unknown): value is FormFailurePayload<TData> {
  return isPlainObject(value)
    && value.ok === false
    && typeof value.status === 'number'
    && value.valid === false
    && isPlainObject(value.values)
    && isPlainObject(value.errors)
}

function parseValidationFlashCookie<TData>(value: string | undefined): FlashedValidationPayload<TData> | undefined {
  if (!value) {
    return undefined
  }

  const parsed = parseJsonObject(value) ?? parseJsonObject(safeDecodeURIComponent(value))
  if (!isFormFailurePayload<TData>(parsed)) {
    return undefined
  }

  return parsed
}

function readBrowserCookie(name: string): string | undefined {
  const cookie = (globalThis as { readonly document?: BrowserDocument }).document?.cookie
  if (!cookie) {
    return undefined
  }

  for (const segment of cookie.split(';')) {
    const trimmed = segment.trim()
    const separator = trimmed.indexOf('=')
    if (separator <= 0 || trimmed.slice(0, separator) !== name) {
      continue
    }

    return trimmed.slice(separator + 1)
  }

  return undefined
}

function clearBrowserCookie(name: string): void {
  const document = (globalThis as { readonly document?: BrowserDocument }).document
  if (!document) {
    return
  }

  document.cookie = `${name}=; Max-Age=0; Path=${getBrowserCookiePath()}; SameSite=Lax`
}

function getSvelteKitRequestEvent(): SvelteKitRequestEvent | undefined {
  const store = (globalThis as {
    readonly __holoSvelteKitRequestEventStore?: SvelteKitRequestEventStore
  }).__holoSvelteKitRequestEventStore

  return store?.getStore()
}

function takeFlashedValidationState<TData>(
  schemaDefinition: FormSchema,
): FormFailurePayload<TData> | undefined {
  if (typeof (globalThis as { readonly window?: unknown }).window !== 'undefined') {
    return undefined
  }

  const event = getSvelteKitRequestEvent()
  const payload = parseValidationFlashCookie<TData>(event?.cookies.get(validationFlashCookie))
  if (!event || !payload || !stateMatchesSchema(schemaDefinition, payload)) {
    return undefined
  }

  event.cookies.set(validationFlashCookie, '', {
    path: event.url?.pathname || '/',
    maxAge: 0,
    sameSite: 'lax',
    httpOnly: true,
  })

  return payload
}

function takeValidationErrors<TData>(
  bag: string,
): FlashedValidationPayload<TData> | undefined {
  const event = getSvelteKitRequestEvent()
  const payload = event
    ? parseValidationFlashCookie<TData>(event.cookies.get(validationFlashCookie))
    : parseValidationFlashCookie<TData>(readBrowserCookie(validationFlashCookie))

  if (!payload || (payload.bag ?? DEFAULT_VALIDATION_BAG) !== bag) {
    return undefined
  }

  if (event) {
    return payload
  }

  scheduleBrowserFormValueRestore(payload.values)
  clearBrowserCookie(validationFlashCookie)
  return payload
}

function isSvelteKitActionResult(value: unknown): value is SvelteKitActionResult {
  return isPlainObject(value)
    && typeof value.type === 'string'
    && (
      value.type === 'failure'
      || value.type === 'error'
      || value.type === 'redirect'
      || value.type === 'success'
    )
}

function isJsonResponse(response: Response): boolean {
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
  return contentType === 'application/json' || contentType?.endsWith('+json') === true
}

function normalizeFormDataName(name: string): string {
  return name.endsWith('[]') ? name.slice(0, -2) : name
}

function countMatchingFormFields(form: BrowserFormElement, paths: readonly string[]): number {
  let formData: FormData
  try {
    formData = Reflect.construct(FormData, [form]) as FormData
  } catch {
    return 0
  }

  const names = new Set(Array.from(formData.entries(), ([name]) => normalizeFormDataName(name)))
  return paths.filter(path => names.has(path)).length
}

function resolveSubmittedForm(target: EventTarget | BrowserFormElement | null): BrowserFormElement | undefined {
  if (target && typeof target === 'object' && 'tagName' in target && target.tagName === 'FORM') {
    return target as BrowserFormElement
  }

  return undefined
}

function isNativePostForm(form: BrowserFormElement): boolean {
  return (form.method || 'get').toLowerCase() === 'post'
}

function isSvelteKitActionForm(form: BrowserFormElement): boolean {
  if (!isNativePostForm(form)) {
    return false
  }

  const action = form.action ?? currentLocationHref()
  if (!action) {
    return false
  }

  try {
    return new URL(action, currentLocationHref()).search.startsWith('?/')
  } catch {
    return action.includes('?/') || action.startsWith('?/')
  }
}

function resolveRegisteredForm(form: BrowserFormElement): RegisteredForm | undefined {
  if (!isNativePostForm(form)) {
    return undefined
  }

  let match: RegisteredForm | undefined
  let matchedFields = 0
  for (const candidate of registeredForms) {
    const count = countMatchingFormFields(form, candidate.paths)
    if (count > 0 && count >= matchedFields) {
      match = candidate
      matchedFields = count
    }
  }

  return match
}

function submitNativeForm(form: BrowserFormElement): void {
  form.submit?.()
}

async function submitSvelteKitActionForm(form: BrowserFormElement): Promise<void> {
  const formData = Reflect.construct(FormData, [form]) as FormData
  const result = await submitSvelteKitAction<Record<string, unknown>, unknown>({
    action: form.action,
    method: form.method || 'POST',
    values: {},
    formData,
  })
  const httpError = normalizeSvelteKitClientHttpError(result)

  if (httpError && httpError.status !== 422) {
    renderSvelteKitClientHttpErrorPage(httpError)
    return
  }

  if (isPlainObject(result) && result.ok === false) {
    submitNativeForm(form)
  }
}

function ensureSubmitListener(): void {
  const document = (globalThis as { readonly document?: BrowserDocument }).document
  const browserWindow = (globalThis as {
    readonly window?: Partial<BrowserEventTarget>
  }).window
  const target = typeof browserWindow?.addEventListener === 'function'
    ? browserWindow as BrowserEventTarget
    : document && 'addEventListener' in document && typeof document.addEventListener === 'function'
      ? document as BrowserDocument & BrowserEventTarget
      : undefined

  if (!target) {
    return
  }

  if (submitListenerTarget === target) {
    return
  }

  submitListenerTarget = target
  target.addEventListener('submit', (event) => {
    const form = resolveSubmittedForm(event.target)
    const registeredForm = form ? resolveRegisteredForm(form) : undefined
    if (!form) {
      return
    }

    if (registeredForm) {
      event.preventDefault()
      event.stopImmediatePropagation()
      void registeredForm.submit(form)
      return
    }

    if (isSvelteKitActionForm(form)) {
      event.preventDefault()
      event.stopImmediatePropagation()
      void submitSvelteKitActionForm(form)
    }
  }, true)
}

function registerForm<TData, TSuccess>(
  schemaDefinition: FormSchema,
  form: Pick<UseFormResult<TData, TSuccess>, 'submit'>,
): () => void {
  if (typeof (globalThis as { readonly window?: unknown }).window === 'undefined') {
    return () => {}
  }

  const registeredForm: RegisteredForm = {
    paths: collectSchemaPaths(schemaDefinition.fields),
    async submit(liveForm) {
      await runWithBrowserFormElement(form, liveForm)
    },
  }
  registeredForms.add(registeredForm)
  ensureSubmitListener()

  let registered = true
  return () => {
    if (!registered) {
      return
    }

    registered = false
    registeredForms.delete(registeredForm)
  }
}

function currentLocationHref(): string | undefined {
  const location = (globalThis as {
    readonly window?: {
      readonly location?: {
        readonly href?: string
      }
    }
  }).window?.location

  return location?.href
}

function redirectBrowser(location: string): void {
  const browserLocation = (globalThis as {
    readonly window?: {
      readonly location?: {
        assign?(url: string): void
        href?: string
      }
    }
  }).window?.location

  if (typeof browserLocation?.assign === 'function') {
    browserLocation.assign(location)
    return
  }

  if (browserLocation && 'href' in browserLocation) {
    browserLocation.href = location
  }
}

function getBrowserCookiePath(): string {
  const pathname = (globalThis as {
    readonly window?: {
      readonly location?: {
        readonly pathname?: string
      }
    }
  }).window?.location?.pathname

  return (pathname || '/').replace(/[;\r\n]/g, '') || '/'
}

async function submitSvelteKitAction<TData, TSuccess>(
  context: ClientSubmitContext<TData>,
): Promise<ClientSubmitResult<TData, TSuccess>> {
  const action = context.action ?? currentLocationHref()
  if (typeof fetch !== 'function' || !action) {
    return {
      ok: true,
      status: 200,
      data: context.values as unknown as TSuccess,
    }
  }

  const method = context.method.toUpperCase()
  const init: RequestInit = method === 'GET' || method === 'HEAD'
    ? {
        method,
        credentials: 'same-origin',
        headers: {
          accept: 'application/json',
        },
      }
    : {
        method,
        credentials: 'same-origin',
        body: context.formData,
        headers: {
          accept: 'application/json',
          'x-sveltekit-action': 'true',
        },
      }
  const response = await fetch(action, init)

  if (!isJsonResponse(response)) {
    return {
      ok: response.ok,
      status: response.status,
      data: undefined as TSuccess,
    }
  }

  const result = await response.json() as unknown
  if (!isSvelteKitActionResult(result)) {
    return result as ClientSubmitResult<TData, TSuccess>
  }

  if (result.type === 'failure') {
    const parsed = parseJsonObject(result.data)
    return isPlainObject(parsed)
      ? parsed as ClientSubmitResult<TData, TSuccess>
      : createInvalidActionFailure<TData>(context.values, result.status)
  }

  if (result.type === 'error') {
    const actionError = isPlainObject(result.error)
      ? {
          ...result.error,
          status: response.status,
        }
      : {
          status: response.status,
          message: response.statusText,
        }
    const httpError = normalizeSvelteKitClientHttpError(actionError)
    if (httpError) {
      renderSvelteKitClientHttpErrorPage(httpError)
    }

    return actionError as ClientSubmitResult<TData, TSuccess>
  }

  if (result.type === 'redirect') {
    redirectBrowser(result.location)
    return {
      ok: true,
      status: result.status,
      data: undefined as TSuccess,
    }
  }

  return {
    ok: true,
    status: result.status,
    data: result.data as TSuccess,
  }
}

async function hydrateActionFormState<TData, TSuccess>(
  form: Pick<UseFormResult<TData, TSuccess>, 'applyServerState'>,
  schemaDefinition: FormSchema,
): Promise<void> {
  if (typeof (globalThis as { readonly window?: unknown }).window === 'undefined') {
    return
  }

  const stores = await import('$app/stores') as {
    readonly page: {
      subscribe(listener: (value: { readonly form: unknown }) => void): () => void
    }
  }
  let unsubscribe = () => {}
  unsubscribe = stores.page.subscribe((value) => {
    const state = value.form
    if (isFormState<TData>(state) && stateMatchesSchema(schemaDefinition, state)) {
      form.applyServerState(state)
    }

    queueMicrotask(() => unsubscribe())
  })
}

ensureSubmitListener()

function createHttpHandledForm<TData, TSuccess, TFields>(
  form: UseFormResult<TData, TSuccess, TFields>,
): UseFormResult<TData, TSuccess, TFields> {
  const wrappedForm = Object.create(Object.getPrototypeOf(form)) as UseFormResult<TData, TSuccess, TFields>

  for (const key of Reflect.ownKeys(form)) {
    const descriptor = Object.getOwnPropertyDescriptor(form, key)
    if (!descriptor) {
      continue
    }

    if (key === 'submit') {
      continue
    }

    if (typeof key === 'symbol' && typeof descriptor.value === 'function') {
      continue
    }

    Object.defineProperty(wrappedForm, key, descriptor)
  }

  const submit = form.submit.bind(form)
  Object.defineProperty(wrappedForm, 'submit', {
    configurable: true,
    enumerable: true,
    value: async () => {
      const result = await submit()
      renderFormHttpFailure(result)
      return result
    },
  })

  for (const key of Object.getOwnPropertySymbols(form)) {
    const descriptor = Object.getOwnPropertyDescriptor(form, key)
    const value = descriptor?.value
    if (!descriptor || typeof value !== 'function') {
      continue
    }

    Object.defineProperty(wrappedForm, key, {
      ...descriptor,
      configurable: true,
      value: async (...args: readonly unknown[]) => {
        const result = await Reflect.apply(value, form, args)
        renderFormHttpFailure(result)
        return result
      },
    })
  }

  return wrappedForm
}

export function useForm<TSchema extends FormSchema, TSuccess = unknown>(
  schemaDefinition: TSchema,
  options: UseFormOptions<InferFormData<TSchema>, TSuccess> = {},
): UseFormResult<InferFormData<TSchema>, TSuccess, InferFormFieldTree<TSchema>> {
  type TData = InferFormData<TSchema>
  const formOptions: UseFormOptions<TData, TSuccess> = {
    ...options,
    action: options.action ?? currentLocationHref(),
    initialState: options.initialState ?? takeFlashedValidationState<TData>(schemaDefinition),
    submitter: options.submitter ?? submitSvelteKitAction,
  }

  const form = createHttpHandledForm(createFormClient(schemaDefinition, formOptions))
  void hydrateActionFormState(form, schemaDefinition)
  const unregisterForm = registerForm(schemaDefinition, form)
  const subscribe = createSubscriber((update) => {
    const unsubscribe = form.subscribe(update)
    return () => {
      unsubscribe()
      unregisterForm()
    }
  })
  const cache = new WeakMap<object, object>()

  return createReactiveView<UseFormResult<TData, TSuccess, InferFormFieldTree<TSchema>>>(form, subscribe, cache, {
    bindFunctions: true,
    shouldWrapValue: isPlainObject,
  })
}

export function useValidationErrors<TData = Record<string, unknown>>(
  bag = DEFAULT_VALIDATION_BAG,
): ValidationErrorBag<TData> {
  const payload = takeValidationErrors<TData>(bag)
  return createErrorBag<TData>(payload?.errors ?? {})
}

export const svelteClientInternals = {
  clearBrowserCookie,
  collectSchemaPaths,
  collectValuePaths,
  countMatchingFormFields,
  createInvalidActionFailure,
  createHttpHandledForm,
  currentLocationHref,
  ensureSubmitListener,
  flattenRestorableValues,
  getBrowserCookiePath,
  hydrateActionFormState,
  isFormFailurePayload,
  isFormState,
  isJsonResponse,
  isNativePostForm,
  isPlainObject,
  isSchemaField,
  isSvelteKitActionForm,
  isSvelteKitActionResult,
  normalizeFormDataName,
  parseValidationFlashCookie,
  readBrowserCookie,
  redirectBrowser,
  registerForm,
  renderFormHttpFailure,
  resolveRegisteredForm,
  resolveSubmittedForm,
  restoreBrowserFormValues,
  safeDecodeURIComponent,
  scheduleBrowserFormValueRestore,
  stateMatchesSchema,
  submitNativeForm,
  submitSvelteKitAction,
  submitSvelteKitActionForm,
  takeFlashedValidationState,
  takeValidationErrors,
}
