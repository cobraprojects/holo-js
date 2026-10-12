import { mkdtempSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { onTestFinished } from 'vitest'
import { createFileSessionStore } from '../../../session/src'

export function createNativeSessionStore() {
  const path = mkdtempSync(join(tmpdir(), 'holo-auth-sessions-'))
  onTestFinished(() => rm(path, { recursive: true, force: true }))
  return Object.assign(createFileSessionStore(path), {
    path,
    async countRecords(): Promise<number> {
      return (await readdir(path)).filter(filename => filename.endsWith('.json')).length
    },
  })
}
