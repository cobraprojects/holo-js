export interface HoloServerViewRenderInput {
  readonly view: string
  readonly props?: Readonly<Record<string, unknown>>
}

export type HoloServerViewRenderer = (
  input: HoloServerViewRenderInput,
) => string | Promise<string>

type RenderingRuntimeState = {
  renderView?: HoloServerViewRenderer
}

export function getHoloRenderingRuntime(): RenderingRuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoRenderingRuntime__?: RenderingRuntimeState
  }
  runtime.__holoRenderingRuntime__ ??= {}
  return runtime.__holoRenderingRuntime__
}

export function configureHoloRenderingRuntime(
  bindings?: { readonly renderView?: HoloServerViewRenderer },
): void {
  getHoloRenderingRuntime().renderView = bindings?.renderView
}

export function resetHoloRenderingRuntime(): void {
  getHoloRenderingRuntime().renderView = undefined
}

export function restoreHoloRenderingRuntime(renderView: HoloServerViewRenderer | undefined): void {
  if (renderView) {
    configureHoloRenderingRuntime({ renderView })
    return
  }
  resetHoloRenderingRuntime()
}
