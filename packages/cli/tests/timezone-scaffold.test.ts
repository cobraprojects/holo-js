import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfigDirectory, writeConfigCache } from '@holo-js/config'
import { afterEach, describe, expect, it } from 'vitest'
import { renderScaffoldAppConfig, renderScaffoldEnvFiles } from '../src/project/scaffold/project-renderers'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('application timezone scaffold', () => {
  it.each(['next', 'nuxt', 'sveltekit'] as const)(
    'loads the %s timezone default and env override through fresh and cached config',
    async framework => {
      const root = await mkdtemp(join(tmpdir(), 'holo-timezone-scaffold-'))
      tempDirs.push(root)
      await mkdir(join(root, 'config'))
      const appConfig = renderScaffoldAppConfig('timezone-app', framework)
        .replace("'@holo-js/config'", JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts')))
      const envFiles = renderScaffoldEnvFiles({ projectName: 'timezone-app', databaseDriver: 'sqlite', storageDefaultDisk: 'local', framework })
      await writeFile(join(root, 'config/app.ts'), appConfig)
      await writeFile(join(root, '.env'), envFiles.env)

      const defaults = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
      expect(defaults.app.timezone).toBe('UTC')

      await writeFile(join(root, '.env'), envFiles.example.replace('APP_TIMEZONE=', 'APP_TIMEZONE=Africa/Cairo'))
      const fromEnv = await loadConfigDirectory(root, { processEnv: {}, preferCache: false })
      expect(fromEnv.app.timezone).toBe('Africa/Cairo')

      await writeConfigCache(root, { processEnv: {} })
      const cached = await loadConfigDirectory(root, { processEnv: { APP_TIMEZONE: 'Asia/Riyadh' }, preferCache: true })
      expect(cached.app.timezone).toBe('Asia/Riyadh')

      await expect(loadConfigDirectory(root, {
        processEnv: { APP_TIMEZONE: 'Invalid/Timezone' },
        preferCache: true,
      })).rejects.toThrow('Invalid application timezone: Invalid/Timezone')
    },
  )
})
