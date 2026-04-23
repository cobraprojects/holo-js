import type {
  AuthorizationAbilityDefinition,
  AuthorizationAbilityBuilder,
  AuthorizationAbilityHandler,
  AuthorizationActorContext,
  AuthorizationActorBuilder,
  AuthorizationDecision,
  AuthorizationDecisionInput,
  AuthorizationError,
  AuthorizationGuardActorContext,
  AuthorizationPolicyClassHandler,
  AuthorizationPolicyBeforeHandler,
  AuthorizationPolicyBuilder,
  AuthorizationPolicyDefinition,
  AuthorizationPolicyRecordHandler,
  AuthorizationPolicyTarget,
  AuthorizationTargetModel,
  AuthorizationTargetModelDefinition,
  AuthorizationTargetConstructor,
  AuthorizationAbilityRegistry,
  AuthorizationPolicyRegistry,
  AbilityInput,
  HoloAbilityName,
  HoloPolicyName,
  HoloAuthorizationGuardName,
  PolicyActionFor,
  PolicyActionForPolicy,
  AbilityActorForName,
  PolicyActorForName,
} from './contracts'
import {
  allow,
  deny,
  denyAsNotFound,
  AuthorizationAbilityNotFoundError,
  AuthorizationAuthIntegrationMissingError,
  AuthorizationError as AuthorizationErrorClass,
  AuthorizationPolicyNotFoundError as PolicyNotFoundError,
  AuthorizationGuardNotFoundError,
  AUTHORIZATION_POLICY_MARKER,
  AUTHORIZATION_ABILITY_MARKER,
  normalizeAuthorizationDecision,
} from './contracts'

type RegisteredPolicy = AuthorizationPolicyDefinition<string, AuthorizationPolicyTarget, string, string, object>
type RegisteredAbility = AuthorizationAbilityDefinition<string, object, object>

type FallbackAuthorizationActor<TActor> = [TActor] extends [never]
  ? object
  : Extract<TActor, object>

type PolicyActorForDefinition<TName extends string> = [Extract<TName, keyof AuthorizationPolicyRegistry & string>] extends [never]
  ? object
  : FallbackAuthorizationActor<PolicyActorForName<Extract<TName, keyof AuthorizationPolicyRegistry & string>>>

type AbilityActorForDefinition<TName extends string> = [Extract<TName, keyof AuthorizationAbilityRegistry & string>] extends [never]
  ? object
  : FallbackAuthorizationActor<AbilityActorForName<Extract<TName, keyof AuthorizationAbilityRegistry & string>>>

type AuthorizationAuthIntegration = {
  hasGuard(guardName: string): boolean
  resolveDefaultActor(): Promise<object | null> | object | null
  resolveGuardActor(guardName: string): Promise<object | null> | object | null
}

type AuthorizationRuntimeState = {
  policiesByName: Map<string, RegisteredPolicy>
  policiesByTargetObject: WeakMap<object, RegisteredPolicy>
  policiesByDefinitionKey: Map<string, RegisteredPolicy>
  abilitiesByName: Map<string, RegisteredAbility>
  authIntegration: AuthorizationAuthIntegration | null
}

function createAuthorizationRuntimeState(): AuthorizationRuntimeState {
  return {
    policiesByName: new Map(),
    policiesByTargetObject: new WeakMap(),
    policiesByDefinitionKey: new Map(),
    abilitiesByName: new Map(),
    authIntegration: null,
  }
}

function getAuthorizationRuntimeState(): AuthorizationRuntimeState {
  const runtime = globalThis as typeof globalThis & {
    __holoAuthorizationRuntime__?: AuthorizationRuntimeState
  }

  runtime.__holoAuthorizationRuntime__ ??= createAuthorizationRuntimeState()
  return runtime.__holoAuthorizationRuntime__
}

function resetAuthorizationRuntimeState(): void {
  const runtime = globalThis as typeof globalThis & {
    __holoAuthorizationRuntime__?: AuthorizationRuntimeState
  }

  runtime.__holoAuthorizationRuntime__ = createAuthorizationRuntimeState()
}

