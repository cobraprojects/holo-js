import { runCli } from '../cli'

const exitCode = await runCli(process.argv.slice(2), {
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
})

process.exit(exitCode)
