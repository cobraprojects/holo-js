# Changelog

## Unreleased

- Make `@holo-js/validation` the only public schema-builder package. Remove schema builders from `@holo-js/forms` and remove the `@holo-js/forms/schema` entry.
- Accept `@holo-js/validation` schemas directly in Forms submission helpers and framework form adapters.
- Keep compiled browser validation on the Validation entry and reject the removed Forms schema entry in packaged-export checks.

## 0.3.13

Prepared, not yet published.

- Separate shared browser HTTP error helpers into `@holo-js/adapter-shared/client` and compiler transformations into `@holo-js/adapter-shared/build`. Keep all existing root exports.
- Update Next, Nuxt, and SvelteKit forms and realtime clients to use browser-safe imports, excluding the TypeScript compiler from production browser bundles.
- Import SvelteKit validation helpers through the existing `@holo-js/forms/schema` entry to avoid loading server-side security dependencies.
- Add production Next browser tests against npm tarballs, plus bundle checks for all adapter forms and realtime entries. Cover form validation, submission, native redirects, HTTP errors, root export compatibility, and compiler transformations.
- Compile supported static browser schemas into individual Valibot calls through the existing Next, Nuxt and SvelteKit build integrations. Preserve application APIs, server validation and runtime handling for dynamic schemas. Verify packaged behavior and production blur validation in all three example apps. See [scope and additional measurements](reports/compiled-browser-validation.md).
- Advance the fixed release group of 46 packages to 0.3.13, including catalog ranges, the generated CLI catalog, and the lockfile. Applications keep their existing imports and form code.

See [measurements and release verification](reports/browser-bundle-0.3.13.md).