function configureAuthorizationAuthIntegration(integration?: AuthorizationAuthIntegration): void {
  const state = getAuthorizationRuntimeState()
  state.authIntegration = integration ?? null
}

function resetAuthorizationAuthIntegration(): void {
  getAuthorizationRuntimeState().authIntegration = null
}

function getAuthorizationAuthIntegration(): AuthorizationAuthIntegration {
  const integration = getAuthorizationRuntimeState().authIntegration
  if (!integration) {
    throw new AuthorizationAuthIntegrationMissingError('[@holo-js/authorization] Auth integration is not configured yet.')
  }

  return integration
}

function normalizePolicyName<TName extends string>(name: TName): TName {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new TypeError('[@holo-js/authorization] Policy name must be a non-empty string.')
  }

  return trimmed as TName
}

function normalizeAbilityName<TName extends string>(name: TName): TName {
  const trimmed = name.trim()
  if (!trimmed) {
    throw new TypeError('[@holo-js/authorization] Ability name must be a non-empty string.')
  }

  return trimmed as TName
}

function normalizeTarget<TTarget extends AuthorizationPolicyTarget>(target: TTarget): TTarget {
  if (typeof target === 'function') {
    return target
  }

  if (isAuthorizationTargetModel(target)) {
    return target
  }

  throw new TypeError('[@holo-js/authorization] Policy targets must be class constructors or model references.')
}

function normalizeHandlerMap<THandler extends Record<string, unknown> | undefined>(
  value: THandler,
  label: string,
): THandler {
  if (typeof value === 'undefined') {
    return value
  }

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`[@holo-js/authorization] ${label} must be a plain object when provided.`)
  }

  return value
}

function validateHandlerMap(
  value: Readonly<Record<string, unknown>> | undefined,
  label: string,
): void {
  if (!value) {
    return
  }

  for (const [name, handler] of Object.entries(value)) {
    if (typeof handler !== 'function') {
      throw new TypeError(`[@holo-js/authorization] ${label}.${name} must be a function.`)
    }
  }
}

function validatePolicyDefinition(definition: AuthorizationPolicyDefinition<string, AuthorizationPolicyTarget, string, string, object>): void {
  validateHandlerMap(definition.class, 'policy.class')
  validateHandlerMap(definition.record, 'policy.record')
  if (definition.before && typeof definition.before !== 'function') {
    throw new TypeError('[@holo-js/authorization] policy.before must be a function when provided.')
  }
}

function validateAbilityDefinition(definition: AuthorizationAbilityDefinition<string, object, object>): void {
  if (typeof definition.handle !== 'function') {
    throw new TypeError('[@holo-js/authorization] Ability handler must be a function.')
  }
}

function registerPolicyDefinition<TDefinition extends RegisteredPolicy>(definition: TDefinition): TDefinition {
  const state = getAuthorizationRuntimeState()
  if (state.policiesByName.has(definition.name)) {
    throw new Error(`[@holo-js/authorization] Policy "${definition.name}" is already registered.`)
  }

  if (state.policiesByTargetObject.get(definition.target)) {
    throw new Error('[@holo-js/authorization] A policy is already registered for this target.')
  }

  const definitionKey = getDefinitionKeyForTarget(definition.target)
  if (definitionKey && state.policiesByDefinitionKey.has(definitionKey)) {
    throw new Error(`[@holo-js/authorization] A policy is already registered for target definition "${definitionKey}".`)
  }

  state.policiesByName.set(definition.name, definition)
  state.policiesByTargetObject.set(definition.target, definition)
  if (definitionKey) {
    state.policiesByDefinitionKey.set(definitionKey, definition)
  }
  return definition
}

function registerAbilityDefinition<TDefinition extends RegisteredAbility>(definition: TDefinition): TDefinition {
  const state = getAuthorizationRuntimeState()
  if (state.abilitiesByName.has(definition.name)) {
    throw new Error(`[@holo-js/authorization] Ability "${definition.name}" is already registered.`)
  }

  state.abilitiesByName.set(definition.name, definition)
  return definition
}

