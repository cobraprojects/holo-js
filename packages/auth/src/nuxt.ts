import type { CurrentAuthResponse, HoloAuthUser } from './contracts'
import { computed, useFetch, useState } from '#imports'

export type { HoloAuthUser } from './contracts'

export type UseAuthOptions = {
  readonly endpoint?: string
  readonly guard?: string
  readonly key?: string
}

export type UseAuthResult = {
  readonly authenticated: Readonly<{ readonly value: boolean }>
  readonly provider: { value: string | null }
  readonly user: { value: HoloAuthUser | null }
  readonly refreshUser: () => Promise<HoloAuthUser | null>
}

function createCurrentAuthUrl(endpoint: string, guard: string | undefined): string {
  if (!guard) {
    return endpoint
  }

  const base = endpoint.startsWith('http://') || endpoint.startsWith('https://')
    ? new URL(endpoint)
    : new URL(endpoint, 'https://holo.local')
  base.searchParams.set('guard', guard)

  if (endpoint.startsWith('http://') || endpoint.startsWith('https://')) {
    return base.toString()
  }

  return `${base.pathname}${base.search}${base.hash}`
}

function useCurrentAuthFetch(requestUrl: string, stateKey: string) {
  return useFetch<CurrentAuthResponse>(requestUrl, {
    key: `${stateKey}:request`,
  })
}

export async function useAuth(options: UseAuthOptions = {}): Promise<UseAuthResult> {
  const endpoint = options.endpoint ?? '/api/auth/user'
  const requestUrl = createCurrentAuthUrl(endpoint, options.guard)
  const stateKey = options.key ?? `holo-auth:${requestUrl}`
  const currentAuthenticated = useState<boolean>(`${stateKey}:authenticated`, () => false)
  const currentProvider = useState<string | null>(`${stateKey}:provider`, () => null)
  const currentUser = useState<HoloAuthUser | null>(`${stateKey}:user`, () => null)
  const authenticated = computed(() => currentAuthenticated.value)
  const { data, refresh } = await useCurrentAuthFetch(requestUrl, stateKey)

  currentAuthenticated.value = data.value?.authenticated ?? false
  currentProvider.value = data.value?.provider ?? null
  currentUser.value = data.value?.user ?? null

  return {
    authenticated,
    provider: currentProvider,
    user: currentUser,
    async refreshUser() {
      await refresh()
      currentAuthenticated.value = data.value?.authenticated ?? false
      currentProvider.value = data.value?.provider ?? null
      currentUser.value = data.value?.user ?? null

      return currentUser.value
    },
  }
}
