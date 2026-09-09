# Valibot tree-shaking experiment

Question: can Holo preserve its fluent schema API and remove unused validators by replacing the rule interpreter with direct Valibot composition?

Result: direct composition alone does not achieve that goal. The tested class wrapper still retains validators referenced by unused methods. No production implementation was changed by this experiment.

| Variant | Minified bytes | Gzip bytes | Unused URL/UUID/regex retained |
| --- | ---: | ---: | --- |
| Direct Valibot, namespace import | 3,609 | 1,459 | No |
| Direct Valibot, named imports | 3,609 | 1,459 | No |
| Fluent class, direct Valibot composition | 5,166 | 1,785 | Yes |
| Fluent class with unused methods manually deleted | 3,790 | 1,526 | No |

The last variant is a counterfactual control, not a viable fix: deleting supported methods would violate the existing API. Namespace imports are not the cause in this experiment. The bundler can eliminate unused Valibot functions when the calling code makes that possible.

These are small standalone esbuild browser bundles for required/email validation, not Holo form bundles or Next page measurements. They exclude Holo metadata, server rules, form state, submission, redirects and error handling. Their sizes cannot establish a production saving or full compatibility. The prototype does not replace Holo forms.

All four variants pass valid email, empty string, whitespace, invalid email, incorrect type and missing field cases (24 checks). Prototype TypeScript, language-server diagnostics and ESLint pass. This tests the proposed dependency structure, not full form behavior.

Holo's metadata and form integration still serve a purpose. The generic rule interpreter and fluent methods make more validator code reachable than an individual schema uses. A production solution must address that reachability while preserving metadata and behavior; simply rewriting the interpreter in terms of Valibot is insufficient. Build-time schema specialization could be investigated separately, but this experiment does not establish its safety or value.

Run from this directory with installed Holo dependencies:

```sh
HOLO_SOURCE_ROOT=/Users/cobra/Code/holo-js node run.mjs
```

Reference: [Valibot comparison](https://valibot.dev/guides/comparison/) explains modular functions and bundler tree shaking; [internal architecture](https://valibot.dev/guides/internal-architecture/) describes its independent factories.

Prototype location: `/tmp/holo-validation-prototype/prototypes/validation-tree-shaking`, branch `codex/validation-tree-shaking-prototype`.
