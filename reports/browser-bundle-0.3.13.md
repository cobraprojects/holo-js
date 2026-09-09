# Browser bundle regression: 0.3.13

0.3.13 is prepared locally. It has not been published. All 46 packages in the fixed release group were checked against npm and were at 0.3.12 before versioning.

## Cause and fix

`@holo-js/adapter-next/client` imported client error helpers through the shared package root. That root imported TypeScript for realtime source transformations. Next's production compiler consequently included the TypeScript compiler in browser JavaScript. Nuxt and SvelteKit had equivalent shared-root client imports, including realtime clients.

The shared package now has separate `./client` and `./build` entries. The original root re-exports both, preserving every existing export. Adapters use the explicit entry appropriate to their execution environment. The build still uses the real TypeScript compiler. No compiler stubs, deferred downloads, or application form replacements were introduced.

The packaged SvelteKit check also caught runtime imports from the forms root that reached server-side security code. Those helpers now come from the existing `@holo-js/forms/schema` entry. Type-only imports remain type-only.

## Measurements

Both runs use the same minimal Next.js 16.2.4 application with a client `useForm` import, a named input, a server action, and a redirect destination. Framework packages are built from source, packed with npm, and installed in a temporary consumer outside the monorepo. The baseline is commit `cd5fa9d1623fb5de1f1380ac0cc610adb25e690b`, version 0.3.12. Its tarballs were captured before editing the framework.

| Measurement | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| All emitted browser JavaScript | 4,371,786 B | 918,597 B | 3,453,189 B, 78.99% |
| Sum of gzip-compressed files | 1,260,305 B | 282,521 B | 977,784 B, 77.58% |
| TypeScript in browser compilation | Present | Absent | Removed |

These totals cover all `.js` files under `.next/static`, including framework assets and both routes. They are not homepage transfer measurements or compiler-only sizes. Gzip uses Node's default compression, calculated separately for each file. Production uses Next's webpack build mode. The [raw measurements](browser-bundle-0.3.13.json) include individual chunk sizes.

The baseline test fails with `Production browser compilation includes the TypeScript compiler`. The fixed test passes. Webpack module reporting includes cached and nested modules so rebuilding cannot hide compiler imports from the assertion.

## First-page cost after the fix

The emitted-file totals above are not first-page downloads. A separate cold Chromium browser measurement captured only JavaScript actually fetched by the homepage. The baseline keeps the same Next version, dependency installation, layout, and redirect route, but replaces the form with a client component containing a paragraph.

| First-page JavaScript | Without forms | With Holo forms | Increment |
| --- | ---: | ---: | ---: |
| Decoded bytes | 425,260 B | 474,150 B | 48,890 B |
| Compressed response-body bytes | 126,454 B | 141,072 B | 14,618 B |

These figures use Resource Timing `decodedBodySize` and `encodedBodySize` after network idle in separate browser contexts. They exclude HTML, RSC response data, HTTP headers, and subsequent interactions. The increment includes the fixture's form UI and server-action reference as well as Holo code. See the [captured first-page resources](browser-first-load-0.3.13.json).

A separate minified esbuild bundle exporting `useForm`, `schema`, and `field`, with React external, measured 50,574 B or 15,044 B gzip. Its output contributions included 22,978 B from Holo validation, 7,971 B from Valibot, and 11,856 B from the form client. This is a dependency diagnosis, not an equal-feature comparison with another library.

See [the comparison with other validation packages](form-validation-approaches.md) for options that keep schemas on the server. No further form API or behavior changes were made for that investigation.

## Verification

- Full workspace builds, repository typechecking, changed-file ESLint, language-server diagnostics, and dependency-policy checks passed.
- 386 existing forms and adapter tests passed, including validation, submission, redirects, HTTP errors, and realtime transformations.
- The clean consumer's production browser test passed local validation, server-action submission, native Next redirect navigation, and client HTTP error rendering.
- All seven packaged entries passed the browser dependency check: shared client plus Next, Nuxt, and SvelteKit client and realtime entries. It bundles Holo tarball exports without source aliases. Host framework imports are external in this cross-adapter check; the separate Next production build bundles the framework normally.
- Packaged root exports retain runtime identity with the new entries. Packaged compiler tests cover handler removal, handler preservation, source-map content, and malformed-input rejection.

Run `bun run test:smoke:browser-bundle` to build libraries and repeat the tarball consumer test. Install the test browser with `npx playwright install chromium` if needed. The test also runs within `test:acceptance`. Temporary consumers retain the production output, module list, and measurement report for inspection.

## Release and upgrade

Versioning used `bun run version-packages` and `bun install --lockfile-only`. The repository disables automatic Changesets changelog generation, so the release notes are recorded in the root changelog. The 46-package fixed group, root dependency catalog, and generated CLI catalog are all at 0.3.13.

Publishing requires working npm credentials with publish access. The current `npm whoami` request fails with HTTP 401. Once credentials are restored, run the repository release command:

```sh
bun run release
```

Then verify the registry release in a fresh consumer:

```sh
HOLO_BROWSER_BUNDLE_VERSION=0.3.13 bun run test:smoke:browser-bundle
```

Registry installation of 0.3.13 remains pending publication. The successful consumer verification so far used the prepared npm tarballs.

After publication, upgrade the Holo packages already installed in the application to 0.3.13. For a Next forms application:

```sh
bun add @holo-js/adapter-next@0.3.13 @holo-js/forms@0.3.13
```

Also update any other installed Holo packages, refresh the application's lockfile, and rebuild for production. Keep `import { useForm } from '@holo-js/adapter-next/client'` and all existing form code. The adapter dependency range requires the fixed shared package automatically; applications do not need to add new imports or configuration.