function unregisterPolicyDefinition(name: string): void {
  const state = getAuthorizationRuntimeState()
  const definition = state.policiesByName.get(name)
  if (!definition) {
    return
  }

  state.policiesByName.delete(name)
  state.policiesByTargetObject.delete(definition.target)
  const definitionKey = getDefinitionKeyForTarget(definition.target)
  if (definitionKey) {
    state.policiesByDefinitionKey.delete(definitionKey)
  }
}

function unregisterAbilityDefinition(name: string): void {
  getAuthorizationRuntimeState().abilitiesByName.delete(name)
}

function freezePolicyDefinition<TDefinition extends RegisteredPolicy>(definition: TDefinition): TDefinition {
  return Object.freeze({
    ...definition,
    class: definition.class ? Object.freeze({ ...definition.class }) : definition.class,
    record: definition.record ? Object.freeze({ ...definition.record }) : definition.record,
  }) as TDefinition
}

function freezeAbilityDefinition<TDefinition extends RegisteredAbility>(definition: TDefinition): TDefinition {
  return Object.freeze(definition) as TDefinition
}

export function definePolicy<
  TName extends string,
  TTarget extends AuthorizationPolicyTarget,
  TDefinition extends {
    readonly before?: AuthorizationPolicyBeforeHandler<PolicyActorForDefinition<TName>, TTarget>
    readonly class?: Readonly<Record<string, AuthorizationPolicyClassHandler<PolicyActorForDefinition<TName>, TTarget>>>
    readonly record?: Readonly<Record<string, AuthorizationPolicyRecordHandler<PolicyActorForDefinition<TName>, TTarget>>>
  },
>(
  name: TName,
  target: TTarget,
  definition: TDefinition & {
    readonly before?: AuthorizationPolicyBeforeHandler<PolicyActorForDefinition<TName>, TTarget>
    readonly class?: Readonly<Record<string, AuthorizationPolicyClassHandler<PolicyActorForDefinition<TName>, TTarget>>>
    readonly record?: Readonly<Record<string, AuthorizationPolicyRecordHandler<PolicyActorForDefinition<TName>, TTarget>>>
  },
): AuthorizationPolicyDefinition<
  TName,
  TTarget,
  Extract<keyof NonNullable<TDefinition['class']>, string>,
  Extract<keyof NonNullable<TDefinition['record']>, string>,
  PolicyActorForDefinition<TName>
> {
  const normalizedName = normalizePolicyName(name)
  const normalizedTarget = normalizeTarget(target)
  const normalizedClass = normalizeHandlerMap(definition.class, 'policy.class')
  const normalizedRecord = normalizeHandlerMap(definition.record, 'policy.record')
  const runtimeDefinition = {
    [AUTHORIZATION_POLICY_MARKER]: true,
    name: normalizedName,
    target: normalizedTarget,
    before: definition.before,
    class: normalizedClass,
    record: normalizedRecord,
  } as RegisteredPolicy
  validatePolicyDefinition(runtimeDefinition)

  const registered = registerPolicyDefinition(freezePolicyDefinition(runtimeDefinition))

  return registered as AuthorizationPolicyDefinition<
    TName,
    TTarget,
    Extract<keyof NonNullable<TDefinition['class']>, string>,
    Extract<keyof NonNullable<TDefinition['record']>, string>,
    PolicyActorForDefinition<TName>
  >
}

export function defineAbility<
  TName extends string,
  TInput extends object,
>(
  name: TName,
  handle: AuthorizationAbilityHandler<AbilityActorForDefinition<TName>, TInput>,
): AuthorizationAbilityDefinition<TName, TInput> {
  const normalizedName = normalizeAbilityName(name)
  const runtimeDefinition = {
    [AUTHORIZATION_ABILITY_MARKER]: true,
    name: normalizedName,
    handle,
  } as unknown as RegisteredAbility
  validateAbilityDefinition(runtimeDefinition)

  const registered = registerAbilityDefinition(freezeAbilityDefinition(runtimeDefinition))

  return registered as unknown as AuthorizationAbilityDefinition<TName, TInput>
}

