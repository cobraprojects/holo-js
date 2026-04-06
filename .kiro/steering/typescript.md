---
description: TypeScript strict typing rules and inference patterns for the Holo-JS monorepo
inclusion: always
---

# TypeScript Standards

## Strict Typing

- `strict: true` is enabled at the root `tsconfig.json` along with `strictNullChecks`, `strictFunctionTypes`, `strictBindCallApply`, `strictPropertyInitialization`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noFallthroughCasesInSwitch`, and `noImplicitOverride`.
- Every package extends the root tsconfig and sets `composite: true` for project references.
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

## Import Conventions

- Use inline type imports: `import { type Foo, bar } from './module'`
- ESLint enforces `@typescript-eslint/consistent-type-imports` with `fixStyle: 'inline-type-imports'`.
- Use `@typescript-eslint/no-import-type-side-effects` to prevent `import type` from importing modules with side effects.

## Generics

- Prefer descriptive generic names: `TRecord`, `TInsert`, `TScopes`, `TFillable` over single letters.
- Constrain generics: `TRecord extends Record<string, unknown>` not just `T`.
- Use conditional types and mapped types to derive precise return types rather than casting.

## Monorepo TypeScript Setup

- Root `tsconfig.json` is the base config with all strict flags and `noEmit: true`.
- Each package (`packages/db`, `packages/core`, `packages/storage`, `packages/shared`) has its own `tsconfig.json` extending the root. They do NOT use `composite: true` — tsup handles the build, not `tsc`.
- Nuxt apps (`playground`, `apps/example-app`) extend Nuxt's auto-generated `.nuxt/tsconfig.json`, NOT the root tsconfig.

### Typechecking Commands

There are two layers of typechecking — library packages and Nuxt apps:

**Library packages** (checked via `tsc -p`):
- `bun run typecheck` — checks all library packages sequentially (`@holo-js/shared`, `@holo-js/db`, `@holo-js/core`, `@holo-js/storage`)
- `bun run typecheck:shared` — checks only `@holo-js/shared`
- `bun run typecheck:db` — checks only `@holo-js/db`
- `bun run typecheck:core` — checks only `@holo-js/core`
- `bun run typecheck:storage` — checks only `@holo-js/storage`
- These run `tsc -p <package>/tsconfig.json --noEmit`

**Nuxt apps** (checked via `nuxi typecheck`):
- `npx nuxi typecheck` from within `playground/` or `apps/example-app/`
- Do NOT use bare `tsc` or `tsc -b` for Nuxt apps — they rely on Nuxt's generated types (auto-imports, path aliases, etc.)
- If `nuxi typecheck` shows missing auto-imports (`defineEventHandler`, `defineNuxtConfig`, etc.), run `npx nuxi prepare` first to regenerate `.nuxt/` types

**Important**: Never run bare `npx tsc` from the root — it picks up everything including Nuxt apps and will produce false errors. Always use the targeted commands above.
