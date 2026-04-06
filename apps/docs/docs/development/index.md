# Application Development

This section is for teams building applications with Holo-JS.

It is not the contributor guide for working on the Holo-JS monorepo itself.

Use it when you are setting up a local app, choosing env files, running discovery, preparing the
database, and keeping your everyday commands reliable.

If you are changing packages inside the Holo-JS repository, testing candidate framework versions, or
updating scaffold metadata, use the contributor guide instead:

- [Contributing to Holo-JS](/development/contributing)

## Recommended local loop

For most Holo-JS apps, the healthy loop is:

1. edit `config/*.ts` and env files deliberately
2. let `holo dev` keep discovery artifacts current
3. run migrations and seeders explicitly
4. build features against real models, routes, and storage APIs
5. run validation commands before merge

## Core commands

```bash
holo dev
holo build
holo prepare
holo config:cache
holo config:clear
bun run typecheck
bun run lint
bun run test
```

`holo dev` already runs discovery before starting the selected framework. `holo prepare` is the manual
discovery command when you need generated artifacts refreshed without launching dev or build.

## What this section covers

- [Development Workflow](/development/workflow)
- [Contributing to Holo-JS](/development/contributing)
- [Testing](/testing)
- [Deployment](/deployment)
- [Configuration](/configuration)