function getPolicyByName(name: string): RegisteredPolicy {
  const policy = getAuthorizationRuntimeState().policiesByName.get(name)
  if (!policy) {
    throw new PolicyNotFoundError(`[@holo-js/authorization] Policy "${name}" was not found.`)
  }

  return policy
}

function getAbilityByName(name: string): RegisteredAbility {
  const ability = getAuthorizationRuntimeState().abilitiesByName.get(name)
  if (!ability) {
    throw new AuthorizationAbilityNotFoundError(`[@holo-js/authorization] Ability "${name}" was not found.`)
  }

  return ability
}

function getPolicyByTarget(target: AuthorizationPolicyTarget | object): RegisteredPolicy {
  const state = getAuthorizationRuntimeState()
  if (typeof target === 'function' || isAuthorizationTargetModel(target)) {
    const directPolicy = state.policiesByTargetObject.get(target)
    if (directPolicy) {
      return directPolicy
    }

    const directDefinitionKey = getDefinitionKeyForTarget(target)
    if (directDefinitionKey) {
      const definitionPolicy = state.policiesByDefinitionKey.get(directDefinitionKey)
      if (definitionPolicy) {
        return definitionPolicy
      }
    }
  }

  const targetConstructor = getTargetConstructor(target)
  if (targetConstructor) {
    const constructorPolicy = state.policiesByTargetObject.get(targetConstructor)
    if (constructorPolicy) {
      return constructorPolicy
    }
  }

  const instanceDefinitionKey = getDefinitionKeyForTargetInstance(target)
  if (instanceDefinitionKey) {
    const definitionPolicy = state.policiesByDefinitionKey.get(instanceDefinitionKey)
    if (definitionPolicy) {
      return definitionPolicy
    }
  }

  throw new PolicyNotFoundError('[@holo-js/authorization] Policy definition was not found for the target.')
}

function getTargetConstructor(target: object): AuthorizationTargetConstructor | null {
  const candidate = (target as { constructor?: AuthorizationTargetConstructor | undefined }).constructor
  return isAuthorizationTargetConstructor(candidate)
    ? candidate
    : null
}

function isAuthorizationTargetConstructor(value: unknown): value is AuthorizationTargetConstructor {
  return typeof value === 'function'
    && 'prototype' in value
}

function isAuthorizationTargetModel(value: unknown): value is AuthorizationTargetModel<object> {
  return !!value
    && typeof value === 'object'
    && 'definition' in value
    && isAuthorizationTargetModelDefinition((value as { definition?: unknown }).definition)
}

function isAuthorizationTargetModelDefinition(value: unknown): value is AuthorizationTargetModelDefinition {
  return !!value
    && typeof value === 'object'
    && 'name' in value
    && typeof (value as { name?: unknown }).name === 'string'
}

function getDefinitionKeyForTarget(target: AuthorizationPolicyTarget): string | null {
  if (!isAuthorizationTargetModel(target)) {
    return null
  }

  return buildDefinitionKey(target.definition)
}

function getDefinitionKeyForTargetInstance(target: object): string | null {
  const candidate = target as {
    getRepository?: (() => {
      definition?: unknown
    }) | undefined
  }

  if (typeof candidate.getRepository !== 'function') {
    return null
  }

  const repository = candidate.getRepository()
  if (!repository || typeof repository !== 'object' || !('definition' in repository)) {
    return null
  }

  const definition = (repository as { definition?: unknown }).definition
  return isAuthorizationTargetModelDefinition(definition)
    ? buildDefinitionKey(definition)
    : null
}

function buildDefinitionKey(definition: AuthorizationTargetModelDefinition): string {
  const tableName = definition.table?.tableName?.trim()
  const modelName = definition.name.trim()
  return tableName
    ? `${modelName}:${tableName}`
    : modelName
}

function resolveContext<TActor extends object>(actor: TActor | null): AuthorizationActorContext<TActor>
function resolveContext<TActor extends object, TGuardName extends string>(
  actor: TActor | null,
  guard: TGuardName,
): AuthorizationGuardActorContext<TActor, TGuardName>
function resolveContext<TActor extends object, TGuardName extends string>(
  actor: TActor | null,
  guard?: TGuardName,
): AuthorizationActorContext<TActor> | AuthorizationGuardActorContext<TActor, TGuardName> {
  const baseContext = {
    user: actor,
    authenticated: actor !== null,
  }

  if (typeof guard === 'string') {
    return Object.freeze({
      ...baseContext,
      guard,
    })
  }

  return Object.freeze(baseContext)
}

