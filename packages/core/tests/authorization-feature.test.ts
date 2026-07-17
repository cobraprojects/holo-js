import { rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nextFixtureRoot = resolve(import.meta.dirname, '../../../apps/blog-next')

type CommandResult = {
  readonly stdout: string
  readonly stderr: string
}

function runFixtureCommand(command: string, args: readonly string[]): CommandResult {
  const result = spawnSync(command, args, {
    cwd: nextFixtureRoot,
    encoding: 'utf8',
    env: process.env,
    timeout: 240_000,
  })

  if (result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.stdout ? `STDOUT:\n${result.stdout}` : '',
      result.stderr ? `STDERR:\n${result.stderr}` : '',
    ].filter(Boolean).join('\n\n'))
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
  }
}

async function withFixtureScript<T>(
  fileName: string,
  contents: string,
  callback: (scriptPath: string) => T | Promise<T>,
): Promise<T> {
  const scriptPath = join(nextFixtureRoot, fileName)
  await writeFile(scriptPath, contents, 'utf8')

  try {
    return await callback(scriptPath)
  } finally {
    await rm(scriptPath, { force: true })
  }
}

describe('@holo-js/core authorization real-world feature integration', () => {
  it('uses the real auth user and the real Post model facade without fake actors', async () => {
    runFixtureCommand('bunx', ['holo', 'prepare'])
    runFixtureCommand('bunx', ['holo', 'migrate:fresh', '--seed', '--force'])

    const script = `
import auth, { authRuntimeInternals, configureAuthRuntime } from '@holo-js/auth'
import { authorize, can, cannot, inspect } from '@holo-js/authorization'
import { holo } from './.holo-js/generated/next/holo.ts'

const project = await holo.getApp()

const { default: Post } = await import('./server/models/Post.ts')
const { default: User } = await import('./server/models/User.ts')

let draft = await Post.where('slug', 'authorization-draft').first()
const editor = await User.where('email', 'editor@example.com').firstOrFail()
const editorId = editor.toAttributes().id

if (!draft) {
  draft = await Post.create({
    user_id: editorId,
    slug: 'authorization-draft',
    title: 'Authorization Draft',
    excerpt: 'Authorization integration fixture.',
    body: 'Hidden from guests.',
    status: 'draft',
    published_at: null,
  })
}

const published = await Post.where('slug', 'shipping-a-real-holo-blog-on-next').firstOrFail()

const session = await auth.loginUsingId(editorId)
const bindings = authRuntimeInternals.getRuntimeBindings()
const freshContext = authRuntimeInternals.createAsyncAuthContext()
configureAuthRuntime({ ...bindings, context: freshContext })
freshContext.activate()
freshContext.setSessionId('web', session.sessionId)
if (session.rememberToken) {
  freshContext.setRememberToken?.('web', session.rememberToken)
}

try {
  const currentUser = await auth.user()
  const publishedDecision = await inspect('view', published)
  const draftAllowed = await can('view', draft)
  const deleteDenied = await cannot('delete', published)
  await authorize('view', draft)

  console.log(JSON.stringify({
    authUserId: currentUser?.id ?? null,
    authUserEmail: currentUser?.email ?? null,
    postModelName: Post.definition.name,
    postSlug: String(published.get('slug')),
    publishedDecision,
    draftAllowed,
    deleteDenied,
  }))
} finally {
  configureAuthRuntime(bindings)
  await project.runtime.shutdown()
}
`.trim()

    await withFixtureScript('.authorization-feature-script.mts', script, async (scriptPath) => {
      const execution = runFixtureCommand('bunx', ['tsx', '--tsconfig', 'tsconfig.json', scriptPath])
      const outputLines = execution.stdout
        .trim()
        .split('\n')
      const payloadLine = [...outputLines]
        .reverse()
        .find((line: string) => line.trim().startsWith('{'))

      expect(payloadLine).toBeDefined()

      const payload = JSON.parse(payloadLine as string) as {
        readonly authUserId: string | number | null
        readonly authUserEmail: string | null
        readonly postModelName: string
        readonly postSlug: string
        readonly publishedDecision: {
          readonly allowed: boolean
          readonly status: number
        }
        readonly draftAllowed: boolean
        readonly deleteDenied: boolean
      }

      expect(payload.authUserId).not.toBeNull()
      expect(payload.authUserEmail).toBe('editor@example.com')
      expect(payload.postModelName).toBe('Post')
      expect(payload.postSlug).toBe('shipping-a-real-holo-blog-on-next')
      expect(payload.publishedDecision).toEqual({ allowed: true, status: 200 })
      expect(payload.draftAllowed).toBe(true)
      expect(payload.deleteDenied).toBe(true)
    })
  }, 300_000)
})
