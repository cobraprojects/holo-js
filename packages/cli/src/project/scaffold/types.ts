import type { loadConfigDirectory } from '@holo-js/config'
import type { SupportedAuthSocialProvider } from '../shared'

export type ScaffoldedFile = {
  readonly path: string
  readonly contents: string
}

export type AuthInstallFeatures = {
  readonly social?: boolean
  readonly socialProviders?: readonly SupportedAuthSocialProvider[]
  readonly workos?: boolean
  readonly clerk?: boolean
}

export type LoadedConfigWithCache = Awaited<ReturnType<typeof loadConfigDirectory>> & {
  readonly cache: {
    readonly drivers: Readonly<Record<string, {
      readonly driver: string
    }>>
  }
  readonly redis: {
    readonly default: string
  }
}

export type ConfigModuleFormat = 'esm' | 'cjs'

export const AUTH_MIGRATION_SLUGS = [
  'create_users',
  'create_sessions',
  'create_auth_identities',
  'create_personal_access_tokens',
  'create_password_reset_tokens',
  'create_email_verification_tokens',
] as const

export type AuthMigrationSlug = typeof AUTH_MIGRATION_SLUGS[number]
