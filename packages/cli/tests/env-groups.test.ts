import { describe, expect, it } from 'vitest'
import {
  renderAuthEnvFiles,
  renderCacheEnvFiles,
  renderQueueEnvFiles,
  renderScaffoldEnvFiles,
  upsertEnvContents,
} from '../src/project/scaffold/project-renderers'

describe('env file groups', () => {
  it('separates scaffolded groups while keeping database settings together', () => {
    const files = renderScaffoldEnvFiles({
      projectName: 'Fixture', databaseDriver: 'sqlite', storageDefaultDisk: 'local',
      optionalPackages: ['auth', 'queue', 'cache', 'mail', 'storage'],
    })
    for (const contents of [files.env, files.example]) {
      const groups = contents.trim().split('\n\n')
      expect(groups.map(group => group.split('\n').filter(line => !line.startsWith('#')).map(line => line.split('=')[0]))).toEqual([
        ['APP_NAME', 'APP_KEY', 'APP_URL', 'APP_ENV', 'APP_DEBUG'],
        ['DB_CONNECTION', 'DB_DRIVER', 'DB_URL'],
        ['REDIS_CONNECTION'],
        ['STORAGE_DEFAULT_DISK', 'STORAGE_ROUTE_PREFIX'],
        ['AUTH_GUARD', 'AUTH_PASSWORD_BROKER', 'AUTH_EMAIL_VERIFICATION_ROUTE', 'AUTH_PASSWORD_RESET_ROUTE'],
        ['RATE_LIMIT_DRIVER'],
        ['FRONTEND_URL', 'FRONTEND_DOMAIN'],
        ['SESSION_DRIVER', 'SESSION_CONNECTION', 'SESSION_COOKIE', 'SESSION_PATH', 'SESSION_DOMAIN', 'SESSION_SECURE', 'SESSION_SAME_SITE', 'SESSION_IDLE_TIMEOUT', 'SESSION_LIFETIME', 'SESSION_REMEMBER_ME_LIFETIME'],
        ['QUEUE_CONNECTION'],
        ['CACHE_DRIVER', 'CACHE_PREFIX'],
        ['MAIL_MAILER', 'MAIL_FROM_ADDRESS', 'MAIL_FROM_NAME', 'MAIL_LOG_BODIES', 'MAIL_HOST', 'MAIL_PORT', 'MAIL_SECURE', 'MAIL_USERNAME', 'MAIL_PASSWORD'],
      ])
      expect(contents).not.toContain('\n=\n')
    }
  })

  it.each([renderQueueEnvFiles('redis'), renderCacheEnvFiles('redis')])('separates Redis settings when installing a package', (files) => {
    for (const additions of [files.env, files.example]) {
      const result = upsertEnvContents('APP_NAME=Existing\n', additions)
      expect(result.contents).toMatch(/^APP_NAME=Existing\n\n(?:QUEUE|CACHE)_/)
      expect(result.contents).toContain('\n\nREDIS_CONNECTION=')
      expect(upsertEnvContents(result.contents, additions)).toEqual({ contents: result.contents, changed: false })
    }
  })

  it('preserves provider group separators in auth env files and examples', () => {
    const files = renderAuthEnvFiles({ socialProviders: ['google', 'github'], workos: true, clerk: true })
    for (const additions of [files.env, files.example]) {
      const result = upsertEnvContents(undefined, additions)
      for (const key of ['RATE_LIMIT_DRIVER', 'FRONTEND_URL', 'SESSION_DRIVER', 'AUTH_GOOGLE_CLIENT_ID', 'AUTH_GITHUB_CLIENT_ID', 'AUTH_WORKOS_PROVIDER', 'CLERK_PUBLISHABLE_KEY']) {
        expect(result.contents).toContain(`\n\n${key}=`)
      }
      expect(result.contents).not.toContain('\n=\n')
    }
  })

  it('skips existing groups without losing separators between missing groups', () => {
    const existing = '# Keep this comment\r\nREDIS_CONNECTION=shared\r\nREDIS_HOST=remote\r\n'
    const additions = ['', 'QUEUE_CONNECTION=redis', '', 'REDIS_CONNECTION=default', 'REDIS_HOST=localhost', '', 'CACHE_DRIVER=redis', 'CACHE_DRIVER=file', '']
    const result = upsertEnvContents(existing, additions)
    expect(result.contents).toBe('# Keep this comment\nREDIS_CONNECTION=shared\nREDIS_HOST=remote\n\nQUEUE_CONNECTION=redis\n\nCACHE_DRIVER=redis\n')
    expect(upsertEnvContents(result.contents, additions).changed).toBe(false)
    expect(upsertEnvContents(existing, ['', 'REDIS_CONNECTION=default', ''])).toEqual({ contents: existing, changed: false })
  })
})
