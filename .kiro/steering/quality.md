---
description: Quality gates for linting, type checking, and code style enforced on every change
inclusion: always
---

# Quality Standards

Every code change in this monorepo must meet these standards before being considered complete.

## Type Safety

- All code must be fully typed. No `any` unless absolutely unavoidable and documented with a comment explaining why.
- Use `type` imports (`import type { ... }`) for type-only imports. ESLint enforces this via `@typescript-eslint/consistent-type-imports`.
- All public APIs (exported functions, classes, interfaces) must have explicit return types or rely on inference that produces precise types — never `any` or `unknown` leaking to the consumer.
- Prefer generics and branded types over loose `Record<string, unknown>` when the shape is known.
- Use `noUncheckedIndexedAccess` — always handle the `| undefined` case when indexing arrays or records.

## Linting

- Run `eslint . --fix` or rely on format-on-save before committing.
- Zero ESLint errors allowed. Warnings for `@typescript-eslint/no-explicit-any` are acceptable only in driver internals where Drizzle's runtime types are untyped.
- Unused variables/imports must be removed (prefixed with `_` if intentionally unused parameters).

## After Every Code Change — Mandatory Validation

You MUST run all three checks below after completing each task or subtask. Never skip any of them. Do not consider a task done until all three pass with zero errors.

1. **Diagnostics**: Run `getDiagnostics` on every modified file to catch syntax and semantic issues reported by the language server.
2. **TypeScript**: Run `bun run typecheck` (or `bun run typecheck` for cross-package changes) to verify zero `tsc` errors. `getDiagnostics` alone is not sufficient — the language server can have stale results.
3. **Linting**: Run `npx eslint <changed files> --fix` to verify zero ESLint errors and auto-fix formatting.

If any check fails, fix the errors before moving on. Do not defer fixes to a later task.

4. **Test Coverage**: make sure we always obtain 100% test coverage
5. when running the test use vitest --reporter=json to opitimize the output

## Monorepo Conventions

- Shared dependency versions are centralized in the root `package.json` `workspaces.catalog`. Individual packages use `"catalog:"` instead of hardcoded version strings. When adding or bumping a shared dependency, update the catalog entry and all packages pick it up automatically.
- Workspace packages reference each other via `workspace:*` in `package.json`.
- Root `tsconfig.json` is the base config with strict flags and `noEmit: true`. Package tsconfigs extend it.
- Package tsconfigs do NOT use `composite: true` — tsup handles the JS/DTS build, `tsc` is only used for typechecking.
- Nuxt app tsconfigs extend `.nuxt/tsconfig.json` (not the root) so auto-imports and path aliases resolve correctly.
- ESLint is configured at the root and applies to all workspaces.
- Vitest uses `vitest.workspace.ts` at the root to discover per-package test configs.
- Tests for `@holo-js/db` live in `packages/db/tests/` and use an in-memory SQLite database.

## Code Style

- Single quotes, no semicolons, trailing commas in multiline.
- `1tbs` brace style.
- Type-only imports use inline syntax: `import { type Foo } from './bar'`.
- Prefer `const` over `let`. Never use `var`.
- Use strict equality (`===`) always.
