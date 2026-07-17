import { describe, expect, it } from 'vitest'
import { DEFAULT_HOLO_PROJECT_PATHS, defineHoloProject, normalizeHoloProjectConfig } from '../src'

describe('project contracts', () => {
  it('normalizes defaults and preserves configured project values', () => {
    expect(normalizeHoloProjectConfig().paths).toEqual(DEFAULT_HOLO_PROJECT_PATHS)
    const config = defineHoloProject({
      paths: { models: 'app/models' },
      database: { defaultConnection: 'primary' },
      models: ['app/models/User.ts'],
      migrations: ['db/migrations/create-users.ts'],
      seeders: ['db/seeders/users.ts'],
    })
    expect(config.paths.models).toBe('app/models')
    expect(config.paths.jobs).toBe(DEFAULT_HOLO_PROJECT_PATHS.jobs)
    expect(config.database?.defaultConnection).toBe('primary')
    expect(config.models).toEqual(['app/models/User.ts'])
    expect(config.migrations).toEqual(['db/migrations/create-users.ts'])
    expect(config.seeders).toEqual(['db/seeders/users.ts'])
  })
})
