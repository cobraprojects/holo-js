import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { compile } from 'svelte/compiler'
import { expect, it, onTestFinished } from 'vitest'

const execFileAsync = promisify(execFile)

it('keeps explicit Svelte auth instances separate from the real component context and accepts plain context values', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'holo-native-svelte-auth-'))
  onTestFinished(() => rm(directory, { recursive: true, force: true }))
  const module = new URL('../src/sveltekit/client.ts', import.meta.url).href
  const fixture = compile(`
    <script>
      import { useAuth, setAuthContext } from ${JSON.stringify(module)}
      const initial = useAuth({ initialProvider: 'users', initialUser: { id: 1, email: 'ava@app.test' } })
      const admin = useAuth({ guard: 'admin' })
      const endpoint = useAuth({ endpoint: '/api/admin/auth/current' })
      const headers = useAuth({ headers: { 'x-holo-guard': 'admin' } })
      const defaultAfterOptions = useAuth()
      const plain = { authenticated: true, provider: 'users', user: { id: 2 }, refreshUser: async () => null }
      setAuthContext(plain)
      globalThis.nativeAuthResult = {
        defaultUnchanged: defaultAfterOptions === initial,
        email: defaultAfterOptions.user.email,
        explicitSeparate: [admin, endpoint, headers].every(value => value !== initial && value.user === null),
        plainUnchanged: useAuth() === plain,
      }
    </script>
    <p>{initial.user.email}</p>
  `, { generate: 'server', filename: 'NativeAuth.svelte' })
  const component = join(directory, 'NativeAuth.mjs')
  await writeFile(component, fixture.js.code)
  const nodeModules = new URL('../node_modules/', import.meta.url).pathname
  const { symlink } = await import('node:fs/promises')
  await symlink(nodeModules, join(directory, 'node_modules'), 'dir')
  const { stdout } = await execFileAsync('bun', ['--eval', `
    import { render } from 'svelte/server'
    import Component from ${JSON.stringify(component)}
    const result = render(Component)
    const renderedEmail = result.body.includes('ava@app.test')
    console.log(JSON.stringify({ ...globalThis.nativeAuthResult, renderedEmail }))
  `], { cwd: new URL('..', import.meta.url).pathname })
  expect(JSON.parse(stdout)).toEqual({ defaultUnchanged: true, email: 'ava@app.test', explicitSeparate: true, plainUnchanged: true, renderedEmail: true })
})
