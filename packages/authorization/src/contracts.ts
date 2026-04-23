const AUTHORIZATION_POLICY_MARKER = Symbol.for('holo-js.authorization.policy')
const AUTHORIZATION_ABILITY_MARKER = Symbol.for('holo-js.authorization.ability')
declare const AUTHORIZATION_POLICY_REGISTRY_MARKER: unique symbol
declare const AUTHORIZATION_ABILITY_REGISTRY_MARKER: unique symbol
declare const AUTHORIZATION_GUARD_REGISTRY_MARKER: unique symbol

export type AuthorizationDecisionStatus = 200 | 403 | 404

export interface AuthorizationDecision {
  readonly allowed: boolean
  readonly status: AuthorizationDecisionStatus
  readonly message?: string
  readonly code?: string
}

export interface AuthorizationActorContext<TActor = object> {
  readonly user: TActor | null
  readonly authenticated: boolean
}

export interface AuthorizationGuardActorContext<TActor = object, TGuardName extends string = string> extends AuthorizationActorContext<TActor> {
  readonly guard: TGuardName
}

export interface AuthorizationAuthorizationContext<
  TActor = object,
  TGuardName extends string = string,
> extends AuthorizationActorContext<TActor> {
  readonly guard?: TGuardName
}

export type AuthorizationDecisionInput = AuthorizationDecision | boolean

export interface AuthorizationTargetConstructor<TInstance = object> {
  readonly prototype: TInstance
}

export interface AuthorizationTargetModelDefinition {
  readonly name: string
  readonly table?: {
    readonly tableName?: string
  }
}

export interface AuthorizationTargetModel<TInstance extends object = object> {
  readonly definition: AuthorizationTargetModelDefinition
  query(): {
    first(): Promise<TInstance | undefined>
    firstOrFail(): Promise<TInstance>
  }
}

export type AuthorizationPolicyTarget<TInstance extends object = object>
  = | AuthorizationTargetConstructor<TInstance>
    | AuthorizationTargetModel<TInstance>

export type AuthorizationTargetInstance<TTarget extends AuthorizationPolicyTarget> = TTarget extends AuthorizationTargetConstructor<infer TInstance>
  ? TInstance
  : TTarget extends AuthorizationTargetModel<infer TInstance>
  ? TInstance
  : object

export interface AuthorizationPolicyClassHandler<
  TActor = object,
  TTarget extends AuthorizationPolicyTarget = AuthorizationPolicyTarget,
> {
  (
    context: AuthorizationAuthorizationContext<TActor>,
    target: TTarget,
  ): AuthorizationDecisionInput | Promise<AuthorizationDecisionInput>
}

export interface AuthorizationPolicyRecordHandler<
  TActor = object,
  TTarget extends AuthorizationPolicyTarget = AuthorizationPolicyTarget,
> {
  (
    context: AuthorizationAuthorizationContext<TActor>,
    target: AuthorizationTargetInstance<TTarget>,
  ): AuthorizationDecisionInput | Promise<AuthorizationDecisionInput>
}

export interface AuthorizationPolicyBeforeHandler<
  TActor = object,
  TTarget extends AuthorizationPolicyTarget = AuthorizationPolicyTarget,
> {
  (
    context: AuthorizationAuthorizationContext<TActor>,
    target: TTarget | AuthorizationTargetInstance<TTarget>,
  ): AuthorizationDecisionInput | void | Promise<AuthorizationDecisionInput | void>
}

export interface AuthorizationPolicyDefinition<
  TName extends string = string,
  TTarget extends AuthorizationPolicyTarget = AuthorizationPolicyTarget,
  TClassActions extends string = string,
  TRecordActions extends string = string,
  TActor = object,
> {
  readonly [AUTHORIZATION_POLICY_MARKER]: true
  readonly name: TName
  readonly target: TTarget
  readonly before?: AuthorizationPolicyBeforeHandler<TActor, TTarget>
  readonly class?: Readonly<Record<TClassActions, AuthorizationPolicyClassHandler<TActor, TTarget>>>
  readonly record?: Readonly<Record<TRecordActions, AuthorizationPolicyRecordHandler<TActor, TTarget>>>
}

export interface AuthorizationAbilityDefinition<
  TName extends string = string,
  TInput extends object = object,
  TActor = object,
> {
  readonly [AUTHORIZATION_ABILITY_MARKER]: true
  readonly name: TName
  readonly handle: AuthorizationAbilityHandler<TActor, TInput>
}

