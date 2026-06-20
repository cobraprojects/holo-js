import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const SUPPORTED_AGENT_SKILL_TARGETS = [
  'codex',
  'claude',
  'cursor',
  'windsurf',
  'opencode',
  'gemini',
  'kiro',
] as const

export type SupportedAgentSkillTarget = typeof SUPPORTED_AGENT_SKILL_TARGETS[number]

export type InstallAgentSkillsOptions = {
  readonly agents: readonly SupportedAgentSkillTarget[]
  readonly global?: boolean
  readonly force?: boolean
}

export type AgentSkillInstallResult = {
  readonly agent: SupportedAgentSkillTarget
  readonly path: string
  readonly status: 'created' | 'updated' | 'unchanged'
}

const HOLO_AGENT_SKILL = `---
name: holo-js
description: Help users build applications with the Holo-JS framework by researching the current Holo-JS documentation at https://docs.holo-js.com/ before answering or coding. Use when a user asks how to scaffold, configure, integrate, or implement Holo-JS app features in Nuxt, Next.js, or SvelteKit, including database, ORM, auth, authorization, validation, forms, storage, media, queues, events, broadcast, realtime, mail, notifications, testing, or deployment. Prefer this for user-facing app work, not Holo-JS framework internals.
---

# Holo-JS

Use the docs as the source of truth. Do not answer from memory when exact commands, imports, API names, config shape, route shape, or framework integration details matter.

Primary documentation URL: https://docs.holo-js.com/

## Required Workflow

1. Clarify the user's task category in your own reasoning: setup, config, database, ORM, auth, authorization, validation/forms, storage/media, queue/events, broadcast/realtime, mail/notifications, testing, deployment, or framework integration.
2. Search the live docs before giving implementation details.
3. Open the most relevant docs pages and read the sections that match the task.
4. Cross-check at least one adjacent or overview page when the task touches package setup, framework integration, auth/session/security, background workers, or deployment.
5. Base commands and code on the docs you just read.
6. Mention when docs do not cover the requested detail and ask for a docs link, local project context, or permission to inspect the package source.

## How To Search

Prefer these approaches, in order:

1. Use the docs site's own search if you have browser access.
2. Use web search with \`site:docs.holo-js.com\` plus the concrete feature terms.
3. Open likely docs URLs from search results, then follow sidebar or in-page links to related pages.
4. If working inside the Holo-JS repository, search local docs source under \`apps/docs/docs/**/*.md\` with \`rg\` as a fallback or for faster exact matching.

Good search queries:

- \`site:docs.holo-js.com Holo-JS install <package-or-feature>\`
- \`site:docs.holo-js.com Holo-JS <framework> <feature>\`
- \`site:docs.holo-js.com Holo-JS <api-or-command-name>\`
- \`site:docs.holo-js.com Holo-JS <error message or concept>\`

Local repo fallback:

\`\`\`bash
rg -n "<feature|api|command|error>" apps/docs/docs
find apps/docs/docs -type f -name '*.md' | sort
\`\`\`

## What To Open

Use docs pages by task area, not by package guesses. Examples:

- Starting a project: installation, configuration, directory structure.
- Framework routing or handlers: routing, runtime services, framework-specific integration pages.
- Database and models: database pages first, then ORM pages.
- Auth flows: auth overview plus the specific flow page, then session/cookies or current auth client if state is involved.
- Authorization: authorization overview plus policies or abilities.
- Forms: forms overview plus server validation, client usage, and framework integration as needed.
- Files: storage first; media only when files belong to models or need conversions/collections.
- Background work: queue, events, queued listeners, workers, failed jobs, and deployment pages as needed.
- Browser realtime: broadcast or realtime docs plus framework helper pages.
- Production behavior: deployment plus any worker/driver page for the feature.

These names are navigation hints, not an API reference. Confirm exact paths and examples from the docs before responding.

## Answering Rules

- Cite or link the docs pages you used when the environment supports links.
- Keep examples aligned with the user's framework and package manager.
- Preserve framework-native routing, redirect, server action, and handler conventions shown by the docs.
- Do not invent helper APIs to make an answer look cleaner.
- Do not assume optional packages are installed. Check install/setup docs for the feature.
- Do not expose secrets in client code or examples.
- Do not hand-edit generated Holo-JS output unless docs explicitly instruct it.
- If docs and installed package behavior disagree, tell the user what you found and treat the discrepancy as something to verify before coding.

## Coding Against An Existing App

When editing a user's app:

1. Inspect the app's framework, package manager, installed \`@holo-js/*\` packages, and existing Holo-JS config.
2. Search docs for the exact feature and framework.
3. Match the app's existing conventions.
4. Add validation and authorization at boundaries when the docs indicate they are required.
5. Run the app's relevant typecheck, lint, and tests when available.

If the user asks for a broad implementation such as "add auth" or "add realtime", start from the docs' setup/overview pages and implement the smallest complete vertical slice rather than assembling APIs from memory.
`

function resolveAgentSkillPath(root: string, agent: SupportedAgentSkillTarget): string {
  return resolve(root, agentRoot(agent), 'skills/holo-js/SKILL.md')
}

function resolveGlobalAgentSkillPath(agent: SupportedAgentSkillTarget): string {
  const home = homedir()

  if (agent === 'opencode') {
    return resolve(home, '.config/opencode/skills/holo-js/SKILL.md')
  }

  return resolveAgentSkillPath(home, agent)
}

function agentRoot(agent: SupportedAgentSkillTarget): string {
  if (agent === 'claude') {
    return '.claude'
  }

  if (agent === 'opencode') {
    return '.opencode'
  }

  return `.${agent}`
}

async function readExisting(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return undefined
    }

    throw error
  }
}

export function normalizeAgentSkillTargets(values: readonly string[]): readonly SupportedAgentSkillTarget[] {
  const requested = values.length > 0 ? values : ['all']
  const agents = new Set<SupportedAgentSkillTarget>()

  for (const value of requested) {
    const normalized = value.trim().toLowerCase()
    if (!normalized) {
      continue
    }

    if (normalized === 'all') {
      for (const agent of SUPPORTED_AGENT_SKILL_TARGETS) {
        agents.add(agent)
      }
      continue
    }

    if (!SUPPORTED_AGENT_SKILL_TARGETS.includes(normalized as SupportedAgentSkillTarget)) {
      throw new Error(`Unsupported agent skill target: ${value}.`)
    }

    agents.add(normalized as SupportedAgentSkillTarget)
  }

  return [...agents]
}

export async function installAgentSkills(
  projectRoot: string,
  options: InstallAgentSkillsOptions,
): Promise<readonly AgentSkillInstallResult[]> {
  const results: AgentSkillInstallResult[] = []

  for (const agent of options.agents) {
    const path = options.global === true
      ? resolveGlobalAgentSkillPath(agent)
      : resolveAgentSkillPath(projectRoot, agent)
    const existing = await readExisting(path)

    if (existing === HOLO_AGENT_SKILL) {
      results.push({ agent, path, status: 'unchanged' })
      continue
    }

    if (typeof existing === 'string' && options.force !== true) {
      throw new Error(`Refusing to overwrite existing ${agent} skill at ${path}. Re-run with --force to replace it.`)
    }

    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, HOLO_AGENT_SKILL, 'utf8')
    results.push({
      agent,
      path,
      status: typeof existing === 'string' ? 'updated' : 'created',
    })
  }

  return results
}
