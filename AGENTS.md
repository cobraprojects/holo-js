## Principles

These govern every decision — code, architecture, tooling, and process:

1. **Security first** — never introduce vulnerabilities (injection, XSS, OWASP top 10). Validate at system boundaries.
2. **Clean architecture** — proper separation of concerns, protocol-oriented design, dependency injection where appropriate. Every task must consider its impact on architecture and code quality, not just the immediate problem.
3. **Clean code** — self-explanatory naming, early returns over nested conditionals, small focused functions. No comments in the codebase — code must be self-documenting through clear naming and structure.
4. **Root cause fixes** — don't patch symptoms. Diagnose the underlying issue, add logging to debug if needed, then fix the actual cause.
5. **No hacky solutions** — no backward-compatibility shims, no temporary workarounds left in place, no duct tape. If the right fix is harder, do the right fix.
6. **Testability** — if a feature is testable, write tests. When tests fail, fix the source code — never adjust tests to match incorrect output.
7. **Maintainability** — follow existing patterns but offer refactors when they improve quality. Extract into extensions when approaching size limits. Group by domain logic.
8. **Scalability** — design for the project system's open-ended nature.
9. **Testing** - always test behavior rather than implementation details.

## Mandatory Git Cleanup

- Merge only when the user explicitly instructs you to merge.
- After every authorized merge, delete the merged task branch locally and remotely, delete its temporary implementation branches, and remove its task-owned worktrees. This cleanup is mandatory before reporting completion.
- Verify preservation in the target branch before deleting references, including squash merges. If a branch contains additional unmerged work, preserve that work on a clearly named active branch before deleting the obsolete merged branch.
- Preserve the primary checkout and user-owned work. Verify local branches, remote branches, `git worktree list`, and `git status --porcelain`; report any cleanup blocker or remaining uncommitted changes explicitly. Never silently leave merged task branches behind.

# Quality Standards

Every code change in this monorepo must meet these standards before being considered complete.

## User-Facing API Discipline

- write as little code as possible
- Maintainability is a huge concern that we must set in mind while writing code or editing code. 
- Abstraction and the SOLID principle are a key to follow. 
- Require explicit approval before introducing, renaming, removing, or reshaping an API that application developers use in their apps. Propose the exact API shape first. Internal contracts, adapter integration details, and `holoRuntimeInternals` do not require approval merely because they are exported; require approval only if their changes affect an app-facing API or how developers write app code.
- Do not invent helper functions to hide unclear framework behavior. Prefer the framework's native primitives and fix framework adapter integration at the appropriate layer.
- If a change affects how users write app code, configuration, environment variables, routes, middleware, scaffolding, or docs examples, pause and discuss it before editing.
- When the user has already specified an API shape, implement that shape directly. Do not replace it with a different abstraction unless the user approves the alternative first.
- For auth flows specifically, app routes should use each framework's native redirect/navigation APIs. Session cookie side effects belong in the auth/framework integration layer, not in userland redirect helpers.

## Type Safety

- All code must be fully typed. Do not use `any` unless there is no concrete alternative, and document the exception with a comment explaining why.
- Type inference is required for user-facing APIs. If a value, helper, or return type can be expressed with a concrete inferred type, it must be, and it must not be widened to `unknown`, `never`, or `any` just to satisfy the checker.
- `never`, `unknown`, and `any` must not appear in public APIs when a concrete typed alternative exists. They may only appear when they are the correct semantic result or when no safer type shape is possible.
- All public APIs (exported functions, classes, interfaces) must have explicit return types or inference that produces precise types. Do not leak `any` or `unknown` to consumers.
- Use generics and branded types instead of loose `Record<string, unknown>` when the shape is known.
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

4. **Test Coverage**: use coverage as a diagnostic signal, not a target or merge gate. Do not write tests solely to execute lines or branches. Add the smallest set of tests that proves distinct user-visible behavior, failure handling, security boundaries, and high-risk domain logic. Prefer real integrations at system boundaries; use mocks only for external systems that cannot safely or deterministically run in the test environment. A coverage decrease is acceptable when removing duplicate or implementation-focused tests that do not protect behavior.
5. **Test Value**: every test must protect a distinct behavior or regression. Do not duplicate the same scenario across unit, integration, and acceptance layers unless each layer catches a materially different failure. Delete tests that only restate implementation structure, mock the subject under test, or assert source text when runtime behavior can be observed.
6. When running Vitest, use `--reporter=json` to optimize the output.

## Documentation-Only Changes

- If a change only touches documentation or other non-executable text files such as `*.md`, do not run code diagnostics, `bun run typecheck`, or `npx eslint` against those document files by default.
- For documentation-only changes, validate the content itself instead: confirm the wording, file references, commands, and API names match the current documented public surface.
- Only run code-quality or test commands for a documentation-only change when the user explicitly asks for them, or when the documentation change is coupled to executable source changes in the same task.

## Code Style

- Single quotes, no semicolons, trailing commas in multiline.
- `1tbs` brace style.
- Never use `var`.
- Never use `eval` in any code.

# TypeScript Standards

## Strict Typing

- Never use `as any` to silence errors. Fix the type instead. The only exception is Drizzle ORM internals where their runtime types are inherently untyped — annotate those with `// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle runtime` so intent is clear.
- Never use `@ts-ignore` or `@ts-nocheck`. Use `@ts-expect-error` with a comment only when there is a genuine upstream type bug.

## Type Inference for Users

The Holo-JS framework's primary value is that users get full autocomplete and type safety without writing type annotations themselves. This means:

- `defineTable()` columns carry branded type params (`_select`, `_insert`) that flow through to `Holo-JSTable<TSelect, TInsert>`.
- `defineModel(table, options)` infers `TRecord` from the table's `$inferSelect` and threads it through `QueryBuilder<TRecord>`, `Model<TRecord>`, and all static methods.
- `where()`, `orderBy()`, `select()`, `create()` must autocomplete column names as `keyof TRecord & string`.
- Scopes defined in `defineModel({ scopes: { active: q => q.where('status', 'active') } })` must appear as chainable methods on the static model and on QueryBuilder instances with correct parameter types.
- Relation loading via `with('posts')` must produce correctly typed nested models.
- Never break this inference chain. If a new feature requires widening a generic, ensure downstream consumers still get precise types.
- When a test or helper is asserting a type, it must assert the concrete inferred shape. Do not use erased assertions like `AuthorizationPolicyDefinition<string, ...>` when the actual inferred generic arguments are available.
- If a generic helper produces `never` or `unknown` for a value that should be concrete, the helper type must be fixed. Do not silence it with casts or `@ts-expect-error` unless the file is an intentional negative test.

## Generics

- Prefer descriptive generic names: `TRecord`, `TInsert`, `TScopes`, `TFillable` over single letters.
- Constrain generics: `TRecord extends Record<string, unknown>` not just `T`.
- Use conditional types and mapped types to derive precise return types rather than casting.

## Typechecking

- Never run bare `npx tsc` from the root — use the `typecheck` scripts in the root `package.json`.

## Agent skills

### Issue tracker

Track issues and specs in GitHub Issues for `cobraprojects/holo-js`. Read `docs/agents/issue-tracker.md` before ticket operations.

### Triage labels

Use the five default triage labels. Read `docs/agents/triage-labels.md` before triaging issues.

### Domain docs

Use single-context domain docs. Read `docs/agents/domain.md` before exploring domain terminology or architecture decisions.
