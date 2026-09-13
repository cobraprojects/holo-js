import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installAgentSkills } from '../src/agent-skills'

const tempDirectories: string[] = []

async function installCodexSkill(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'holo-agent-skill-'))
  tempDirectories.push(projectRoot)

  await installAgentSkills(projectRoot, { agents: ['codex'] })

  return join(projectRoot, '.codex/skills/holo-js')
}

async function readWorkspacePackageNames(): Promise<readonly string[]> {
  const packagesRoot = resolve(import.meta.dirname, '../..')
  const packageDirectories = await readdir(packagesRoot, { withFileTypes: true })
  const names = await Promise.all(packageDirectories
    .filter(entry => entry.isDirectory())
    .map(async (entry) => {
      const contents = await readFile(join(packagesRoot, entry.name, 'package.json'), 'utf8')
      const packageJson = JSON.parse(contents) as { readonly name?: string }
      return packageJson.name
    }))

  return names.filter((name): name is string => typeof name === 'string').sort()
}

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Holo agent skill', () => {
  it('maps every workspace package to a direct documentation link', async () => {
    const skillRoot = await installCodexSkill()
    const packageCatalog = await readFile(join(skillRoot, 'references/packages.md'), 'utf8')
    const packageNames = await readWorkspacePackageNames()

    for (const packageName of packageNames) {
      const row = packageCatalog
        .split('\n')
        .find(line => line.startsWith('| `' + packageName + '` |'))

      expect(row).toMatch(/\| \[[^\]]+\]\(https:\/\/docs\.holo-js\.com\/[^)]*\) \|$/)
    }
  })

  it('directs a custom form action conversion to shared Holo schemas and direct validation', async () => {
    const skillRoot = await installCodexSkill()
    const rootSkill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    const formsSkill = await readFile(join(skillRoot, 'forms-validation/SKILL.md'), 'utf8')
    const conversionSkill = await readFile(join(skillRoot, 'lifecycle/convert-to-holo/SKILL.md'), 'utf8')

    expect(rootSkill).toContain('Treat Holo-JS like Laravel.')
    expect(rootSkill).toContain('Application code never imports `internal` paths')
    expect(formsSkill).toContain("from '@holo-js/validation'")
    expect(formsSkill).toContain('type CreatePostRequest')
    expect(formsSkill).toContain('const data = await validate(request, createPostForm)')
    expect(formsSkill).toContain("const form = useForm(createPostForm, { initialValues: { title: '', body: '' } })")
    expect(conversionSkill).toContain('const post = await Post.create(data)')
  })

  it('requires conversion cleanup across wrappers, snapshots, migrations, and orphaned tests', async () => {
    const skillRoot = await installCodexSkill()
    const skill = await readFile(join(skillRoot, 'lifecycle/convert-to-holo/SKILL.md'), 'utf8')

    expect(skill).toContain('Named files are examples unless the user explicitly limits scope to them.')
    expect(skill).toContain('Leaving test-only imports, migration-only helpers, snapshots, or compatibility exports behind is an incomplete conversion.')
    expect(skill).toContain('Confirm every removed module has zero imports, including tests, seeds, scripts, and generated files.')
  })

  it('defines a bounded recovery path for documentation and package mismatches', async () => {
    const skillRoot = await installCodexSkill()
    const skill = await readFile(join(skillRoot, 'lifecycle/convert-to-holo/SKILL.md'), 'utf8')

    expect(skill).toContain('Report the documented API and installed package version.')
    expect(skill).toContain("Inspect only that package's public `exports` and exported declarations.")
    expect(skill).toContain('stop and report the incompatibility')
  })

  it('puts requested Holo architecture ahead of conflicting application conventions', async () => {
    const skillRoot = await installCodexSkill()
    const rootSkill = await readFile(join(skillRoot, 'SKILL.md'), 'utf8')
    const conversionSkill = await readFile(join(skillRoot, 'lifecycle/convert-to-holo/SKILL.md'), 'utf8')

    expect(rootSkill).toContain("1. Follow the user's requested architecture and scope.")
    expect(rootSkill).toContain('2. Follow the current official Holo-JS conventions.')
    expect(rootSkill).toContain("3. Preserve an application's conventions only where they agree with the first two rules.")
    expect(conversionSkill).toContain('Treat the old wrappers and helpers as removal targets, not precedent')
  })

  it('installs focused capability skills and keeps agent targets identical', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-agent-skill-'))
    tempDirectories.push(projectRoot)

    await installAgentSkills(projectRoot, { agents: ['codex', 'cursor'] })

    const relativePaths = [
      'SKILL.md',
      'application-runtime/SKILL.md',
      'auth-security/SKILL.md',
      'broadcast-realtime/SKILL.md',
      'database-orm/SKILL.md',
      'forms-validation/SKILL.md',
      'framework-next/SKILL.md',
      'framework-nuxt/SKILL.md',
      'framework-sveltekit/SKILL.md',
      'lifecycle/convert-to-holo/SKILL.md',
      'mail-notifications/SKILL.md',
      'queues-events/SKILL.md',
      'references/conversion-examples.md',
      'references/packages.md',
      'storage-media/SKILL.md',
      'testing-deployment/SKILL.md',
    ]

    for (const relativePath of relativePaths) {
      const codexFile = await readFile(join(projectRoot, '.codex/skills/holo-js', relativePath), 'utf8')
      const cursorFile = await readFile(join(projectRoot, '.cursor/skills/holo-js', relativePath), 'utf8')
      expect(cursorFile).toBe(codexFile)
    }
  })

  it('detects a changed nested skill and replaces the complete tree with force', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'holo-agent-skill-'))
    tempDirectories.push(projectRoot)
    const nestedSkill = join(projectRoot, '.codex/skills/holo-js/database-orm/SKILL.md')

    await installAgentSkills(projectRoot, { agents: ['codex'] })
    await writeFile(nestedSkill, 'custom guidance', 'utf8')

    await expect(installAgentSkills(projectRoot, { agents: ['codex'] }))
      .rejects.toThrow('Refusing to overwrite existing codex skill')
    await expect(installAgentSkills(projectRoot, { agents: ['codex'], force: true }))
      .resolves.toEqual([expect.objectContaining({ status: 'updated' })])
    await expect(readFile(nestedSkill, 'utf8')).resolves.toContain('# Database and ORM')
  })
})