export interface AuthorizationAbilityHandler<TActor = object, TInput extends object = object> {
  (
    context: AuthorizationAuthorizationContext<TActor>,
    input: TInput,
  ): AuthorizationDecisionInput | Promise<AuthorizationDecisionInput>
}

export interface AuthorizationPolicyRegistryEntry<
  TTarget extends AuthorizationPolicyTarget = AuthorizationPolicyTarget,
  TClassActions extends string = string,
  TRecordActions extends string = string,
  TActor = object,
> {
  readonly actor?: TActor
  readonly target: TTarget
  readonly classActions: Readonly<Record<TClassActions, AuthorizationPolicyClassHandler<TActor, TTarget>>>
  readonly recordActions: Readonly<Record<TRecordActions, AuthorizationPolicyRecordHandler<TActor, TTarget>>>
  readonly before?: AuthorizationPolicyBeforeHandler<TActor, TTarget>
}

export interface AuthorizationPolicyRegistry {
  readonly [AUTHORIZATION_POLICY_REGISTRY_MARKER]?: true
}

export interface AuthorizationAbilityRegistryEntry<TInput extends object = object, TActor = object> {
  readonly actor?: TActor
  readonly input: TInput
  readonly handler?: AuthorizationAbilityHandler<TActor, TInput>
}

export interface AuthorizationAbilityRegistry {
  readonly [AUTHORIZATION_ABILITY_REGISTRY_MARKER]?: true
}

export interface AuthorizationGuardRegistry {
  readonly [AUTHORIZATION_GUARD_REGISTRY_MARKER]?: true
}

type FallbackRegistryName<TName extends string> = [TName] extends [never] ? string : TName
type FallbackRegistryAction<TAction extends string> = [TAction] extends [never] ? string : TAction
type FallbackRegistryInput<TInput extends object> = [TInput] extends [never] ? object : TInput
type FallbackRegistryActor<TActor> = [TActor] extends [never] ? object : TActor

export type HoloPolicyName = FallbackRegistryName<Extract<keyof AuthorizationPolicyRegistry, string>>
export type HoloAbilityName = FallbackRegistryName<Extract<keyof AuthorizationAbilityRegistry, string>>
export type HoloAuthorizationGuardName = FallbackRegistryName<Extract<keyof AuthorizationGuardRegistry, string>>

type RegisteredAuthorizationPolicyName = Extract<keyof AuthorizationPolicyRegistry, string>
type RegisteredAuthorizationAbilityName = Extract<keyof AuthorizationAbilityRegistry, string>

type RegisteredAuthorizationPolicyEntry<TPolicyName extends string> = AuthorizationPolicyRegistry[
  Extract<TPolicyName, RegisteredAuthorizationPolicyName>
]
type RegisteredAuthorizationAbilityEntry<TAbilityName extends string> = AuthorizationAbilityRegistry[
  Extract<TAbilityName, RegisteredAuthorizationAbilityName>
]

export type PolicyActorForName<TPolicyName extends string> = RegisteredAuthorizationPolicyEntry<TPolicyName> extends AuthorizationPolicyRegistryEntry<
  AuthorizationPolicyTarget,
  string,
  string,
  infer TActor
>
  ? FallbackRegistryActor<TActor>
  : RegisteredAuthorizationPolicyEntry<TPolicyName> extends {
    actor: infer TActor
  }
  ? FallbackRegistryActor<TActor>
  : object

export type AbilityActorForName<TAbilityName extends string> = RegisteredAuthorizationAbilityEntry<TAbilityName> extends AuthorizationAbilityRegistryEntry<
  object,
  infer TActor
>
  ? FallbackRegistryActor<TActor>
  : RegisteredAuthorizationAbilityEntry<TAbilityName> extends {
    actor: infer TActor
  }
  ? FallbackRegistryActor<TActor>
  : object

type RegisteredPolicyClassActionFor<TTarget> = {
  [TName in RegisteredAuthorizationPolicyName]: RegisteredAuthorizationPolicyEntry<TName> extends {
    target: infer TRegisteredTarget extends AuthorizationPolicyTarget
    classActions: infer TClassActions extends Record<string, unknown>
    recordActions: infer _TRecordActions extends Record<string, unknown>
    }
    ? TTarget extends AuthorizationPolicyTarget
      ? TTarget extends TRegisteredTarget
        ? FallbackRegistryAction<Extract<keyof TClassActions, string>>
        : never
      : never
    : never
}[RegisteredAuthorizationPolicyName]

