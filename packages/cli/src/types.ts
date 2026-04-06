import type { NormalizedHoloProjectConfig } from '@holo-js/db'

export type CommandFlagValue = string | boolean | number | readonly string[]

export interface LoadedProjectConfig {
  readonly manifestPath?: string
  readonly config: NormalizedHoloProjectConfig
}

export interface CommandExecutionContext {
  readonly projectRoot: string
  readonly cwd: string
  readonly args: readonly string[]
  readonly flags: Readonly<Record<string, CommandFlagValue>>
  loadProject(): Promise<LoadedProjectConfig>
}

export interface HoloAppCommand {
  readonly name?: string
  readonly aliases?: readonly string[]
  readonly description: string
  readonly usage?: string
  run(context: CommandExecutionContext): unknown | Promise<unknown>
}

export function defineCommand<TCommand extends HoloAppCommand>(command: TCommand): TCommand {
  return Object.freeze({ ...command })
}
