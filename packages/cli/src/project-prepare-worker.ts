import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProjectPrepare } from './dev'
import { GENERATED_SCHEMA_RUNTIME_PATH } from './project/shared'

const projectRoot = process.env.HOLO_PROJECT_PREPARE_ROOT
if (!projectRoot) throw new Error('Project preparation requires HOLO_PROJECT_PREPARE_ROOT.')

await import(pathToFileURL(resolve(projectRoot, GENERATED_SCHEMA_RUNTIME_PATH)).href)
await runProjectPrepare(projectRoot, {
  cwd: projectRoot,
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
}, { command: 'build', prepareSchema: false, reason: 'initial' })
