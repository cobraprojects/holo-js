---
name: clawpatch
description: Review this repo with the Clawpatch CLI, create new findings, fix findings, revalidate them, triage their status, and continue finding the next issue. Use when the user asks to run clawpatch, review/fix Clawpatch findings, process all findings, or run a Clawpatch issue-fixing campaign.
---

# Clawpatch

Use Clawpatch as a review queue, not just a patch generator. The loop is:
review for new findings, inspect findings, fix valid ones, validate locally, ask Clawpatch to revalidate, triage, then ask for the next finding.

## Commands

Run from repo root.

```sh
clawpatch doctor --json
clawpatch status --json
clawpatch review --limit <n> --jobs <n> --json
clawpatch report --status open --json
clawpatch next --json
clawpatch show --finding <id> --json
clawpatch fix --finding <id> --json
clawpatch revalidate --finding <id> --json
clawpatch triage --finding <id> --status fixed --note "<short validation note>" --json
```

Use `--limit` for batches. Prefer `--jobs 3` to `--jobs 5` for broad repo review unless the user asks for more parallelism.

If a provider-backed Clawpatch command fails with a Codex app-server or permission error inside the sandbox, rerun that same command with escalated execution.

## Review Loop

1. Check state.
   - Run `clawpatch doctor --json`.
   - Run `clawpatch status --json`.
   - Run `git status --short --untracked-files=all`.
   - Do not overwrite unrelated dirty files. Treat pre-existing edits as user work.
2. Generate findings.
   - Run `clawpatch review --limit <n> --jobs <n> --json`.
   - Use a small batch first, usually `--limit 10 --jobs 3`.
   - If the user wants everything, repeat review batches after the current queue is fixed or triaged.
3. Select work.
   - Run `clawpatch report --status open --json`.
   - Use `clawpatch next --json` for the highest-priority next item.
   - Use `clawpatch show --finding <id> --json` before editing.
4. Confirm the finding.
   - Read the evidence files and relevant tests.
   - Confirm the bug or test gap independently.
   - If the finding would require a public API/config/route/docs shape change, stop and propose the exact API shape before editing.
5. Fix.
   - Prefer manual, repo-native patches for anything subtle.
   - Use `clawpatch fix --finding <id> --json` only after checking the worktree and the finding scope.
   - Keep fixes scoped to the finding and its regression tests.
6. Validate.
   - Run `getDiagnostics` for every modified source file when the tool is available.
   - Run `bun run typecheck`.
   - Run `npx eslint <changed files> --fix`.
   - Run targeted Vitest tests with `--reporter=json`.
   - Run coverage for the affected package when tests changed or coverage risk exists; this repo expects 100% coverage.
7. Revalidate and triage.
   - Run `clawpatch revalidate --finding <id> --json`.
   - If Clawpatch agrees the issue is fixed, run `clawpatch triage --finding <id> --status fixed --note "<what passed>" --json`.
   - If it is wrong, mark `false-positive` with evidence.
   - If the fix is unsafe or needs user/API approval, mark neither fixed nor false-positive; explain the blocker.
8. Continue.
   - Run `clawpatch next --json`.
   - If no open findings remain, run another `clawpatch review --limit <n> --jobs <n> --json` batch.

## Parallel Fixing

Use workers only when the user has authorized parallel work and findings have disjoint write scopes.

Before spawning workers:

- Group findings by owned files from `clawpatch show`.
- Do not assign two workers to the same file or package test fixture.
- Keep broad config/package-script findings local unless their write set is isolated.
- Tell each worker it is not alone in the codebase and must not revert others' edits.
- Give each worker exact finding ids and owned files.

Worker task shape:

```text
Fix Clawpatch finding <id>. Own only: <paths>.
Read `clawpatch show --finding <id> --json`, confirm the finding, patch the smallest safe scope, add regression tests, run targeted validation with Vitest `--reporter=json`, and report changed files plus validation results.
Do not revert unrelated changes.
```

The parent agent remains responsible for final integration, root validation, Clawpatch revalidation, and triage.

## Holo-JS Defaults

This repo uses Bun and strict TypeScript.

- Use `bun run typecheck`, not `npm run typecheck`.
- Use `npx eslint <changed files> --fix` for changed executable files.
- Use Vitest with `--reporter=json`.
- Preserve user-facing API shape unless the user approved the exact change.
- Preserve type inference; do not patch with `any`, `unknown`, or erased generic types unless that is semantically required and documented.
- Respect `noUncheckedIndexedAccess`.
- For docs-only changes, do not run code diagnostics/typecheck/eslint unless coupled to source edits.

## Config

Keep `.clawpatch/config.json` aligned with this repo:

```json
"commands": {
  "typecheck": "bun run typecheck",
  "lint": "bun run lint:fix",
  "format": null,
  "test": "bun run test"
}
```

Clawpatch validation commands are coarse-grained hints. Always run the targeted validation required by the changed files before marking a finding fixed.
