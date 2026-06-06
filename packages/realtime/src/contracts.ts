import type { AuthenticatedAuthUser } from '@holo-js/auth'
import type { DatabaseContext, ModelRepository, TableDefinition, TableQueryBuilder } from '@holo-js/db'
import type { ValidationSchema } from '@holo-js/validation'

export type RealtimeAccessRequirement = 'public' | 'authenticated'

export interface RealtimeAuthState<TUser extends AuthenticatedAuthUser = AuthenticatedAuthUser> {
  readonly user: TUser
  readonly guard: string
  readonly provider: string | null
}

export interface RealtimeDatabaseContext {
  readonly connection: DatabaseContext
  table<TTable extends TableDefinition>(table: TTable): TableQueryBuilder<TTable>
  table(name: string): TableQueryBuilder<string>
  model(...parameters: Parameters<DatabaseContext['model']>): ModelRepository
}

export interface RealtimePublicAccessContext<TArgs> {
  readonly args: TArgs
  readonly auth: RealtimeAuthState | null
  readonly db: RealtimeDatabaseContext
}

export interface RealtimeAuthenticatedAccessContext<TArgs> {
  readonly args: TArgs
  readonly auth: RealtimeAuthState
  readonly db: RealtimeDatabaseContext
}

export type RealtimeAccessAuthorize<TArgs, TRequirement extends RealtimeAccessRequirement> = (
  context: TRequirement extends 'authenticated'
    ? RealtimeAuthenticatedAccessContext<TArgs>
    : RealtimePublicAccessContext<TArgs>
) => boolean | Promise<boolean>

export interface RealtimeAccessObject<
  TArgs,
  TRequirement extends RealtimeAccessRequirement = RealtimeAccessRequirement,
> {
  readonly require: TRequirement
  readonly guard?: string
  readonly guards?: readonly string[]
  readonly authorize?: RealtimeAccessAuthorize<TArgs, TRequirement>
}

export type RealtimeAccess<TArgs = Record<string, never>>
  = RealtimeAccessRequirement
    | RealtimeAccessObject<TArgs, 'public'>
    | RealtimeAccessObject<TArgs, 'authenticated'>

export type RealtimeArgsForSchema<TSchema>
  = TSchema extends { readonly $data?: infer TData }
    ? TData
    : Record<string, never>

export type RealtimeAuthForAccess<TAccess>
  = TAccess extends 'authenticated'
    ? RealtimeAuthState
    : TAccess extends { readonly require: 'authenticated' }
      ? RealtimeAuthState
      : RealtimeAuthState | null

export type RealtimeCaller<TArgs, TResult> = Record<string, never> extends TArgs
  ? (args?: TArgs) => TResult
  : (args: TArgs) => TResult

export interface RealtimeHandlerContext<TArgs, TAccess> {
  readonly args: TArgs
  readonly auth: RealtimeAuthForAccess<TAccess>
  readonly db: RealtimeDatabaseContext
  readonly name: string
}

export interface RealtimeQueryInput<
  TName extends string | undefined,
  TSchema extends ValidationSchema | undefined,
  TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
> {
  readonly name?: TName
  readonly args?: TSchema
  readonly access: TAccess
  handler(
    context: RealtimeHandlerContext<RealtimeArgsForSchema<TSchema>, TAccess>
  ): TResult | Promise<TResult>
}

export type RealtimeMutationInput<
  TName extends string | undefined,
  TSchema extends ValidationSchema | undefined,
  TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult,
> = RealtimeQueryInput<TName, TSchema, TAccess, TResult>

export interface RealtimeDefinitionTypes<TArgs, TResult, TAccess> {
  readonly args: TArgs
  readonly result: TResult
  readonly access: TAccess
}

export interface RealtimeQueryDefinitionMetadata<
  TName extends string | undefined = string | undefined,
  TSchema extends ValidationSchema | undefined = ValidationSchema | undefined,
  TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
> {
  readonly kind: 'query'
  readonly name: TName extends string ? TName : string
  readonly args?: TSchema
  readonly access: TAccess
  handler(
    context: RealtimeHandlerContext<RealtimeArgsForSchema<TSchema>, TAccess>
  ): TResult | Promise<TResult>
  readonly $types: RealtimeDefinitionTypes<RealtimeArgsForSchema<TSchema>, Awaited<TResult>, TAccess>
}

export type RealtimeQueryDefinition<
  TName extends string | undefined = string | undefined,
  TSchema extends ValidationSchema | undefined = ValidationSchema | undefined,
  TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
> = RealtimeCaller<RealtimeArgsForSchema<TSchema>, Awaited<TResult>>
  & RealtimeQueryDefinitionMetadata<TName, TSchema, TAccess, TResult>

export interface RealtimeMutationDefinitionMetadata<
  TName extends string | undefined = string | undefined,
  TSchema extends ValidationSchema | undefined = ValidationSchema | undefined,
  TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
> {
  readonly kind: 'mutation'
  readonly name: TName extends string ? TName : string
  readonly args?: TSchema
  readonly access: TAccess
  readonly handler: (
    context: RealtimeHandlerContext<RealtimeArgsForSchema<TSchema>, TAccess>
  ) => TResult | Promise<TResult>
  readonly $types: RealtimeDefinitionTypes<RealtimeArgsForSchema<TSchema>, Awaited<TResult>, TAccess>
}

export type RealtimeMutationDefinition<
  TName extends string | undefined = string | undefined,
  TSchema extends ValidationSchema | undefined = ValidationSchema | undefined,
  TAccess extends RealtimeAccess<RealtimeArgsForSchema<TSchema>> = RealtimeAccess<RealtimeArgsForSchema<TSchema>>,
  TResult = unknown,
> = RealtimeCaller<RealtimeArgsForSchema<TSchema>, Promise<Awaited<TResult>>>
  & RealtimeMutationDefinitionMetadata<TName, TSchema, TAccess, TResult>

export type RealtimeArgsFor<TDefinition>
  = TDefinition extends { readonly $types: { readonly args: infer TArgs } }
    ? TArgs
    : never

export type RealtimeResultFor<TDefinition>
  = TDefinition extends { readonly $types: { readonly result: infer TResult } }
    ? TResult
    : never

export interface RealtimeExecutionResult<TResult> {
  readonly name: string
  readonly data: TResult
  readonly dependencies: readonly string[]
}

export interface RealtimeSubscriptionSnapshot<TResult> extends RealtimeExecutionResult<TResult> {
  readonly version: number
}

export interface RealtimeSubscription<TResult> {
  readonly id: string
  readonly name: string
  readonly current: RealtimeSubscriptionSnapshot<TResult>
  unsubscribe(): void
}

export interface RealtimeSubscribeOptions<TResult> {
  readonly onData?: (snapshot: RealtimeSubscriptionSnapshot<TResult>) => void | Promise<void>
  readonly onError?: (error: unknown) => void | Promise<void>
}

export interface RealtimeRuntimeBindings {
  readonly db?: () => DatabaseContext
  readonly loadAuthModule?: () => Promise<RealtimeAuthModule | null>
}

export interface RealtimeAuthGuardRuntime {
  user(): Promise<AuthenticatedAuthUser | null>
  provider(): Promise<string | null>
}

export interface RealtimeAuthRuntime {
  user(): Promise<AuthenticatedAuthUser | null>
  provider(): Promise<string | null>
  guard(name: string): RealtimeAuthGuardRuntime
}

export interface RealtimeAuthModule {
  getAuthRuntime(): RealtimeAuthRuntime
}
