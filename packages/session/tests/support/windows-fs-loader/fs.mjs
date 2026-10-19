import * as actual from 'node:fs/promises'
import { createWindowsFsModel } from '../windows-fs-model.mjs'

const model = createWindowsFsModel(actual, {
  enabled: (process.argv[1] ?? '').endsWith('file-session-worker.mjs'),
  freshFileMs: Number(process.env.WINDOWS_FS_FRESH_MS ?? 0),
  failRate: Number(process.env.WINDOWS_FS_FAIL_RATE ?? 0),
})

export * from 'node:fs/promises'
export const { unlink, rmdir, rename } = model