type RegisteredPolicyRecordActionFor<TTarget> = {
  [TName in RegisteredAuthorizationPolicyName]: RegisteredAuthorizationPolicyEntry<TName> extends {
    target: infer TRegisteredTarget extends AuthorizationPolicyTarget
    classActions: infer _TClassActions extends Record<string, unknown>
    recordActions: infer TRecordActions extends Record<string, unknown>
  }
    ? TTarget extends AuthorizationPolicyTarget
      ? never
      : TTarget extends AuthorizationTargetInstance<TRegisteredTarget>
        ? FallbackRegistryAction<Extract<keyof TRecordActions, string>>
        : never
    : never
}[RegisteredAuthorizationPolicyName]

export type PolicyClassActionFor<TTarget> = FallbackRegistryAction<RegisteredPolicyClassActionFor<TTarget>>

export type PolicyRecordActionFor<TTarget> = FallbackRegistryAction<RegisteredPolicyRecordActionFor<TTarget>>

export type PolicyActionFor<TTarget> = TTarget extends AuthorizationPolicyTarget
  ? PolicyClassActionFor<TTarget>
  : PolicyRecordActionFor<TTarget>

export type PolicyActionForPolicy<
  TPolicyName extends HoloPolicyName,
  TTarget,
> = RegisteredAuthorizationPolicyEntry<TPolicyName> extends {
  target: infer _TRegisteredTarget extends AuthorizationPolicyTarget
  classActions: infer TClassActions extends Record<string, unknown>
  recordActions: infer TRecordActions extends Record<string, unknown>
}
  ? TTarget extends AuthorizationPolicyTarget
    ? FallbackRegistryAction<Extract<keyof TClassActions, string>>
    : FallbackRegistryAction<Extract<keyof TRecordActions, string>>
  : string

export type PolicyTargetForPolicy<TPolicyName extends HoloPolicyName> = RegisteredAuthorizationPolicyEntry<TPolicyName> extends {
  target: infer TTarget extends AuthorizationPolicyTarget
}
  ? TTarget
  : AuthorizationPolicyTarget

export type PolicyClassActionForPolicy<TPolicyName extends HoloPolicyName> = RegisteredAuthorizationPolicyEntry<TPolicyName> extends {
  classActions: infer TClassActions extends Record<string, unknown>
}
  ? FallbackRegistryAction<Extract<keyof TClassActions, string>>
  : string

export type PolicyRecordActionForPolicy<TPolicyName extends HoloPolicyName> = RegisteredAuthorizationPolicyEntry<TPolicyName> extends {
  recordActions: infer TRecordActions extends Record<string, unknown>
}
  ? FallbackRegistryAction<Extract<keyof TRecordActions, string>>
  : string

export type PolicyInstanceForPolicy<TPolicyName extends HoloPolicyName> = AuthorizationTargetInstance<PolicyTargetForPolicy<TPolicyName>>

export type AbilityInput<TAbilityName extends HoloAbilityName> = RegisteredAuthorizationAbilityEntry<TAbilityName> extends AuthorizationAbilityRegistryEntry<
  infer TInput,
  object
>
  ? FallbackRegistryInput<TInput>
  : object

export interface AuthorizationPolicyBuilder<TPolicyName extends HoloPolicyName> {
  authorize(action: PolicyClassActionForPolicy<TPolicyName>, target: PolicyTargetForPolicy<TPolicyName>): Promise<void>
  authorize(action: PolicyRecordActionForPolicy<TPolicyName>, target: PolicyInstanceForPolicy<TPolicyName>): Promise<void>
  can(action: PolicyClassActionForPolicy<TPolicyName>, target: PolicyTargetForPolicy<TPolicyName>): Promise<boolean>
  can(action: PolicyRecordActionForPolicy<TPolicyName>, target: PolicyInstanceForPolicy<TPolicyName>): Promise<boolean>
  cannot(action: PolicyClassActionForPolicy<TPolicyName>, target: PolicyTargetForPolicy<TPolicyName>): Promise<boolean>
  cannot(action: PolicyRecordActionForPolicy<TPolicyName>, target: PolicyInstanceForPolicy<TPolicyName>): Promise<boolean>
  inspect(action: PolicyClassActionForPolicy<TPolicyName>, target: PolicyTargetForPolicy<TPolicyName>): Promise<AuthorizationDecision>
  inspect(action: PolicyRecordActionForPolicy<TPolicyName>, target: PolicyInstanceForPolicy<TPolicyName>): Promise<AuthorizationDecision>
}

export interface AuthorizationAbilityBuilder<TAbilityName extends HoloAbilityName> {
  authorize(input: AbilityInput<TAbilityName>): Promise<void>
  can(input: AbilityInput<TAbilityName>): Promise<boolean>
  cannot(input: AbilityInput<TAbilityName>): Promise<boolean>
  inspect(input: AbilityInput<TAbilityName>): Promise<AuthorizationDecision>
}

