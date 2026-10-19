# Contributing

Thanks for helping improve Holo-JS. This page is for working on the framework itself, in the [holo-js repository](https://github.com/cobraprojects/holo-js). If you're building an app with Holo, start with the [Quick Start](/getting-started/quick-start) instead.

## Set up the repository

The monorepo uses [Bun](https://bun.sh) for installs and scripts.

```bash
git clone https://github.com/cobraprojects/holo-js.git
cd holo-js
bun install
```

### Services the test suite needs

The full test suite runs against real databases and Redis:

| Service | Expected setup |
| --- | --- |
| PostgreSQL | Port `5432`, user `postgres` |
| MySQL | Port `3306`, user `root`, empty password |
| Redis | Port `6379`, plus the `redis-server` executable on your `PATH` |
| Chromium | `bun x playwright install chromium` (add `--with-deps` on Linux) |

## Repository layout

| Folder | Contents |
| --- | --- |
| `packages/` | Every `@holo-js/*` package. See [How Holo Works](/advanced/architecture) for how they fit together. |
| `apps/blog-next`, `apps/blog-nuxt`, `apps/blog-sveltekit` | The same blog app in each framework. They double as end-to-end tests. |
| `docs/adr/` | Architecture decision records. |
| `scripts/` | Build, validation, and release scripts. |

Shared dependency versions live in the root `package.json` under `workspaces.catalog`. Packages refer to them with `"catalog:"`, and to each other with `"workspace:*"`.

## Everyday commands

| Command | What it does |
| --- | --- |
| `bun run typecheck` | Typecheck every library package and the tests. |
| `bun run lint` | Run ESLint across the repo. |
| `bun run lint:fix` | Lint and auto-fix. |
| `bun run audit:runtime` | Report dependency advisories; fail on high or critical advisories reachable from published packages. |
| `bun run check:dead-code` | Fail on new Fallow findings against the committed baseline. |
| `bun run --cwd packages/<name> test` | Run one package's tests while you work. |
| `bun run test:libraries` | Run every library test suite against the real services. |
| `bun run test:examples` | Run the Next.js, Nuxt, and SvelteKit example apps against SQLite, PostgreSQL, and MySQL. |
| `bun run test:ci` | `test:libraries` plus `test:examples`. |
| `bun run test` | `test:ci` plus published-package, scaffold, and browser-bundle checks. Run it locally before a release and for changes to adapters, the CLI scaffold, or packaging. |
| `bun run test:platform` | Native package loading and server lifecycle tests. |
| `bun run test:coverage` | Coverage report, for finding untested behavior. |
| `bun run check` | Typecheck, lint, and `test:ci`. |

The CLI's package-manager tests run real `npm`, `pnpm`, and `yarn` installs, so those tools must be on your `PATH`. CI installs pnpm 10.34.7 and yarn 1.22.22 with npm. Install the same versions locally to run them.

## Before you push

Run `bun run check` before you push. Running one package's tests is fine while you edit, but it doesn't replace `check` for changes to shared packages.

CI runs the critical checks on every pull request: library and test typechecks and lint on Node 24, every library test suite against real services on Node 24, the runtime audit and dead-code gate, and native package loading and server lifecycle checks on Linux, Windows, and macOS with Node 22.14.0, 24, and 26. The example apps and the published-package, scaffold, and browser-bundle acceptance checks run locally with `bun run test`; run them under each supported Node version before a release.

The dependency job runs `bun run audit:runtime`. It follows dependencies, optional dependencies, and installed peers from every published package through the lockfile. High and critical advisories on those resolved versions fail the job. Other advisories, including versions used only by examples or tooling, are reported without failing it. A failed registry request or invalid report fails the audit.

When a blocking advisory has no patched release, add a time-boxed entry to `audit-exceptions.json` with the advisory URL, the exact package and version, the reason it is reachable, and an `expires` date. Excepted advisories are reported as `EXCEPT` until that date, then block again. An exception that no longer matches a blocking advisory also fails the audit, so remove entries once the dependency is patched. An invalid exceptions file fails the audit.

Dependabot checks npm dependencies and GitHub Actions weekly.

`bun run check:dead-code` uses Fallow 3.34.1 and `fallow-baseline.json`. The committed `fallow.toml` resolves Holo packages through their `@holo-js/source` exports, so the scan does not require built packages. Existing findings are recorded by identity, so removing one finding does not make room for a new orphan. Remove unused code rather than adding it to the baseline. When intentionally updating the scanner or recording reviewed existing findings, run:

```bash
npx --yes fallow@3.34.1 dead-code --format json --quiet --save-baseline fallow-baseline.json
```

Review the baseline diff before committing it. The save command can exit with findings while still writing the baseline.

Overlapping `bun run typecheck` commands can share a checkout. Each test typecheck creates a unique configuration directory and removes only its own directory when it finishes.

## Code standards

The repository's `AGENTS.md` has the full rules. The main ones:

- **TypeScript, strictly typed.** No `any` without a written reason, no `@ts-ignore`. Use inline type imports (`import { type Foo } from './foo'`).
- **Keep inference intact.** Users should get autocomplete without writing types. Don't widen public types to `unknown` or `any`.
- **Style.** Single quotes, no semicolons, trailing commas in multiline, `===` only, `const` over `let`.
- **No comments in source.** Use clear names and small functions instead.
- **Fix root causes.** No workarounds or compatibility shims.
- **Test behavior, not implementation.** Prefer real integrations over mocks. Every test should protect a behavior or a regression.
- **Ask before changing app-facing APIs.** Anything that changes how developers write app code, config, env vars, routes, or scaffolding needs agreement on the exact API shape first. Open an issue to discuss it.

## Framework versions and scaffolding

The framework versions that `holo new` installs are set in `packages/cli/src/metadata.ts`. Before changing them:

1. Update `packages/cli/src/metadata.ts`.
2. Run `bun run test:smoke:scaffold`. It builds the local packages, runs `holo new` for each framework, installs dependencies, adds and runs a migration, lints, typechecks, builds, and boots each app.
3. Run `bun run test:examples`.
4. Run `bun run check`.

Keep the example apps in `apps/` in line with what new projects get.

## Releases

Merging to `main` runs the Release workflow in `.github/workflows/release.yml`. It runs `bun run release`, which builds the packages, publishes every package whose version is not on npm yet with npm provenance, and pushes a git tag for each published version. The workflow needs an `NPM_TOKEN` repository secret with publish access to the `@holo-js` scope.

`bun run release` replaces `catalog:` and `workspace:*` ranges in the package manifests for the publish and restores the original manifests afterwards, including when the run is interrupted with SIGINT, SIGTERM, or SIGHUP. The versioning rules that releases follow are in [Versioning](/getting-started/versioning).

## Issues and pull requests

Issues and feature requests are tracked in [GitHub Issues](https://github.com/cobraprojects/holo-js/issues). For a bug, include the framework, database, a minimal reproduction, and what you expected. For a larger change, open an issue first so the design can be agreed before you write code.

Pull requests should explain the problem, the fix, and how you tested it.

## Working on the docs

This documentation site is a [VitePress](https://vitepress.dev) project in `apps/docs`. Run `bun run dev:docs` to preview it and `bun run build:docs` to build it. The build checks every code example against the package sources and fails on broken links. Read `apps/docs/STYLE.md` before writing or editing a page.

## Next steps

- [How Holo Works](/advanced/architecture)
- [Writing Plugins](/advanced/plugins)
