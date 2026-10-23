# Versioning

Holo-JS is pre-1.0. This page explains what a version number promises, when a release can break your app, and how to upgrade safely.

This policy applies from `0.4.0`. Earlier `0.3.x` patch releases changed some APIs, and their changelog entries list those changes.

## Version numbers

Holo-JS uses `0.MINOR.PATCH` version numbers.

- A **minor** release, such as `0.3.28` to `0.4.0`, can contain breaking changes. Each one is listed in the [changelog](https://github.com/cobraprojects/holo-js/blob/main/CHANGELOG.md) under the release that ships it, and each app-facing change has a step in the [upgrade guide](/getting-started/upgrading).
- A **patch** release, such as `0.4.0` to `0.4.1`, contains fixes only. It doesn't remove or rename APIs, change config keys, or change what the scaffold generates in a way your app has to adapt to.

Keep every `@holo-js/*` package on the same version. Holo-JS releases all packages together, so one version across them is what gets tested.

::: warning
A patch release can still change behavior that the docs describe as a bug fix, such as stricter validation of malformed input. Read the changelog before you upgrade a production app.
:::

## What counts as a breaking change

In a minor release, Holo-JS can:

- remove or rename an exported function, class, type, or package export
- change a config key's name, type, or default when that changes what your app does
- change a route, CLI command, flag, or file the scaffold generates when your app has to edit to match
- drop a Node.js release line

Holo-JS doesn't treat these as breaking changes:

- fixes that restore behavior the docs already describe
- new options whose default keeps the current behavior
- internal refactors and dependency updates that don't change the supported Node.js versions

## Security fixes

Security fixes ship in the latest release. If a fix needs an application change, it ships in the next minor release with an upgrade step. Read the [security policy](https://github.com/cobraprojects/holo-js/blob/main/SECURITY.md) to report a vulnerability.

## Node.js support

Every package declares its supported Node.js versions in `engines`. Currently that is Node.js 22.18 or newer on the 22 line, and Node.js 24 and 26.

## Next steps

- [Upgrade Guide](/getting-started/upgrading): the steps for each minor release.
- [Installation](/getting-started/installation): the Node.js and package manager versions to install.
