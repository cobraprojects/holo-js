import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { renderFrameworkRunner } from '../src/project/scaffold/framework-renderers'
import { runRuntimeInvocation } from '../src/runtime'

const frameworks = [
  { framework: 'next', packageName: 'next', command: 'next', buildArgs: ['build'] },
  { framework: 'nuxt', packageName: 'nuxt', command: 'nuxt', buildArgs: ['build'] },
  { framework: 'sveltekit', packageName: 'vite', command: 'vite', buildArgs: ['build', '--logLevel', 'error'] },
] as const

async function createWorkspace(framework: typeof frameworks[number]['framework']) {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'holo-framework-workspace-')))
  onTestFinished(() => rm(workspace, { recursive: true, force: true }))
  const projectRoot = join(workspace, 'apps/example')
  const runnerDir = join(projectRoot, '.holo-js/framework')
  await mkdir(runnerDir, { recursive: true })
  await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ private: true }))
  await writeFile(join(runnerDir, 'project.json'), JSON.stringify({ framework }))
  const runnerPath = join(runnerDir, 'run.mjs')
  await writeFile(runnerPath, renderFrameworkRunner({ framework }))
  return { workspace, projectRoot, runnerPath }
}

async function installBinary(root: string, packageName: string, bin: string | Record<string, string>) {
  const packageRoot = join(root, 'node_modules', packageName)
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ name: packageName, bin, exports: './index.js' }))
  await writeFile(join(packageRoot, 'bin/cli.cjs'), `console.log(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), packageRoot: __dirname, build: process.env.HOLO_INTERNAL_FRAMEWORK_BUILD }))`)
  return packageRoot
}

it.each(frameworks)('runs the hoisted $framework executable with build arguments and the app working directory', async ({ framework, packageName, command, buildArgs }) => {
  const { workspace, projectRoot, runnerPath } = await createWorkspace(framework)
  const packageRoot = await installBinary(workspace, packageName, { [command]: 'bin/cli.cjs' })

  const result = await runRuntimeInvocation(process.execPath, [runnerPath, 'build', '--custom', 'value with spaces'], { cwd: workspace, env: process.env })

  expect(result.stderr).toBe('')
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout ?? '')).toEqual({ args: [...buildArgs, '--custom', 'value with spaces'], cwd: projectRoot, packageRoot: join(packageRoot, 'bin'), build: '1' })
})

it('prefers the app dependency over a different version hoisted at the workspace root', async () => {
  const { workspace, projectRoot, runnerPath } = await createWorkspace('next')
  await installBinary(workspace, 'next', { next: 'bin/cli.cjs' })
  const packageRoot = await installBinary(projectRoot, 'next', 'bin/cli.cjs')

  const result = await runRuntimeInvocation(process.execPath, [runnerPath, 'dev'], { cwd: workspace, env: process.env })

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout ?? '')).toMatchObject({ args: ['dev'], packageRoot: join(packageRoot, 'bin') })
})

it('runs an installed dependency linked to a package store', async () => {
  const { workspace, projectRoot, runnerPath } = await createWorkspace('next')
  const storeRoot = join(workspace, 'store')
  const packageRoot = await installBinary(storeRoot, 'next', { next: 'bin/cli.cjs' })
  await mkdir(join(projectRoot, 'node_modules'), { recursive: true })
  await symlink(packageRoot, join(projectRoot, 'node_modules/next'), 'junction')

  const result = await runRuntimeInvocation(process.execPath, [runnerPath, 'start', '--port', '4321'], { cwd: workspace, env: process.env })

  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout ?? '')).toMatchObject({ args: ['start', '--port', '4321'], packageRoot: join(packageRoot, 'bin') })
})

it.each(['relative', 'absolute'])('rejects a %s executable path outside its package', async (kind) => {
  const { workspace, runnerPath } = await createWorkspace('next')
  const outsidePath = join(workspace, 'node_modules/outside.cjs')
  await installBinary(workspace, 'next', { next: kind === 'relative' ? '../outside.cjs' : outsidePath })
  await writeFile(outsidePath, 'console.log("escaped")')

  const result = await runRuntimeInvocation(process.execPath, [runnerPath, 'build'], { cwd: workspace, env: process.env })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Missing framework binary "next"')
  expect(result.stdout).toBe('')
})

it('rejects an executable symlink that escapes its installed package', async () => {
  const { workspace, runnerPath } = await createWorkspace('next')
  const packageRoot = await installBinary(workspace, 'next', { next: 'bin/escape.cjs' })
  const outsidePath = join(workspace, 'outside.cjs')
  await writeFile(outsidePath, 'console.log("escaped")')
  await symlink(outsidePath, join(packageRoot, 'bin/escape.cjs'))

  const result = await runRuntimeInvocation(process.execPath, [runnerPath, 'build'], { cwd: workspace, env: process.env })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Missing framework binary "next"')
  expect(result.stdout).toBe('')
})

it('reports a missing framework instead of running another dependency with a string bin', async () => {
  const { workspace, runnerPath } = await createWorkspace('next')
  await installBinary(workspace, 'react', 'bin/cli.cjs')

  const result = await runRuntimeInvocation(process.execPath, [runnerPath, 'build'], { cwd: workspace, env: process.env })

  expect(result.status).toBe(1)
  expect(result.stderr).toContain('Missing framework binary "next"')
  expect(result.stdout).toBe('')
})
