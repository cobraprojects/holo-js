import type { NormalizedHoloProjectConfig } from './project'

export const HOLO_PROJECT_PREPARE_API_VERSION = 1 as const

export type HoloProjectPrepareCommand = 'prepare' | 'dev' | 'build'
export type HoloProjectPrepareChangeKind = 'created' | 'changed' | 'deleted'

export interface HoloProjectPrepareChange {
  readonly path: string
  readonly kind: HoloProjectPrepareChangeKind
}

export type HoloProjectPrepareRun =
  | {
      readonly kind: 'full'
      readonly command: HoloProjectPrepareCommand
      readonly reason: 'initial' | 'explicit' | 'configuration-changed' | 'dependencies-changed' | 'plugin-requested'
    }
  | {
      readonly kind: 'incremental'
      readonly command: 'dev'
      readonly changes: readonly HoloProjectPrepareChange[]
    }

export interface HoloProjectPrepareFramework {
  readonly id: string
  readonly displayName: string
  readonly adapterPackage: `@holo-js/${string}`
  readonly fluxPackage?: `@holo-js/${string}`
  readonly capabilities: {
    readonly managedBroadcastAuthRoute: boolean
  }
}

export interface HoloProjectPreparePlugin {
  readonly id: string
  readonly name?: string
  readonly packageName: string
  readonly packageRoot: string
}

export interface HoloProjectPrepareLogger {
  info(message: string): void
  warn(message: string): void
}

export interface HoloProjectPrepareContext {
  readonly projectRoot: string
  readonly generatedRoot: string
  readonly pluginGeneratedRoot: string
  readonly config: NormalizedHoloProjectConfig
  readonly framework?: HoloProjectPrepareFramework
  readonly plugin: HoloProjectPreparePlugin
  readonly run: HoloProjectPrepareRun
  readonly signal: AbortSignal
  readonly logger: HoloProjectPrepareLogger
}

export type HoloProjectArtifactContents = string | Uint8Array

export interface HoloGeneratedProjectArtifact {
  readonly path: string
  readonly contents: HoloProjectArtifactContents
}

export interface HoloManagedProjectArtifact {
  readonly path: string
  readonly contents: HoloProjectArtifactContents
}

export interface HoloProjectPrepareWatch {
  readonly roots?: readonly string[]
  readonly excludes?: readonly string[]
}

export interface HoloProjectPrepareSource {
  readonly path: string
  readonly line?: number
  readonly column?: number
}

export interface HoloProjectPrepareDiagnostic {
  readonly severity: 'info' | 'warning'
  readonly code: string
  readonly message: string
  readonly source?: HoloProjectPrepareSource
  readonly hint?: string
}

export interface HoloProjectPrepareFailure {
  readonly code: string
  readonly message: string
  readonly source?: HoloProjectPrepareSource
  readonly hint?: string
}

export class HoloProjectPrepareError extends Error {
  readonly failure: Readonly<HoloProjectPrepareFailure>

  constructor(failure: HoloProjectPrepareFailure) {
    super(failure.message)
    this.name = 'HoloProjectPrepareError'
    this.failure = Object.freeze({ ...failure })
  }
}

export interface HoloProjectPreparedResult {
  readonly kind: 'prepared'
  readonly generatedArtifacts?: readonly HoloGeneratedProjectArtifact[]
  readonly managedArtifacts?: readonly HoloManagedProjectArtifact[]
  readonly watch?: HoloProjectPrepareWatch
  readonly diagnostics?: readonly HoloProjectPrepareDiagnostic[]
}

export interface HoloProjectPrepareFullRetry {
  readonly kind: 'retry-full'
  readonly reason: string
}

export type HoloProjectPrepareResult = HoloProjectPreparedResult | HoloProjectPrepareFullRetry

export interface HoloProjectPreparer {
  readonly apiVersion: typeof HOLO_PROJECT_PREPARE_API_VERSION
  prepare(context: HoloProjectPrepareContext): HoloProjectPrepareResult | Promise<HoloProjectPrepareResult>
}

export type HoloProjectPrepareModule =
  | HoloProjectPreparer
  | { readonly default: HoloProjectPreparer }
  | { readonly preparer: HoloProjectPreparer }

export function defineHoloProjectPreparer<TPreparer extends HoloProjectPreparer>(
  preparer: TPreparer,
): Readonly<TPreparer> {
  return Object.freeze({ ...preparer })
}
