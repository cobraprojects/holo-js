# Coding with AI Agents

`holo agents:install` gives AI coding agents like Claude Code, Codex, and Cursor a set of Holo-JS skills: guides that tell the agent how Holo apps are built and where to find the right docs. With them installed, agents use Holo's own APIs instead of inventing their own.

```bash
npx holo agents:install
```

In a terminal, the command asks which agents to install for, with all of them selected. Press Enter to accept.

## What gets installed

The skill set includes:

- a main `holo-js` skill that routes each task to the right guide
- focused guides for each area: database and ORM, forms and validation, auth and security, storage and media, queues and events, mail and notifications, broadcasting and realtime, app runtime, testing and deployment
- a guide for each framework: Next.js, Nuxt, and SvelteKit
- a guide for converting an existing app to Holo, with worked examples
- a catalog of every Holo package with a link to its docs

The agent reads the main skill first, then only the guides it needs for the task at hand.

## Supported agents

| Agent | `--agent` value | Project folder |
| --- | --- | --- |
| Claude Code | `claude` | `.claude/skills/holo-js/` |
| Codex | `codex` | `.codex/skills/holo-js/` |
| Cursor | `cursor` | `.cursor/skills/holo-js/` |
| Windsurf | `windsurf` | `.windsurf/skills/holo-js/` |
| OpenCode | `opencode` | `.opencode/skills/holo-js/` |
| Gemini | `gemini` | `.gemini/skills/holo-js/` |
| Kiro | `kiro` | `.kiro/skills/holo-js/` |

## Install for specific agents

Pass `--agent` with a comma-separated list:

```bash
npx holo agents:install --agent claude,cursor
```

Use `--agent all` to install for every agent. When the terminal is not interactive, such as in CI, and you don't pass `--agent`, the command installs for all agents.

## Project or global install

By default, skills go into the current project, in the folders listed above. Commit them so everyone on the team, and their agents, use the same guidance.

To install for your user account instead, so the skills apply to every project on your machine, add `--global`:

```bash
npx holo agents:install --global
```

Global skills go into `~/.<agent>/skills/holo-js/` in your home folder, for example `~/.claude/skills/holo-js/`. OpenCode uses `~/.config/opencode/skills/holo-js/`.

## Update the skills

Run the command again after upgrading Holo. If the installed skills already match the packaged version, nothing changes.

If you edited an installed skill, or added files to its folder, the command stops instead of overwriting your changes. Pass `--force` to replace the folder with the packaged version:

```bash
npx holo agents:install --force
```

::: warning
`--force` deletes the whole `holo-js` skill folder for each selected agent before writing the new one. Move any custom notes somewhere else first.
:::

## Options

| Option | What it does |
| --- | --- |
| `--agent <list>` | Comma-separated agents to install for, or `all` |
| `--global` | Install into your home folder instead of the project |
| `--force` | Replace skill folders that differ from the packaged version |

`holo agent:install` and `holo ai:install` are aliases for the same command.

## Next steps

- [CLI Commands](/reference/cli)
- [Project Structure](/getting-started/project-structure)