function createAuthorizationError(decision: AuthorizationDecision): AuthorizationError {
  return new AuthorizationErrorClass(
    decision.message ?? 'You are not authorized to perform this action.',
    decision,
  )
}

function normalizeResult(outcome: AuthorizationDecisionInput | Promise<AuthorizationDecisionInput>): Promise<AuthorizationDecision> {
  return Promise.resolve(outcome).then(result => normalizeAuthorizationDecision(result))
}

async function evaluateBeforeHook(
  before: AuthorizationPolicyBeforeHandler<object, AuthorizationPolicyTarget> | undefined,
  context: AuthorizationActorContext<object> | AuthorizationGuardActorContext<object, string>,
  target: AuthorizationPolicyTarget | object,
): Promise<AuthorizationDecision | undefined> {
  if (!before) {
    return undefined
  }

  const outcome = await before(context, target as AuthorizationPolicyTarget & object)
  if (typeof outcome === 'undefined') {
    return undefined
  }

  return normalizeAuthorizationDecision(outcome)
}

async function evaluatePolicyByTarget(
  actor: object | null,
  action: string,
  target: AuthorizationPolicyTarget | object,
  guard?: string,
): Promise<AuthorizationDecision> {
  const policy = getPolicyByTarget(target)
  const context = typeof guard === 'string'
    ? resolveContext(actor, guard)
    : resolveContext(actor)
  if (typeof target === 'function' || isAuthorizationTargetModel(target)) {
    const beforeDecision = await evaluateBeforeHook(policy.before, context, target)
    if (beforeDecision) {
      return beforeDecision
    }

    const handler = policy.class?.[action]
    if (!handler) {
      throw new AuthorizationErrorClass(
        `[@holo-js/authorization] Policy action "${action}" is not defined for the selected target.`,
        deny(),
      )
    }

    return await normalizeResult(handler(context, target))
  }

  const beforeDecision = await evaluateBeforeHook(policy.before, context, target)
  if (beforeDecision) {
    return beforeDecision
  }

  const handler = policy.record?.[action]
  if (!handler) {
    throw new AuthorizationErrorClass(
      `[@holo-js/authorization] Policy action "${action}" is not defined for the selected target.`,
      deny(),
    )
  }

  return await normalizeResult(handler(context, target))
}

async function evaluatePolicyByName(
  actor: object | null,
  policyName: string,
  action: string,
  target: AuthorizationPolicyTarget | object,
  guard?: string,
): Promise<AuthorizationDecision> {
  const policy = getPolicyByName(policyName)
  const context = typeof guard === 'string'
    ? resolveContext(actor, guard)
    : resolveContext(actor)
  if (typeof target === 'function' || isAuthorizationTargetModel(target)) {
    const beforeDecision = await evaluateBeforeHook(policy.before, context, target)
    if (beforeDecision) {
      return beforeDecision
    }

    const handler = policy.class?.[action]
    if (!handler) {
      throw new AuthorizationErrorClass(
        `[@holo-js/authorization] Policy action "${action}" is not defined for policy "${policyName}".`,
        deny(),
      )
    }

    return await normalizeResult(handler(context, target))
  }

  const beforeDecision = await evaluateBeforeHook(policy.before, context, target)
  if (beforeDecision) {
    return beforeDecision
  }

  const handler = policy.record?.[action]
  if (!handler) {
    throw new AuthorizationErrorClass(
      `[@holo-js/authorization] Policy action "${action}" is not defined for policy "${policyName}".`,
      deny(),
    )
  }

  return await normalizeResult(handler(context, target))
}

async function evaluateAbility<TInput extends object>(
  actor: object | null,
  abilityName: string,
  input: TInput,
  guard?: string,
): Promise<AuthorizationDecision> {
  const ability = getAbilityByName(abilityName)
  const context = typeof guard === 'string'
    ? resolveContext(actor, guard)
    : resolveContext(actor)
  return await normalizeResult(ability.handle(context, input))
}

