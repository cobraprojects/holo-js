import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { errorReportingInternals } from '@holo-js/kernel/error-reporting'
import { defineJob, dispatchSync, registerQueueJob, resetQueueRegistry } from '@holo-js/queue'
import { createHolo, initializeHolo, report, resetHoloRuntime } from '../src'

type ReportedError = {
  readonly error: unknown
  readonly context: { readonly capability: string, readonly operation: string }
}

type ErrorReportingGlobals = typeof globalThis & {
  __holoTestReports__?: ReportedError[]
  __holoTestIgnoredError__?: new (message: string) => Error
}

const appConfigEntry = JSON.stringify(resolve(import.meta.dirname, '../../config/src/index.ts'))
const databaseConfigEntry = JSON.stringify(resolve(import.meta.dirname, '../../db/src/databaseConfig.ts'))
const host = globalThis as ErrorReportingGlobals
const tempDirs: string[] = []

class IgnoredError extends Error {}

async function createProject(exceptionsSource?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-core-error-reporting-'))
  tempDirs.push(root)
  await mkdir(join(root, 'config'), { recursive: true })
  await writeFile(join(root, 'config/app.ts'), `
import { defineAppConfig } from ${appConfigEntry}

export default defineAppConfig({
  name: 'Reporting App',
  ${exceptionsSource ? `exceptions: ${exceptionsSource},` : ''}
})
`, 'utf8')
  await writeFile(join(root, 'config/database.ts'), `
import { defineDatabaseConfig } from ${databaseConfigEntry}

export default defineDatabaseConfig({
  connections: { main: { driver: 'sqlite', url: ':memory:' } },
})
`, 'utf8')
  return root
}

async function initializeProject(exceptionsSource?: string): Promise<void> {
  const runtime = await createHolo(await createProject(exceptionsSource), { processEnv: {} })
  await runtime.initialize()
}

const collectingReporter = `{
  report(error, context) {
    globalThis.__holoTestReports__.push({ error, context })
  },
  dontReport: [globalThis.__holoTestIgnoredError__],
}`

