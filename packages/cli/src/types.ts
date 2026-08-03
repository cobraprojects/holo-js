import type { NormalizedHoloProjectConfig } from '@holo-js/kernel'
import type { HoloRuntime } from '@holo-js/core'

export type CommandFlagValue = string | boolean | number | readonly string[]

export interface LoadedProjectConfig {
  readonly manifestPath?: string
  readonly config: NormalizedHoloProjectConfig
}

export interface HoloAppCommandMigrationOptions {
  readonly names: readonly string[]
  readonly pretend?: boolean
}

export interface HoloAppCommandRuntime {
  readonly holo: HoloRuntime
  migrate(options: HoloAppCommandMigrationOptions): Promise<readonly string[]>
}

export interface CommandExecutionContext {
  readonly projectRoot: string
  readonly cwd: string
  readonly args: readonly string[]
  readonly flags: Readonly<Record<string, CommandFlagValue>>
  loadProject(): Promise<LoadedProjectConfig>
  withRuntime<TResult>(
    operation: (runtime: HoloAppCommandRuntime) => TResult | Promise<TResult>,
  ): Promise<TResult>
}

export interface HoloAppCommand {
  readonly name?: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly usage?: string
  run(context: CommandExecutionContext): unknown | Promise<unknown>
}

export function defineCommand(command: HoloAppCommand): Readonly<HoloAppCommand> {
  return Object.freeze({ ...command })
}
