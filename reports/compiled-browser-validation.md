# Compiled browser validation

The existing adapter build integration now compiles supported static Holo schemas into calls to individual Valibot functions. Application schema syntax and useForm imports remain unchanged. Server builds retain the original schema implementation.

The generated browser schema preserves field metadata and uses Holo's existing coercion, required-field handling, confirmation checks and error formatting. Those common runtime behaviors remain in the browser. This does not eliminate all Holo validation runtime code. Valibot implements the primitive validators; the compiler does not introduce a second validator implementation.

## Current scope

Compilation covers top-level constant schemas imported through `@holo-js/validation`, including aliased imports and nested field shapes. Supported chains include string/password, number, boolean and date fields, required/optional/nullable/default, min/max/size, email/URL/UUID/integer, confirmation and the no-argument date rules.

The compiler leaves a schema unchanged when it encounters dynamic arguments, shared builder expressions, callbacks, arrays/files, regex rules or other unsupported syntax. Shared exported schema modules, including the example apps' authentication schemas, compile normally. A shared builder assembled through a function currently uses the runtime path. Applications mixing these paths may still need the full builder runtime. No validator is replaced with a stub or deferred download.

The automatic Next integration runs through existing withHolo configuration in both Webpack and Turbopack browser builds. Nuxt uses its existing module integration, independently of whether realtime is installed. SvelteKit uses the existing Holo Vite plugin; projects without that plugin continue using runtime schemas. Bare Next applications without the Holo build integration continue to work but do not receive this compilation optimization.

The package entry `@holo-js/validation/internal/compiled` is for generated code and framework internals, not a new application authoring API.

## Measurements

Compared the existing 0.3.13 prepared packages against the new tarballs in matching production Next 16.2.4 consumers. Both use withHolo and the same form, server action and routes. Figures include Next's JavaScript, not only Holo.

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| First-load JavaScript, decoded | 474,012 B | 465,852 B | 8,160 B |
| First-load JavaScript, encoded response bodies | 140,967 B | 138,987 B | 1,980 B |
| All emitted JavaScript, uncompressed | 918,459 B | 910,299 B | 8,160 B |
| All emitted JavaScript, gzip | 282,416 B | 280,436 B | 1,980 B |

The first-load reduction is approximately 1.4% of the total compressed page JavaScript. This is additional to the earlier TypeScript compiler boundary fix, which produced the large reduction already reported.

Five interleaved cold Chromium runs per variant used a mobile viewport, 4x CPU slowdown, 1.6 Mbps download and 150 ms network latency. Median FCP was 196 ms before and 196 ms after; observed blocking was 27 ms before and 23 ms after. This small local sample does not demonstrate a meaningful rendering improvement. The blocking measure is a long-task observation, not Lighthouse TBT or field INP. Raw runs are in compiled-form-performance.json.

## Verification

- Fresh npm-tarball consumer: production browser bundles exclude TypeScript and other build dependencies.
- Packaged original and generated schemas return identical results for 11 cases covering valid input, required errors, format errors, password confirmation, coercion, numeric bounds, nested fields and defaults. Field metadata and frozen rule arguments match.
- A compiled email-only bundle excludes unused URL, UUID and regex validators and the fluent builder. Dynamic and malformed schemas are left unchanged.
- Packaged production Next form: validation, successful server submission, redirects and HTTP error handling pass.
- Production Next, Nuxt and SvelteKit example apps: login/register blur errors appear and clear correctly, with no validation POST requests and no browser exceptions. Next's app build exercises Turbopack; the packaged fixture exercises Webpack.
- All 49 tested workspaces pass: 4,177 Vitest tests passed, zero failed, 11 skipped. The packaged compiler comparisons and real-browser checks run separately.
- Packaged scaffold smoke tests pass for all three frameworks, including full, minimal and reported package selections.
- Full repository build, TypeScript checking, language-server diagnostics, changed-file ESLint and dependency/documentation policies pass.

Reproduce packaged checks with `node scripts/validate-browser-bundle.mjs` and real-app checks after building the examples with `node scripts/validate-form-blur.mjs`.

## Release state

The prepared release remains 0.3.13; npm still reports 0.3.12 as latest. Publication and a registry-installed consumer verification remain blocked because `npm whoami` returns HTTP 401. The new checks use the actual prepared npm tarballs, not source aliases. Once npm authentication is restored, follow the existing release command and registry consumer verification described in browser-bundle-0.3.13.md.
