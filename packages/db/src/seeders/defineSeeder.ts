import type { SeederDefinition } from './types'

export function defineSeeder<TSeeder extends SeederDefinition>(seeder: TSeeder): TSeeder {
  return Object.freeze({ ...seeder })
}
