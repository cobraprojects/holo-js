# Holo-JS Docs Style Guide

These rules apply to every page in `docs/`.

## Audience

The reader is a JavaScript developer who knows their framework (Next.js, Nuxt, or SvelteKit) but is new to Holo-JS. Many readers will know Laravel or Rails; few will know Holo internals. Write for the person trying to get something working, not for the framework maintainer.

## Page shape

Every feature page follows this order. Skip a part only when it truly does not apply.

1. `# Title` — the feature name in plain words ("Sending Mail", not "Mail Dispatch Runtime").
2. A 1–3 sentence intro: what this is and when you'd use it. No history, no internals.
3. **The shortest working example** — before any explanation of options. The reader should be able to copy it and see it work.
4. Explanation sections (`##`), ordered from most common task to least common.
5. Reference material (options tables, all methods) near the end.
6. A short `## Next steps` (or `## Related`) with 2–5 links.

Pages that are pure reference (CLI, config) can be tables and lists.

## Voice

- Second person, present tense, active voice: "Run `npx holo migrate` to apply migrations."
- Short sentences. One idea per paragraph. Paragraphs of 1–4 sentences.
- Headings are tasks or nouns a user would search for: "Retry failed jobs", "Eager loading". Not "Behavior notes" or "Ownership".
- Explain *why* only when it changes what the reader does.
- Never use internal jargon in user pages: avoid "owns", "seam", "adapter-owned", "canonical", "machine-owned", "runtime composition", "finalization". Say what happens instead ("Holo regenerates this folder; don't edit it").
- Do not repeat the same caveat in multiple places on a page. Put it once in a `::: warning` box.
- No marketing fluff ("blazing fast", "seamless", "powerful").

## Code examples

- Every example must be real, correct code using APIs that exist in `packages/*/src`. Verify every import path, function name, option name, and CLI flag against the source. If you can't verify something, leave it out.
- Prefer full, runnable snippets with imports. Add a filename title: ` ```ts [server/models/Post.ts] `.
- TypeScript, single quotes, no semicolons, trailing commas in multiline — matching the repo style.
- Use realistic domain names (`Post`, `User`, `Order`, `sendWelcomeEmail`), never `foo`/`bar`.
- Keep examples small. Show one concept per block.

### CLI commands

Write CLI commands once, with `npx`:

```bash
npx holo make:model Post --migration
```

Do **not** add package-manager tabs (npm/pnpm/yarn/bun) for each command. The Installation page and CLI reference explain how to run `holo` with other package managers. The only exception is the `create holo-js` command on the Installation and Quick Start pages.

### Framework-specific code

When code differs per framework, use a code group with exactly these tab labels, in this order — the site remembers the reader's choice across pages:

````md
::: code-group

```ts [Next.js]
// app/api/posts/route.ts
```

```ts [Nuxt]
// server/api/posts.get.ts
```

```ts [SvelteKit]
// src/routes/api/posts/+server.ts
```

:::
````

Put the file path in a comment on the first line inside each tab. Only use framework tabs when the code actually differs.

## Callouts

Use VitePress containers sparingly:

- `::: tip` — a shortcut or best practice.
- `::: warning` — something that will bite you (data loss, security, production gotchas).
- `::: danger` — only for security-critical rules.
- `::: info` — optional background.

At most ~3 callouts per page.

## Links

- Link to other pages with absolute paths without `.md`: `[migrations](/database/migrations)`.
- Only link to pages that exist in the sidebar (see `docs/.vitepress/config.mts`).
- First mention of another feature on a page should link to it.

## Accuracy over coverage

If the docs and the source code disagree, the source code wins. Never invent APIs, options, or flags. When a feature exists in source but has no docs, document it from the source and its tests (`packages/*/tests`), which show real usage. The example apps in `apps/blog-next`, `apps/blog-nuxt`, and `apps/blog-sveltekit` show real app code.
