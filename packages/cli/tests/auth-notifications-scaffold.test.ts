import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import type { NotificationMailMessage } from '@holo-js/notifications'
import { renderAuthEmailVerificationNotification, renderAuthPasswordResetNotification } from '../src/project/scaffold/project-renderers'

type AuthNotificationModule = {
  readonly default: {
    readonly build: {
      email(data: { readonly email: string, readonly url: string, readonly expiresInMinutes: number }): NotificationMailMessage
    }
  }
}

const tempDirs: string[] = []
const workspaceRoot = resolve(import.meta.dirname, '../../..')

async function createProject(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'holo-cli-auth-notifications-'))
  tempDirs.push(root)
  await mkdir(join(root, 'server/notifications/auth'), { recursive: true })
  await mkdir(join(root, 'node_modules/@holo-js'), { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'auth-notifications-fixture', private: true, type: 'module' }), 'utf8')
  await Promise.all(['config', 'kernel', 'mail', 'notifications', 'queue'].map(async (name) => {
    await symlink(join(workspaceRoot, 'packages', name), join(root, 'node_modules/@holo-js', name))
  }))
  await writeFile(join(root, 'server/notifications/auth/email-verification.ts'), renderAuthEmailVerificationNotification(), 'utf8')
  await writeFile(join(root, 'server/notifications/auth/password-reset.ts'), renderAuthPasswordResetNotification(), 'utf8')
  return root
}

function typeErrors(root: string, fileName: string): string[] {
  const program = ts.createProgram([join(root, fileName)], {
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    target: ts.ScriptTarget.ES2022,
  })
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
}

async function buildEmail(root: string, name: 'email-verification' | 'password-reset'): Promise<NotificationMailMessage> {
  const module = await import(join(root, `server/notifications/auth/${name}.ts`)) as AuthNotificationModule
  return module.default.build.email({ email: 'ava@example.com', url: 'https://app.test/auth?token=abc', expiresInMinutes: 15 })
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

describe('auth notification override scaffolds', () => {
  it('type-check against the url and expiresInMinutes auth email data', async () => {
    const root = await createProject()
    await writeFile(join(root, 'check.ts'), [
      'import emailVerification from \'./server/notifications/auth/email-verification\'',
      'import passwordReset from \'./server/notifications/auth/password-reset\'',
      '',
      'const data = { email: \'ava@example.com\', name: \'Ava\', url: \'https://app.test\', expiresInMinutes: 60 }',
      'export const messages = [emailVerification.build.email(data), passwordReset.build.email(data)]',
      '',
    ].join('\n'), 'utf8')

    expect(typeErrors(root, 'check.ts')).toEqual([])
  })

  it('contain Laravel\'s email verification content', async () => {
    const root = await createProject()

    await expect(buildEmail(root, 'email-verification')).resolves.toEqual({
      subject: 'Verify Email Address',
      lines: ['Please click the button below to verify your email address.'],
      action: { label: 'Verify Email Address', url: 'https://app.test/auth?token=abc' },
      outroLines: ['If you did not create an account, no further action is required.'],
    })
  })

  it('contain Laravel\'s password reset content with the link lifetime', async () => {
    const root = await createProject()

    await expect(buildEmail(root, 'password-reset')).resolves.toEqual({
      subject: 'Reset Password Notification',
      lines: ['You are receiving this email because we received a password reset request for your account.'],
      action: { label: 'Reset Password', url: 'https://app.test/auth?token=abc' },
      outroLines: [
        'This password reset link will expire in 15 minutes.',
        'If you did not request a password reset, no further action is required.',
      ],
    })
  })
})