function createPolicyBuilder<TPolicyName extends HoloPolicyName>(
  resolveActor: () => Promise<object | null> | object | null,
  policyName: TPolicyName,
  guard?: string,
): AuthorizationPolicyBuilder<TPolicyName> {
  return Object.freeze({
    async authorize<TTarget>(action: PolicyActionForPolicy<TPolicyName, TTarget>, target: TTarget): Promise<void> {
      const actor = await resolveActor()
      const decision = await evaluatePolicyByName(actor, String(policyName), String(action), target as AuthorizationPolicyTarget | object, guard)
      if (!decision.allowed) {
        throw createAuthorizationError(decision)
      }
    },
    async can<TTarget>(action: PolicyActionForPolicy<TPolicyName, TTarget>, target: TTarget): Promise<boolean> {
      const actor = await resolveActor()
      const decision = await evaluatePolicyByName(actor, String(policyName), String(action), target as AuthorizationPolicyTarget | object, guard)
      return decision.allowed
    },
    async cannot<TTarget>(action: PolicyActionForPolicy<TPolicyName, TTarget>, target: TTarget): Promise<boolean> {
      const actor = await resolveActor()
      const decision = await evaluatePolicyByName(actor, String(policyName), String(action), target as AuthorizationPolicyTarget | object, guard)
      return !decision.allowed
    },
    async inspect<TTarget>(action: PolicyActionForPolicy<TPolicyName, TTarget>, target: TTarget): Promise<AuthorizationDecision> {
      const actor = await resolveActor()
      return await evaluatePolicyByName(actor, String(policyName), String(action), target as AuthorizationPolicyTarget | object, guard)
    },
  }) as unknown as AuthorizationPolicyBuilder<TPolicyName>
}

function createAbilityBuilder<TAbilityName extends HoloAbilityName>(
  resolveActor: () => Promise<object | null> | object | null,
  abilityName: TAbilityName,
  guard?: string,
): AuthorizationAbilityBuilder<TAbilityName> {
  return Object.freeze({
    async authorize(input: AbilityInput<TAbilityName>): Promise<void> {
      const actor = await resolveActor()
      const decision = await evaluateAbility(actor, String(abilityName), input, guard)
      if (!decision.allowed) {
        throw createAuthorizationError(decision)
      }
    },
    async can(input: AbilityInput<TAbilityName>): Promise<boolean> {
      const actor = await resolveActor()
      const decision = await evaluateAbility(actor, String(abilityName), input, guard)
      return decision.allowed
    },
    async cannot(input: AbilityInput<TAbilityName>): Promise<boolean> {
      const actor = await resolveActor()
      const decision = await evaluateAbility(actor, String(abilityName), input, guard)
      return !decision.allowed
    },
    async inspect(input: AbilityInput<TAbilityName>): Promise<AuthorizationDecision> {
      const actor = await resolveActor()
      return await evaluateAbility(actor, String(abilityName), input, guard)
    },
  })
}

function createActorAuthorization(
  resolveActor: () => Promise<object | null> | object | null,
  guard?: string,
): AuthorizationActorBuilder {
  return Object.freeze({
    async authorize<TTarget extends AuthorizationPolicyTarget | object>(action: PolicyActionFor<TTarget>, target: TTarget): Promise<void> {
      const actor = await resolveActor()
      const decision = await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object, guard)
      if (!decision.allowed) {
        throw createAuthorizationError(decision)
      }
    },
    async can<TTarget extends AuthorizationPolicyTarget | object>(action: PolicyActionFor<TTarget>, target: TTarget): Promise<boolean> {
      const actor = await resolveActor()
      const decision = await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object, guard)
      return decision.allowed
    },
    async cannot<TTarget extends AuthorizationPolicyTarget | object>(action: PolicyActionFor<TTarget>, target: TTarget): Promise<boolean> {
      const actor = await resolveActor()
      const decision = await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object, guard)
      return !decision.allowed
    },
    async inspect<TTarget extends AuthorizationPolicyTarget | object>(action: PolicyActionFor<TTarget>, target: TTarget): Promise<AuthorizationDecision> {
      const actor = await resolveActor()
      return await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object, guard)
    },
    policy<TPolicyName extends HoloPolicyName>(name: TPolicyName) {
      return createPolicyBuilder(resolveActor, name, guard)
    },
    ability<TAbilityName extends HoloAbilityName>(name: TAbilityName) {
      return createAbilityBuilder(resolveActor, name, guard)
    },
  }) as AuthorizationActorBuilder
}

