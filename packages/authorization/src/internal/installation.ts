import type { AuthorizationAbilityDefinition, AuthorizationPolicyDefinition, AuthorizationPolicyTarget } from '../contracts'

export type RegisteredPolicy = AuthorizationPolicyDefinition<string, AuthorizationPolicyTarget, string, string, object>
export type RegisteredAbility = AuthorizationAbilityDefinition<string, object, object>

export type AuthorizationInstallationContext = {
  active: boolean
  disposed: boolean
  readonly policies: Map<string, RegisteredPolicy>
  readonly abilities: Map<string, RegisteredAbility>
  readonly displacedPolicies: Map<string, RegisteredPolicy>
  readonly displacedAbilities: Map<string, RegisteredAbility>
}

export type DefinitionLifetime<TDefinition> = {
  readonly installation: AuthorizationInstallationContext
  readonly previous?: TDefinition
}

export function resolveLiveDefinition<TDefinition extends object>(definition: TDefinition, lifetimes: WeakMap<TDefinition, DefinitionLifetime<TDefinition>>): TDefinition | undefined {
  let current: TDefinition | undefined = definition
  while (current !== undefined) {
    const lifetime = lifetimes.get(current)
    if (!lifetime?.installation.disposed) return current
    current = lifetime.previous
  }
  return undefined
}

type InstallationStorage = {
  getStore(): AuthorizationInstallationContext | undefined
  run<TValue>(context: AuthorizationInstallationContext, callback: () => TValue): TValue
}

type AsyncLocalStorageConstructor = new <TStore>() => {
  getStore(): TStore | undefined
  run<TValue>(store: TStore, callback: () => TValue): TValue
}

type AuthorizationInstallationGlobals = {
  readonly AsyncLocalStorage?: AsyncLocalStorageConstructor
  readonly process?: {
    getBuiltinModule?(name: 'node:async_hooks'): { readonly AsyncLocalStorage: AsyncLocalStorageConstructor }
  }
  __holoAuthorizationInstallationStore__?: InstallationStorage
}

const installationGlobals = globalThis as AuthorizationInstallationGlobals

export function getAuthorizationInstallation(): AuthorizationInstallationContext | undefined {
  const context = installationGlobals.__holoAuthorizationInstallationStore__?.getStore()
  return context?.active ? context : undefined
}

export function runAuthorizationInstallation<TValue>(context: AuthorizationInstallationContext, callback: () => TValue): TValue {
  if (!installationGlobals.__holoAuthorizationInstallationStore__) {
    const NativeStorage = installationGlobals.AsyncLocalStorage
      ?? installationGlobals.process?.getBuiltinModule?.('node:async_hooks').AsyncLocalStorage
    if (!NativeStorage) throw new Error('Authorization definition installation requires native AsyncLocalStorage.')
    installationGlobals.__holoAuthorizationInstallationStore__ = new NativeStorage<AuthorizationInstallationContext>()
  }
  return installationGlobals.__holoAuthorizationInstallationStore__.run(context, callback)
}
