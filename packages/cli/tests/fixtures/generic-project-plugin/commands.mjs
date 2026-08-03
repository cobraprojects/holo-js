import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export default {
  name: 'generic:probe',
  description: 'Record execution of the generic fixture command.',
  async run(context) {
    const outputDirectory = join(context.projectRoot, '.generic-project-fixture')
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(join(outputDirectory, 'command.json'), `${JSON.stringify({
      args: context.args,
      cwd: context.cwd,
      flags: context.flags,
      projectRoot: context.projectRoot,
    }, null, 2)}\n`)
  },
}
