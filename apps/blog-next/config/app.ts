import { defineAppConfig, env } from '@holo-js/config'

export default defineAppConfig({
  name: env('APP_NAME', 'blog-next'),
  key: env('APP_KEY'),
  url: env('APP_URL', 'http://localhost:3000'),
  env: env('APP_ENV', 'production'),
  debug: env('APP_DEBUG', false),
  paths: {
    models: 'server/models',
    migrations: 'server/db/migrations',
    seeders: 'server/db/seeders',
    commands: 'server/commands',
    jobs: 'server/jobs',
    events: 'server/events',
    listeners: 'server/listeners',
    generatedSchema: '.holo-js/generated/schema.generated.ts',
  },
})
