import { DB, TableQueryBuilder, type DatabaseContext, type TableDefinition } from '@holo-js/db'
import { validate } from '@holo-js/validation'
import {
  RealtimeAuthUnavailableError,
  RealtimeError,
  RealtimeForbiddenError,
  RealtimeUnauthorizedError,
} from './errors'
import type {
  RealtimeAccess,
  RealtimeAccessObject,
  RealtimeArgsFor,
  RealtimeAuthModule,
  RealtimeAuthState,
  RealtimeDatabaseContext,
  RealtimeExecutionOptions,
  RealtimeMutationDefinitionMetadata,
  RealtimeQueryDefinitionMetadata,
  RealtimeRuntimeBindings,
} from '../contracts'

export function createRealtimeDatabaseContext(connection: DatabaseContext): RealtimeDatabaseContext {
  const context = {
    connection,
    table<TTableOrName extends string | TableDefinition>(table: TTableOrName) {
      return new TableQueryBuilder(table, connection)
    },
    model(...parameters: Parameters<DatabaseContext['model']>) {
      return connection.model(...parameters)
    },
  } satisfies RealtimeDatabaseContext

  return Object.freeze(context)
}

export function getDatabaseContext(bindings: RealtimeRuntimeBindings | undefined): RealtimeDatabaseContext {
  return createRealtimeDatabaseContext(bindings?.db?.() ?? DB.connection())
}

export async function runWithExecutionOptions<TResult>(
  bindings: RealtimeRuntimeBindings | undefined,
  options: RealtimeExecutionOptions | undefined,
  callback: () => Promise<TResult>,
): Promise<TResult> {
  if (options?.authRequest) {
    const runner = bindings?.runWithAuthRequestAccessors
    if (runner) {
      return await runner(options.authRequest, callback)
    }
  }

  return await callback()
}

async function defaultLoadAuthModule(): Promise<RealtimeAuthModule | null> {
  try {
    return await import('@holo-js/auth') as RealtimeAuthModule
  /* v8 ignore start -- optional peer dependency absence depends on package installation state */
  } catch (error) {
    if (
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { readonly code?: unknown }).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return null
    }

    throw error
  }
  /* v8 ignore stop */
}

async function loadAuthModule(bindings: RealtimeRuntimeBindings | undefined): Promise<RealtimeAuthModule | null> {
  const load = bindings?.loadAuthModule ?? defaultLoadAuthModule
  return await load()
}

function normalizeAccess<TArgs>(access: RealtimeAccess<TArgs>): RealtimeAccessObject<TArgs> {
  if (access === 'public' || access === 'authenticated') {
    return Object.freeze({
      require: access,
    })
  }

  if (access.guards && access.guard) {
    throw new RealtimeError('Realtime access cannot define both guard and guards.')
  }

  if (access.guards && access.guards.length === 0) {
    throw new RealtimeError('Realtime access guards must not be empty.')
  }

  return access
}

async function resolveGuardAuth(
  authModule: RealtimeAuthModule,
  guardName: string | undefined,
): Promise<RealtimeAuthState | null> {
  const runtime = authModule.getAuthRuntime()
  const guard = guardName ? runtime.guard(guardName) : runtime
  const user = await guard.user()
  if (!user) {
    return null
  }

  return Object.freeze({
    user,
    guard: guardName ?? 'default',
    provider: await guard.provider(),
  })
}

async function resolveAuthForAccess<TArgs>(
  bindings: RealtimeRuntimeBindings | undefined,
  access: RealtimeAccessObject<TArgs>,
): Promise<RealtimeAuthState | null> {
  let authModule: RealtimeAuthModule | null = null
  try {
    authModule = await loadAuthModule(bindings)
  } catch (error) {
    if (access.require === 'authenticated') {
      throw new RealtimeAuthUnavailableError('Realtime authenticated access requires @holo-js/auth to be installed and configured.', {
        cause: error,
      })
    }

    return null
  }

  if (!authModule) {
    if (access.require === 'authenticated') {
      throw new RealtimeAuthUnavailableError()
    }

    return null
  }

  const guardNames = access.guards ?? (access.guard ? [access.guard] : [undefined])
  try {
    for (const guardName of guardNames) {
      const auth = await resolveGuardAuth(authModule, guardName)
      if (auth) {
        return auth
      }
    }
  } catch (error) {
    if (access.require === 'authenticated') {
      throw new RealtimeAuthUnavailableError('Realtime authenticated access requires @holo-js/auth to be installed and configured.', {
        cause: error,
      })
    }

    return null
  }

  if (access.require === 'authenticated') {
    throw new RealtimeUnauthorizedError()
  }

  return null
}

export async function authorize<TArgs>(
  bindings: RealtimeRuntimeBindings | undefined,
  accessInput: RealtimeAccess<TArgs>,
  args: TArgs,
  db: RealtimeDatabaseContext,
): Promise<RealtimeAuthState | null> {
  const access = normalizeAccess(accessInput)
  const auth = await resolveAuthForAccess(bindings, access)

  if (access.authorize) {
    const allowed = await access.authorize({
      args,
      auth,
      db,
    })
    if (!allowed) {
      throw new RealtimeForbiddenError()
    }
  }

  return auth
}

export async function resolveArgs<TDefinition extends (RealtimeQueryDefinitionMetadata | RealtimeMutationDefinitionMetadata) & {
  readonly args?: Parameters<typeof validate>[1]
}>(
  definition: TDefinition,
  input: RealtimeArgsFor<TDefinition>,
): Promise<RealtimeArgsFor<TDefinition>> {
  if (!definition.args) {
    return Object.freeze({}) as RealtimeArgsFor<TDefinition>
  }

  return await validate(input as Record<string, unknown>, definition.args) as RealtimeArgsFor<TDefinition>
}
