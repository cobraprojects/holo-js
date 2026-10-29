import type * as FsPromises from 'node:fs/promises'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  configureMailRuntime,
  defineMail,
  normalizeMailConfig,
  resetMailRuntime,
  sendMail,
} from '../src'

// Each write is paused halfway so the test can look at the preview folder exactly while a message is
// being written, the moment a concurrent reader would see it.
const faults = vi.hoisted(() => ({
  midWrite: undefined as undefined | (() => Promise<void>),
  failWrite: false,
  failRename: false,
}))

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof FsPromises>()
  return {
    ...actual,
    writeFile: async (path: string, contents: string, options: Parameters<typeof actual.writeFile>[2]) => {
      await actual.writeFile(path, contents.slice(0, Math.floor(contents.length / 2)), options)
      await faults.midWrite?.()
      if (faults.failWrite) {
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' })
      }
      return await actual.writeFile(path, contents, options)
    },
    rename: async (source: string, target: string) => {
      if (faults.failRename) {
        throw Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' })
      }
      return await actual.rename(source, target)
    },
  }
})

let previewRoot = ''

function configurePreviewMailer(path: string): void {
  const config = normalizeMailConfig()
  const preview = config.mailers.preview!
  configureMailRuntime({
    config: {
      ...config,
      default: 'preview',
      from: { email: 'config@example.com' },
      mailers: { ...config.mailers, preview: { ...preview, path } },
    },
  })
}

async function readPreviewMessages(): Promise<unknown[]> {
  const files = (await readdir(previewRoot)).filter(name => name.endsWith('.json'))
  return Promise.all(files.map(async file => JSON.parse(await readFile(join(previewRoot, file), 'utf8')) as unknown))
}

const invitation = (email: string) => defineMail({ to: email, subject: 'Invitation', text: `Hello ${email}` })

beforeEach(async () => {
  previewRoot = await mkdtemp(join(tmpdir(), 'holo-mail-preview-atomic-'))
  configurePreviewMailer(previewRoot)
})

afterEach(async () => {
  Object.assign(faults, { midWrite: undefined, failWrite: false, failRename: false })
  resetMailRuntime()
  await rm(previewRoot, { recursive: true, force: true })
})

describe('preview mailer file writes', () => {
  it('never exposes a half-written message under its final name', async () => {
    const seenWhileWriting: unknown[][] = []
    faults.midWrite = async () => {
      seenWhileWriting.push(await readPreviewMessages())
    }

    const [first, second] = await Promise.all([
      sendMail(invitation('a@example.com')),
      sendMail(invitation('b@example.com')),
    ])

    expect(seenWhileWriting).toHaveLength(2)
    for (const seen of seenWhileWriting) {
      expect(seen.length).toBeLessThanOrEqual(1)
    }
    expect((await readdir(previewRoot)).sort()).toEqual([`${first.messageId}.json`, `${second.messageId}.json`].sort())
    expect(await readPreviewMessages()).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: first.messageId }),
      expect.objectContaining({ messageId: second.messageId }),
    ]))
  })

  it('removes the temporary file and leaves no message when the write fails', async () => {
    faults.failWrite = true

    await expect(sendMail(invitation('a@example.com'))).rejects.toThrow()
    expect(await readdir(previewRoot)).toEqual([])
  })

  it('removes the temporary file and leaves no message when the rename fails', async () => {
    faults.failRename = true

    await expect(sendMail(invitation('a@example.com'))).rejects.toThrow()
    expect(await readdir(previewRoot)).toEqual([])
  })
})
