# Contributing

Thanks for helping improve Holo-JS. This page is for working on the framework itself, in the [holo-js repository](https://github.com/cobraprojects/holo-js). If you're building an app with Holo, start with the [Quick Start](/getting-started/quick-start) instead.

## Set up the repository

The monorepo uses [Bun](https://bun.sh) for installs and scripts.

```bash
git clone https://github.com/cobraprojects/holo-js.git
cd holo-js
bun install
bun run build
bun run setup:examples
```

`bun install` only installs dependencies. The example apps run the `holo` CLI, so `bun run build` builds every package first. `bun run setup:examples` then runs each example app's `setup` script, which generates its `.env` keys, installs broadcast support, prepares its framework files, and runs `holo migrate`. Migrating creates the app's SQLite database and writes its generated schema from it, so the app's models are typed and `bun run --cwd apps/blog-next typecheck` passes. Pass app names to set up only some of them, for example `bun run setup:examples blog-next`. Run it again after a rebuild or a `git clean` that removes the generated files.

`bun run test:contributor-setup` clones your current commit into a temporary folder, runs these steps there, and then runs one package's tests, the same way CI does.

### Services the test suite needs

The full test suite runs against real databases and Redis:

| Service | Expected setup |
| --- | --- |
| PostgreSQL | Port `5432`, user `postgres` |
| MySQL | Port `3306`, user `root`, empty password |
| Redis | Port `6379`, plus the `redis-server` executable on your `PATH` |
| Chromium | `bun x playwright install chromium` (add `--with-deps` on Linux) |

### Tests against real PostgreSQL and MySQL

Tests that need a real server run only when their integration flag is set, and only against a scratch database you name:

```bash
HOLO_POSTGRES_INTEGRATION=1 HOLO_POSTGRES_DATABASE=holo_scratch \
HOLO_MYSQL_INTEGRATION=1 HOLO_MYSQL_DATABASE=holo_scratch \
bun run --cwd packages/db test
```

Create the scratch database first. `bun run test:libraries` creates and drops its own. Without a flag, those tests skip. A database name must be letters, digits and underscores, and never a system database such as `postgres` or `mysql`.

When you write such a test, take everything from `tests/support/real-database.ts`:

- Gate it with `integrationDrivers()`, `postgresIntegration` or `mysqlIntegration`.
- Connect with `postgresTestConnection()`, `mysqlTestConnection()` or `testConnectionUrl()`. Never read `HOLO_POSTGRES_*` or `HOLO_MYSQL_*` connection variables yourself.
- In `packages/db`, `openDatabase()` from `tests/support/database.ts` does both and drops its fixture table afterwards.

Two checks enforce this:

- **Real-database gating (authoritative).** `bun run test:real-database-gating` runs every test that can reach PostgreSQL or MySQL with the integration flags removed and no server reachable. Any test that connects instead of skipping fails it, however it is written.
- **Architecture validation (best effort).** `node scripts/validate-architecture.mjs` reads test sources and catches the common mistakes early: connection variables read directly, system database names, and connections built without the shared helpers. A source check can't be complete, so the gating job is the final word.

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
| `bun run build` | Build every library package. |
| `bun run setup:examples` | Set up the example apps once the packages are built. |
| `bun run typecheck` | Typecheck every library package and the tests. |
| `bun run lint` | Run ESLint across the repo. |
| `bun run lint:fix` | Lint and auto-fix. |
| `bun run audit:dependencies` | Fail on moderate or higher advisories in any locked package, unless an unexpired entry in `audit-exceptions.json` covers them. |
| `bun run audit:runtime` | Report dependency advisories; fail on high or critical advisories reachable from published packages. |
| `bun run check:dead-code` | Fail on new Fallow findings against the committed baseline. |
| `bun run --cwd packages/<name> test` | Run one package's tests while you work. |
| `bun run test:libraries` | Run every library test suite against the real services. |
| `bun run test:contributor-setup` | Clone the current commit into a temporary folder, run the documented setup there, and run one package's tests. |
| `bun run test:real-database-gating` | Run every PostgreSQL and MySQL test without integration flags or servers, and fail if any of them connects instead of skipping. |
| `bun run test:examples` | Run the Next.js, Nuxt, and SvelteKit example apps against SQLite, PostgreSQL, and MySQL. |
| `bun run test:ci` | `test:libraries` plus `test:examples`. |
| `bun run test` | `test:ci` plus published-package, scaffold, and browser-bundle checks. Run it locally before a release and for changes to adapters, the CLI scaffold, or packaging. |
| `bun run test:platform` | Native package loading and server lifecycle tests. |
| `bun run test:coverage` | Coverage report, for finding untested behavior. |
| `bun run check` | Typecheck, lint, and `test:ci`. |

The CLI's package-manager tests run real `npm`, `pnpm`, and `yarn` installs, so those tools must be on your `PATH`. CI installs pnpm 10.34.7 and yarn 1.22.22 with npm. Install the same versions locally to run them.

To run one example app against one database, set `HOLO_TEST_FRAMEWORK` to `next`, `nuxt` or `sveltekit` and `HOLO_TEST_DRIVER` to `sqlite`, `postgres` or `mysql`. Each run sets up only the database server for its driver, so `HOLO_TEST_DRIVER=sqlite bun run test:examples` needs neither PostgreSQL nor MySQL.

## Before you push

Run `bun run check` before you push. Running one package's tests is fine while you edit, but it doesn't replace `check` for changes to shared packages.

CI runs the critical checks on every pull request: library and test typechecks and lint on Node 24, every library test suite against real services on each supported Node version (22.18.0, 24, and 26), the dependency audit and dead-code gate, the real-database gating check, the documented contributor setup in a fresh clone, native package loading and server lifecycle checks on Linux, Windows, and macOS with the same Node versions, the published-package, scaffold, and browser-bundle acceptance checks, and each example app against SQLite, Postgres, and MySQL. Run `bun run test` locally to cover the same suites, and `bun run test:contributor-setup` for changes to the setup steps or the example apps' scripts.

The scaffold acceptance check installs each scaffolded app with npm, so a package published to npm moments ago can't change or break it. npm only picks versions published on or before the last commit that changed `bun.lock`, and it reads packages from the local npm cache first, which CI keeps between runs. The check needs the full git history to find that commit, and it uses the current time while `bun.lock` has uncommitted changes. With a warm cache it passes with the registry unreachable. The separate Scaffold smoke against the live npm registry workflow, in `.github/workflows/scaffold-live-registry.yml`, runs the same check every night and on demand with `HOLO_SCAFFOLD_SMOKE_LIVE_REGISTRY=1`. That setting turns off the date limit, so npm installs the newest published versions, the way a new app would get them. A failure there points at a new dependency release, not at the pull request.

CI splits the library suites into three jobs per Node version by running `bun run test:libraries --skip-build --shard <n>/3` after it builds the packages. Each package stays whole, and the split balances the measured durations in `scripts/library-suite-durations.json`, so a package missing from it still runs. Update a package's entry when its tests get much slower or faster.

The dependency job runs `bun run audit:dependencies`. Every advisory of moderate or higher on any package in the lockfile fails the job, including versions used only by examples, docs, or tooling. Advisories covered by an unexpired exception are reported as `EXCEPT` and do not fail it. `bun run audit:runtime` keeps the narrower published-package rule for local checks: only high and critical advisories reachable from published packages block. A failed registry request or invalid report fails the audit.

When a blocking advisory has no patched release, add a time-boxed entry to `audit-exceptions.json` with the advisory URL, the exact package and version, the reason it is reachable, and an `expires` date. Excepted advisories are reported as `EXCEPT` until that date, then block again. An exception that no longer matches a blocking advisory also fails the audit, so remove entries once the dependency is patched. Low-severity advisories are reported but never fail the audit, so they do not belong in this file. An invalid exceptions file fails the audit.

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

Keep the example apps in `apps/` in line with what new projects get, with one exception: new projects run their setup from the `prepare` script, and Nuxt projects also run `nuxt prepare` from `postinstall`. The example apps run the same commands from a `setup` script instead, because the `holo` CLI and the adapters they need don't exist until `bun run build` has run. Don't add install lifecycle scripts to the example apps.

## Releases

Merging to `main` runs the Release workflow in `.github/workflows/release.yml`. Its `ci` job waits until every required CI workflow (Quality gates, Library tests, Node platform compatibility, and App and acceptance suites) has finished for that commit, and fails if any of them failed or was cancelled. Only then does the publish job build the packages, run `bun run release:skip-build`, which publishes every package whose version is not on npm yet with npm provenance, and push a git tag for each published version. The publish job runs only for `main` and declares the `release` environment. Publishing needs an `NPM_TOKEN` secret with publish access to the `@holo-js` scope, stored as a secret of the `release` environment rather than a repository secret. While that secret is missing, the publish step fails if any package version is not on npm yet, so a due release is never skipped silently. It logs a notice and succeeds only when every version is already published. Only the publish step receives the token.

Repository owners must create the `release` environment in the GitHub repository settings, with these rules:

- Required reviewers, so a person approves each publish.
- Deployment branches limited to `main`, so a workflow run from another branch cannot read the token.
- The `NPM_TOKEN` secret, stored in that environment.

The workflow checks the ref too, but a branch can change its own workflow file, so the environment rules are the control that protects the token.

`bun run release` replaces `catalog:` and `workspace:*` ranges in the package manifests for the publish and restores the original manifests afterwards, including when the run is interrupted with SIGINT, SIGTERM, or SIGHUP. The versioning rules that releases follow are in [Versioning](/getting-started/versioning).

## Issues and pull requests

Issues and feature requests are tracked in [GitHub Issues](https://github.com/cobraprojects/holo-js/issues). For a bug, include the framework, database, a minimal reproduction, and what you expected. For a larger change, open an issue first so the design can be agreed before you write code.

Pull requests should explain the problem, the fix, and how you tested it.

## Working on the docs

This documentation site is a [VitePress](https://vitepress.dev) project in `apps/docs`. Run `bun run dev:docs` to preview it and `bun run build:docs` to build it. The build checks every code example against the package sources and fails on broken links. Read `apps/docs/STYLE.md` before writing or editing a page.

## Next steps

- [How Holo Works](/advanced/architecture)
- [Writing Plugins](/advanced/plugins)
