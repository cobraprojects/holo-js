export interface HoloErrorReportContext {
  readonly capability: string
  readonly operation: string
}

export type HoloUnreportedErrorClass = new (...args: never[]) => Error

export interface HoloExceptionsConfig {
  report?(error: unknown, context: HoloErrorReportContext): void | Promise<void>
  dontReport?: readonly HoloUnreportedErrorClass[]
}

type ErrorReportingState = {
  exceptions?: HoloExceptionsConfig
}

function errorReportingState(): ErrorReportingState {
  const runtime = globalThis as typeof globalThis & { __holoErrorReporting__?: ErrorReportingState }
  runtime.__holoErrorReporting__ ??= {}
  return runtime.__holoErrorReporting__
}

function describeContext(context: HoloErrorReportContext): string {
  return `[holo:${context.capability}] ${context.operation}`
}

function logReporterFailure(error: unknown, context: HoloErrorReportContext, reporterError: unknown): void {
  console.error(describeContext(context), error, reporterError)
}

function isUnreported(error: unknown, exceptions: HoloExceptionsConfig): boolean {
  return exceptions.dontReport?.some(errorClass => error instanceof errorClass) ?? false
}

export function reportError(error: unknown, context: HoloErrorReportContext): void {
  const exceptions = errorReportingState().exceptions
  if (exceptions && isUnreported(error, exceptions)) return
  if (!exceptions?.report) {
    console.error(describeContext(context), error)
    return
  }

  try {
    void Promise.resolve(exceptions.report(error, context))
      .catch(reporterError => logReporterFailure(error, context, reporterError))
  } catch (reporterError) {
    logReporterFailure(error, context, reporterError)
  }
}

function configure(exceptions: HoloExceptionsConfig | undefined): HoloExceptionsConfig | undefined {
  const state = errorReportingState()
  const previous = state.exceptions
  state.exceptions = exceptions
  return previous
}

export const errorReportingInternals = {
  configure,
}
