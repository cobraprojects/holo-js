import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadProjectConfig } from '../src/project'

const tempDirs: string[] = []

async function createTempProject(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-cli-project-config-'))
  await mkdir(join(projectRoot, 'config'), { recursive: true })
  tempDirs.push(projectRoot)

  return projectRoot
}

async function writeProjectFile(projectRoot: string, path: string, contents: string): Promise<void> {
  const filePath = join(projectRoot, path)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, contents, 'utf8')
}

afterEach(async () => {
  const runtime = globalThis as typeof globalThis & { __holoCliConfigLoadCount?: number }
  delete runtime.__holoCliConfigLoadCount

  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('project config imports', () => {
  it('loads TypeScript app and database configs through the project module bundler', async () => {
    const projectRoot = await createTempProject()
    await writeProjectFile(projectRoot, 'config/app.ts', `
type AppPaths = {
  readonly commands: string
}

const paths = {
  commands: process.env.COMMANDS_PATH ?? 'server/commands-ts',
} satisfies AppPaths

export default {
  paths,
  models: ['server/models/User.ts'],
  migrations: ['server/db/migrations/2026_01_01_000001_create_users.ts'],
  seeders: ['server/db/seeders/UserSeeder.ts'],
}
`)
    await writeProjectFile(projectRoot, 'config/database.ts', `
type SqliteConnection = {
  readonly driver: 'sqlite'
  readonly url: string
}

const connections = {
  default: {
    driver: 'sqlite',
    url: process.env.DATABASE_URL ?? './local.sqlite',
  },
} satisfies { readonly default: SqliteConnection }

export const config = {
  defaultConnection: 'default',
  connections,
}
`)

    const previousCommandsPath = process.env.COMMANDS_PATH
    const previousDatabaseUrl = process.env.DATABASE_URL

    try {
      process.env.COMMANDS_PATH = 'server/custom-commands'
      process.env.DATABASE_URL = './custom.sqlite'

      await expect(loadProjectConfig(projectRoot, { required: true }))
        .resolves.toMatchObject({
          config: {
            paths: {
              commands: 'server/custom-commands',
            },
            models: ['server/models/User.ts'],
            migrations: ['server/db/migrations/2026_01_01_000001_create_users.ts'],
            seeders: ['server/db/seeders/UserSeeder.ts'],
            database: {
              defaultConnection: 'default',
              connections: {
                default: {
                  driver: 'sqlite',
                  url: './custom.sqlite',
                },
              },
            },
          },
        })
    } finally {
      if (typeof previousCommandsPath === 'string') {
        process.env.COMMANDS_PATH = previousCommandsPath
      } else {
        Reflect.deleteProperty(process.env, 'COMMANDS_PATH')
      }

      if (typeof previousDatabaseUrl === 'string') {
        process.env.DATABASE_URL = previousDatabaseUrl
      } else {
        Reflect.deleteProperty(process.env, 'DATABASE_URL')
      }
    }
  })

  it('reuses imports until the file contents or env values change', async () => {
    const projectRoot = await createTempProject()
    await writeProjectFile(projectRoot, 'config/app.mjs', `
const runtime = globalThis
runtime.__holoCliConfigLoadCount = (runtime.__holoCliConfigLoadCount ?? 0) + 1

export default {
  paths: {
    commands: process.env.COMMANDS_PATH ?? 'server/commands',
  },
}
`)

    const runtime = globalThis as typeof globalThis & { __holoCliConfigLoadCount?: number }
    const previousCommandsPath = process.env.COMMANDS_PATH

    try {
      process.env.COMMANDS_PATH = 'first/commands'
      await expect(loadProjectConfig(projectRoot, { required: true }))
        .resolves.toMatchObject({ config: { paths: { commands: 'first/commands' } } })
      await expect(loadProjectConfig(projectRoot, { required: true }))
        .resolves.toMatchObject({ config: { paths: { commands: 'first/commands' } } })
      expect(runtime.__holoCliConfigLoadCount).toBe(1)

      process.env.COMMANDS_PATH = 'second/commands'
      await expect(loadProjectConfig(projectRoot, { required: true }))
        .resolves.toMatchObject({ config: { paths: { commands: 'second/commands' } } })
      expect(runtime.__holoCliConfigLoadCount).toBe(2)
    } finally {
      if (typeof previousCommandsPath === 'string') {
        process.env.COMMANDS_PATH = previousCommandsPath
      } else {
        Reflect.deleteProperty(process.env, 'COMMANDS_PATH')
      }
    }
  })
})