export function forUser<TActor extends object>(actor: TActor | null): AuthorizationActorBuilder {
  return createActorAuthorization(() => Promise.resolve(actor))
}

function getResolvedAuthActorContext(): {
  readonly resolveActor: () => Promise<object | null>
  readonly guard: string | undefined
} {
  const integration = getAuthorizationAuthIntegration()
  return {
    resolveActor: () => Promise.resolve(integration.resolveDefaultActor()),
    guard: undefined,
  }
}

function getResolvedAuthGuardActorContext(name: string): {
  readonly resolveActor: () => Promise<object | null>
  readonly guard: string
} {
  const integration = getAuthorizationAuthIntegration()
  if (!integration.hasGuard(name)) {
    throw new AuthorizationGuardNotFoundError(`[@holo-js/authorization] Guard "${name}" was not found.`)
  }

  return {
    resolveActor: () => Promise.resolve(integration.resolveGuardActor(name)),
    guard: name,
  }
}

export async function authorize<TTarget extends AuthorizationPolicyTarget | object>(
  action: PolicyActionFor<TTarget>,
  target: TTarget,
): Promise<void> {
  const { resolveActor } = getResolvedAuthActorContext()
  const actor = await resolveActor()
  const decision = await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object)
  if (!decision.allowed) {
    throw createAuthorizationError(decision)
  }
}

export async function can<TTarget extends AuthorizationPolicyTarget | object>(
  action: PolicyActionFor<TTarget>,
  target: TTarget,
): Promise<boolean> {
  const { resolveActor } = getResolvedAuthActorContext()
  const actor = await resolveActor()
  const decision = await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object)
  return decision.allowed
}

export async function cannot<TTarget extends AuthorizationPolicyTarget | object>(
  action: PolicyActionFor<TTarget>,
  target: TTarget,
): Promise<boolean> {
  const { resolveActor } = getResolvedAuthActorContext()
  const actor = await resolveActor()
  const decision = await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object)
  return !decision.allowed
}

export async function inspect<TTarget extends AuthorizationPolicyTarget | object>(
  action: PolicyActionFor<TTarget>,
  target: TTarget,
): Promise<AuthorizationDecision> {
  const { resolveActor } = getResolvedAuthActorContext()
  const actor = await resolveActor()
  return await evaluatePolicyByTarget(actor, String(action), target as AuthorizationPolicyTarget | object)
}

export function guard<TGuardName extends HoloAuthorizationGuardName>(name: TGuardName): AuthorizationActorBuilder {
  const { resolveActor, guard: resolvedGuard } = getResolvedAuthGuardActorContext(String(name))
  return createActorAuthorization(resolveActor, resolvedGuard)
}

export const authorizationInternals = Object.freeze({
  getAuthorizationRuntimeState,
  resetAuthorizationRuntimeState,
  configureAuthorizationAuthIntegration,
  resetAuthorizationAuthIntegration,
  getAuthorizationAuthIntegration,
  getPolicyByName,
  getAbilityByName,
  getPolicyByTarget,
  evaluatePolicyByTarget,
  evaluatePolicyByName,
  evaluateAbility,
  registerPolicyDefinition,
  registerAbilityDefinition,
  unregisterPolicyDefinition,
  unregisterAbilityDefinition,
})

export {
  allow,
  deny,
  denyAsNotFound,
  AuthorizationAbilityNotFoundError,
  AuthorizationAuthIntegrationMissingError,
  AuthorizationErrorClass as AuthorizationError,
  PolicyNotFoundError as AuthorizationPolicyNotFoundError,
}