export interface AuthorizationActorBuilder {
  authorize<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<void>
  authorize<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<void>
  can<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  can<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  cannot<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  cannot<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  inspect<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<AuthorizationDecision>
  inspect<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<AuthorizationDecision>
  policy<TPolicyName extends HoloPolicyName>(name: TPolicyName): AuthorizationPolicyBuilder<TPolicyName>
  ability<TAbilityName extends HoloAbilityName>(name: TAbilityName): AuthorizationAbilityBuilder<TAbilityName>
}

export interface AuthorizationFacade {
  forUser<TActor extends object>(actor: TActor | null): AuthorizationActorBuilder
  guard<TGuardName extends HoloAuthorizationGuardName>(name: TGuardName): AuthorizationActorBuilder
  authorize<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<void>
  authorize<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<void>
  can<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  can<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  cannot<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  cannot<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<boolean>
  inspect<TTarget extends AuthorizationPolicyTarget>(
    action: PolicyClassActionFor<TTarget>,
    target: TTarget,
  ): Promise<AuthorizationDecision>
  inspect<TTarget extends object>(
    action: PolicyRecordActionFor<TTarget>,
    target: TTarget,
  ): Promise<AuthorizationDecision>
}

export class AuthorizationError extends Error {
  readonly decision: AuthorizationDecision

  constructor(message: string, decision: AuthorizationDecision) {
    super(message)
    this.name = 'AuthorizationError'
    this.decision = decision
  }
}

export class AuthorizationPolicyNotFoundError extends Error {
  constructor(message = '[@holo-js/authorization] Policy definition was not found.') {
    super(message)
    this.name = 'AuthorizationPolicyNotFoundError'
  }
}

export class AuthorizationAbilityNotFoundError extends Error {
  constructor(message = '[@holo-js/authorization] Ability definition was not found.') {
    super(message)
    this.name = 'AuthorizationAbilityNotFoundError'
  }
}

export class AuthorizationAuthIntegrationMissingError extends Error {
  constructor(message = '[@holo-js/authorization] Auth integration is not configured yet.') {
    super(message)
    this.name = 'AuthorizationAuthIntegrationMissingError'
  }
}

export class AuthorizationGuardNotFoundError extends Error {
  constructor(message = '[@holo-js/authorization] Guard was not found.') {
    super(message)
    this.name = 'AuthorizationGuardNotFoundError'
  }
}

export function allow(message?: string): AuthorizationDecision {
  return Object.freeze({
    allowed: true,
    status: 200 as const,
    ...(message ? { message } : {}),
  })
}

export function deny(message = 'You are not authorized to perform this action.'): AuthorizationDecision {
  return Object.freeze({
    allowed: false,
    status: 403 as const,
    message,
  })
}

export function denyAsNotFound(message = 'Resource not found.'): AuthorizationDecision {
  return Object.freeze({
    allowed: false,
    status: 404 as const,
    message,
  })
}

export function isAuthorizationDecision(value: unknown): value is AuthorizationDecision {
  if (!value || typeof value !== 'object') {
    return false
  }

  const decision = value as Partial<AuthorizationDecision>
  return typeof decision.allowed === 'boolean'
    && (decision.status === 200 || decision.status === 403 || decision.status === 404)
}

export function isAuthorizationPolicyDefinition(value: unknown): value is AuthorizationPolicyDefinition {
  return !!value
    && typeof value === 'object'
    && (value as { readonly [AUTHORIZATION_POLICY_MARKER]?: unknown })[AUTHORIZATION_POLICY_MARKER] === true
}

export function isAuthorizationAbilityDefinition(value: unknown): value is AuthorizationAbilityDefinition {
  return !!value
    && typeof value === 'object'
    && (value as { readonly [AUTHORIZATION_ABILITY_MARKER]?: unknown })[AUTHORIZATION_ABILITY_MARKER] === true
}

export function normalizeAuthorizationDecision(
  outcome: AuthorizationDecisionInput | undefined,
  fallbackMessage = 'You are not authorized to perform this action.',
): AuthorizationDecision {
  if (typeof outcome === 'boolean') {
    return outcome ? allow() : deny(fallbackMessage)
  }

  if (isAuthorizationDecision(outcome)) {
    return outcome
  }

  return deny(fallbackMessage)
}

export { AUTHORIZATION_POLICY_MARKER, AUTHORIZATION_ABILITY_MARKER }
