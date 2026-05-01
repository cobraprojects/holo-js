import { defineAppConfig, env } from '@holo-js/config'

const appEnv = env('APP_ENV') === 'production'
  ? 'production'
  : env('APP_ENV') === 'test'
    ? 'test'
    : 'development'

export default defineAppConfig({
  name: env('APP_NAME', 'blog-nuxt'),
  key: env('APP_KEY'),
  url: env('APP_URL', 'http://localhost:3000'),
  env: appEnv,
  debug: env('APP_DEBUG', true),
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    commands: 'server/commands',
    jobs: 'server/jobs',
    events: 'server/events',
    listeners: 'server/listeners',
    generatedSchema: 'server/db/schema.generated.ts',
  },
})
