import { defineWorkspace } from 'vitest/config'

export default defineWorkspace([
  'packages/adapter-next',
  'packages/adapter-nuxt',
  'packages/adapter-sveltekit',
  'packages/config',
  'packages/db',
  'packages/events',
  'packages/forms',
  'packages/cli',
  'packages/core',
  'packages/media',
  'packages/queue',
  'packages/queue-db',
  'packages/storage',
  'packages/validation',
])
