import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workflowsDirectory = '.github/workflows'

function indentOf(line) {
  return line.length - line.trimStart().length
}

function unquote(value) {
  return value?.trim().replace(/^(["'])(.*)\1$/, '$2')
}

// Splits each `steps:` list into step bodies, keyed by the step's top-level and `with:` fields.
function workflowSteps(workflow) {
  const lines = workflow.split('\n')
  const steps = []
  for (let index = 0; index < lines.length; index++) {
    if (!/^\s*steps:\s*$/.test(lines[index])) continue
    const stepsIndent = indentOf(lines[index])
    let step
    for (index++; index < lines.length; index++) {
      const line = lines[index]
      if (line.trim() === '' || line.trim().startsWith('#')) continue
      const indent = indentOf(line)
      if (indent <= stepsIndent) {
        index--
        break
      }
      const item = /^(\s*)- (.*)$/.exec(line)
      if (item && (!step || item[1].length === step.indent)) {
        step = { indent: item[1].length, fields: {}, with: {}, inWith: false }
        steps.push(step)
      }
      const content = item && item[1].length === step.indent ? item[2] : line.trim()
      const field = /^([\w-]+):\s*(.*)$/.exec(content)
      if (!field) continue
      const fieldIndent = item && item[1].length === step.indent ? step.indent + 2 : indent
      if (fieldIndent === step.indent + 2) {
        step.fields[field[1]] = unquote(field[2])
        step.inWith = field[1] === 'with'
      } else if (step.inWith && fieldIndent === step.indent + 4) {
        step.with[field[1]] = unquote(field[2])
      }
    }
  }
  return steps
}

function globPattern(pattern) {
  return new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
}

export async function collectWorkflowArtifactFailures(root = repoRoot) {
  const files = (await readdir(join(root, workflowsDirectory))).filter(file => /\.ya?ml$/.test(file)).sort()
  const workflows = await Promise.all(files.map(async file => ({
    path: `${workflowsDirectory}/${file}`,
    steps: workflowSteps(await readFile(join(root, workflowsDirectory, file), 'utf8')),
  })))
  const downloads = workflows.flatMap(({ steps }) => steps)
    .filter(step => step.fields.uses?.startsWith('actions/download-artifact@'))
    .map(step => step.with.name ?? step.with.pattern ?? '*')
  const isConsumed = name => downloads.some(download => globPattern(download).test(name))

  const failures = []
  for (const { path, steps } of workflows) {
    for (const step of steps.filter(step => step.fields.uses?.startsWith('actions/upload-artifact@'))) {
      const name = step.with.name ?? 'artifact'
      const continuesOnError = step.fields['continue-on-error'] === 'true'
      if (isConsumed(name)) {
        if (continuesOnError) {
          failures.push(`${path} uploads ${name}, which a job downloads, so its step must not set continue-on-error.`)
        }
        continue
      }
      if (!continuesOnError) {
        failures.push(`${path} uploads the diagnostic artifact ${name}, which no job downloads, so its step must set continue-on-error: true.`)
        continue
      }
      const id = step.fields.id
      const condition = `always() && steps.${id}.outcome == 'failure'`
      const warns = id !== undefined && steps.slice(steps.indexOf(step) + 1)
        .some(later => later.fields.if === condition && later.fields.run?.includes('::warning'))
      if (!warns) {
        failures.push(`${path} must follow the diagnostic artifact ${name} upload with a step that runs on \`always() && steps.${id ?? '<id>'}.outcome == 'failure'\` and emits a ::warning annotation.`)
      }
    }
  }
  return failures
}

async function runWorkflowArtifactValidation(root = repoRoot) {
  const failures = await collectWorkflowArtifactFailures(root)

  if (failures.length > 0) {
    console.error('Workflow artifact validation failed:')
    for (const failure of failures) {
      console.error(`- ${failure}`)
    }
    return 1
  }

  console.log('Workflow artifacts validated.')
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await runWorkflowArtifactValidation())
}
