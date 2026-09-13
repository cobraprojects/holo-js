# Agentic Coding

`holo agents:install` installs versioned Holo-JS coding skills for coding agents.

The installed skill set includes a routing skill, focused guides for each framework area, worked examples,
conversion guidance, and a package catalog with a direct documentation link for every package.

## Install agent skills

::: code-group

```bash [npm]
npx holo agents:install
```

```bash [pnpm]
pnpm dlx holo agents:install
```

```bash [Yarn]
yarn dlx holo agents:install
```

```bash [Bun]
bunx holo agents:install
```

:::

In an interactive terminal, the command shows a multi-select prompt for supported coding agents. In
non-interactive environments, it installs every supported target unless `--agent` is provided.

Supported targets:

- `all` installs skills for all available agents at once
- `codex`
- `claude`
- `cursor`
- `windsurf`
- `opencode`
- `gemini`
- `kiro`

## Install only selected agents

Use `--agent` when you only want a subset:

::: code-group

```bash [npm]
npx holo agents:install --agent codex,cursor
```

```bash [pnpm]
pnpm dlx holo agents:install --agent codex,cursor
```

```bash [Yarn]
yarn dlx holo agents:install --agent codex,cursor
```

```bash [Bun]
bunx holo agents:install --agent codex,cursor
```

:::

## Project-local install

By default, the command writes a project-local skill tree under the current directory:

```text
.codex/skills/holo-js/SKILL.md
.claude/skills/holo-js/SKILL.md
.cursor/skills/holo-js/SKILL.md
.windsurf/skills/holo-js/SKILL.md
.opencode/skills/holo-js/SKILL.md
.gemini/skills/holo-js/SKILL.md
.kiro/skills/holo-js/SKILL.md
```

Each `holo-js` directory also contains focused skills such as `database-orm`, `forms-validation`,
`queues-events`, and `storage-media`. Agents load the root routing skill first and then read only the
focused guidance required for the task.

Commit these files when you want every contributor's agent to use the same Holo-JS guidance in the project.

## Global install

Use `--global` to install into the current user's agent skill directory instead of the current project:

::: code-group

```bash [npm]
npx holo agents:install --global
```

```bash [pnpm]
pnpm dlx holo agents:install --global
```

```bash [Yarn]
yarn dlx holo agents:install --global
```

```bash [Bun]
bunx holo agents:install --global
```

:::

Use global install when you want Holo-JS guidance available across all local projects.

## Overwrite protection

If any file in a target skill tree differs from the packaged Holo-JS version, or the tree contains an
extra file, the command refuses to overwrite it.

Use `--force` when you intentionally want to replace the existing tree:

::: code-group

```bash [npm]
npx holo agents:install --force
```

```bash [pnpm]
pnpm dlx holo agents:install --force
```

```bash [Yarn]
yarn dlx holo agents:install --force
```

```bash [Bun]
bunx holo agents:install --force
```

:::

## Aliases

These commands are equivalent:

```bash
holo agents:install
holo agent:install
holo ai:install
```
