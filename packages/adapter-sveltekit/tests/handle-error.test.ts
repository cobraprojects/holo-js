import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { RequestEvent } from '@sveltejs/kit'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorReportingInternals } from '@holo-js/kernel/error-reporting'
import { createSvelteKitHoloHooks, initializeSvelteKitHoloProject, resetSvelteKitHoloProject } from '../src'

const configEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const databaseEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/databaseConfig.ts'))
const tempDirs: string[] = []

async function createProject(debug?: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-sveltekit-errors-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${configEntry}

export default defineAppConfig({
  name: 'SvelteKit App',
  env: 'development',${debug === undefined ? '' : `\n  debug: ${debug},`}
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databaseEntry}

export default defineDatabaseConfig({
  defaultConnection: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: ':memory:',
    },
  },
})
`, 'utf8')
  return root
}

function createEvent(): RequestEvent {
  return {
    url: new URL('https://app.test/posts'),
    request: new Request('https://app.test/posts', { method: 'GET' }),
  } as RequestEvent
}

const internalFailure = new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2')

afterEach(async () => {
  vi.restoreAllMocks()
  errorReportingInternals.configure(undefined)
  await resetSvelteKitHoloProject()
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function handleUnexpectedError() {
  const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })
  return hooks.handleError({
    event: createEvent(),
    error: internalFailure,
    status: 500,
    message: 'Internal Error',
  })
}

describe('SvelteKit unhandled errors', () => {
  it('logs the error and returns SvelteKit\'s generic message without an application hook', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handleUnexpectedError()

    expect(response).toEqual({ message: 'Internal Error' })
    expect(JSON.stringify(response)).not.toContain('hunter2')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('sveltekit'), internalFailure)
  })

  it('sends unexpected errors to the configured reporter instead of the console', async () => {
    const reported = vi.fn()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    errorReportingInternals.configure({ report: reported })

    await handleUnexpectedError()

    expect(reported).toHaveBeenCalledWith(internalFailure, { capability: 'sveltekit', operation: 'handleError' })
    expect(logged).not.toHaveBeenCalled()
  })

  it('does not log client errors such as unmatched routes', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const hooks = createSvelteKitHoloHooks({ handle: ({ event, resolve }) => resolve(event) })

    const response = await hooks.handleError({
      event: createEvent(),
      error: new Error('Not found: /wp-admin'),
      status: 404,
      message: 'Not Found',
    })

    expect(response).toEqual({ message: 'Not Found' })
    expect(logged).not.toHaveBeenCalled()
  })

  it('returns SvelteKit\'s generic message for a project that never sets debug', async () => {
    const root = await createProject()
    await initializeSvelteKitHoloProject({ projectRoot: root, processEnv: { ...process.env } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handleUnexpectedError()

    expect(response).toEqual({ message: 'Internal Error' })
    expect(JSON.stringify(response)).not.toContain('hunter2')
  })

  it('returns the error message when the app enables debug', async () => {
    const root = await createProject(true)
    await initializeSvelteKitHoloProject({ projectRoot: root, processEnv: { ...process.env } })
    vi.spyOn(console, 'error').mockImplementation(() => {})

    expect(await handleUnexpectedError()).toEqual({ message: internalFailure.message })
  })

  it('returns SvelteKit\'s generic message when the app disables debug', async () => {
    const root = await createProject(false)
    await initializeSvelteKitHoloProject({ projectRoot: root, processEnv: { ...process.env } })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})

    const response = await handleUnexpectedError()

    expect(response).toEqual({ message: 'Internal Error' })
    expect(JSON.stringify(response)).not.toContain('hunter2')
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('sveltekit'), internalFailure)
  })
})