afterEach(async () => {
  await resetHoloRuntime()
  resetQueueRegistry()
  vi.restoreAllMocks()
  delete host.__holoTestReports__
  delete host.__holoTestIgnoredError__
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

function prepareCollectingReporter(): ReportedError[] {
  const reports: ReportedError[] = []
  host.__holoTestReports__ = reports
  host.__holoTestIgnoredError__ = IgnoredError
  return reports
}

describe('application error reporting', () => {
  it('sends report() calls to the configured application reporter', async () => {
    const reports = prepareCollectingReporter()
    await initializeProject(collectingReporter)
    const error = new Error('payment gateway timed out')

    report(error)

    expect(reports).toEqual([{ error, context: { capability: 'app', operation: 'report' } }])
  })

  it('skips errors whose class is listed in dontReport', async () => {
    const reports = prepareCollectingReporter()
    await initializeProject(collectingReporter)

    report(new IgnoredError('expected'))

    expect(reports).toEqual([])
  })

  it('reports framework-swallowed capability errors with their capability and operation', async () => {
    const reports = prepareCollectingReporter()
    await initializeProject(collectingReporter)
    const hookError = new Error('analytics unavailable')
    registerQueueJob(defineJob({
      handle: () => 'done',
      onCompleted() {
        throw hookError
      },
    }), { name: 'reports.completed' })

    await expect(dispatchSync('reports.completed', {})).resolves.toBe('done')

    expect(reports).toEqual([{ error: hookError, context: { capability: 'queue', operation: 'job.onCompleted' } }])
  })

  it('keeps the caller running and logs both errors when the reporter throws or rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await initializeProject(`{
      report(error) {
        if (error.message === 'sync') throw new Error('reporter crashed')
        return Promise.reject(new Error('reporter rejected'))
      },
    }`)
    const syncError = new Error('sync')
    const asyncError = new Error('async')

    expect(() => report(syncError)).not.toThrow()
    report(asyncError)
    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(2))

    expect(consoleError.mock.calls).toEqual([
      ['[holo:app] report', syncError, expect.objectContaining({ message: 'reporter crashed' })],
      ['[holo:app] report', asyncError, expect.objectContaining({ message: 'reporter rejected' })],
    ])
  })

  it('keeps the caller running when dontReport contains an entry that is not an error class', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await initializeProject(`{
      report() {},
      dontReport: [undefined],
    }`)
    const error = new Error('still reported safely')

    expect(() => report(error)).not.toThrow()

    expect(consoleError).toHaveBeenCalledWith('[holo:app] report', error, expect.any(TypeError))
  })

  it('lets only one of two concurrently initializing runtimes own the process reporter', async () => {
    const outerReport = vi.fn()
    errorReportingInternals.configure({ report: outerReport })
    onTestFinished(() => { errorReportingInternals.configure(undefined) })
    const reports = prepareCollectingReporter()
    const first = await createHolo(await createProject(collectingReporter), { processEnv: {} })
    const second = await createHolo(await createProject(collectingReporter), { processEnv: {} })

    const results = await Promise.allSettled([first.initialize(), second.initialize()])

    expect(results[0]?.status).toBe('fulfilled')
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { message: 'A Holo runtime is already initializing for this process.' } })
    await first.shutdown()
    const error = new Error('after the owning runtime shut down')
    report(error)
    expect(reports).toEqual([])
    expect(outerReport).toHaveBeenCalledExactlyOnceWith(error, { capability: 'app', operation: 'report' })
  })

  it('keeps a shutting-down runtime as process owner until its reporter is restored', async () => {
    const reports = prepareCollectingReporter()
    const first = await createHolo(await createProject(collectingReporter), { processEnv: {} })
    await first.initialize()
    const second = await createHolo(await createProject(`{
      report(error, context) {
        globalThis.__holoTestReports__.push({ error, context: { ...context, capability: 'second' } })
      },
    }`), { processEnv: {} })

    const shutdown = first.shutdown()
    await expect(second.initialize()).rejects.toThrow('A Holo runtime is still shutting down for this process.')
    await shutdown
    await second.initialize()
    const error = new Error('owned by the second runtime')
    report(error)

    expect(reports).toEqual([{ error, context: { capability: 'second', operation: 'report' } }])
  })

  it('waits for a shutting-down runtime before initializeHolo boots the next one', async () => {
    const reports = prepareCollectingReporter()
    const first = await createHolo(await createProject(collectingReporter), { processEnv: {} })
    await first.initialize()
    const secondRoot = await createProject(`{
      report(error, context) {
        globalThis.__holoTestReports__.push({ error, context: { ...context, capability: 'second' } })
      },
    }`)

    const shutdown = first.shutdown()
    await initializeHolo(secondRoot, { processEnv: {} })
    await shutdown
    const error = new Error('owned by the second runtime')
    report(error)

    expect(reports).toEqual([{ error, context: { capability: 'second', operation: 'report' } }])
  })

  it('writes to console.error when the application configures no reporter', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await initializeProject()
    const error = new Error('unhandled')

    report(error)

    expect(consoleError).toHaveBeenCalledWith('[holo:app] report', error)
  })

  it('restores the previously configured reporter after the runtime shuts down', async () => {
    const outerReport = vi.fn()
    errorReportingInternals.configure({ report: outerReport })
    onTestFinished(() => { errorReportingInternals.configure(undefined) })
    prepareCollectingReporter()
    await initializeProject(collectingReporter)
    await resetHoloRuntime()
    const error = new Error('after shutdown')

    report(error)

    expect(outerReport).toHaveBeenCalledExactlyOnceWith(error, { capability: 'app', operation: 'report' })
  })

  it('stops using the application reporter after the runtime shuts down', async () => {
    const reports = prepareCollectingReporter()
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await initializeProject(collectingReporter)
    await resetHoloRuntime()
    const error = new Error('after shutdown')

    report(error)

    expect(reports).toEqual([])
    expect(consoleError).toHaveBeenCalledWith('[holo:app] report', error)
  })
})
