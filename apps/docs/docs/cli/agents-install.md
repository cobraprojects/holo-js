# Agentic Coding

`holo agents:install` installs Holo-JS documentation-search skills for coding agents.

Use it when you want an AI coding assistant to answer Holo-JS questions by searching the current docs
instead of relying on stale framework knowledge.

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

By default, the command writes project-local skills under the current directory:

```text
.codex/skills/holo-js/SKILL.md
.claude/skills/holo-js/SKILL.md
.cursor/skills/holo-js/SKILL.md
.windsurf/skills/holo-js/SKILL.md
.opencode/skills/holo-js/SKILL.md
.gemini/skills/holo-js/SKILL.md
.kiro/skills/holo-js/SKILL.md
```

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

If a target skill file already exists and does not match Holo-JS's generated content, the command refuses
to overwrite it.

Use `--force` when you intentionally want to replace the existing file:

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
