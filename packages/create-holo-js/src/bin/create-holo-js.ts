import { runCli } from '@holo-js/cli'

const exitCode = await runCli(['new', ...process.argv.slice(2)], {
  cwd: process.cwd(),
  stdin: process.stdin,
  stdout: process.stdout,
  stderr: process.stderr,
})

process.exit(exitCode)
