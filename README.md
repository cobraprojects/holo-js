# Holo-JS Framework

## About Holo-JS

Holo-JS is a backend framework for Nuxt, Next.js, and SvelteKit applications. It gives your app a typed backend layer while letting your framework keep owning routing, rendering, deployment, and framework-native APIs.

Holo-JS provides tools commonly needed by full-stack applications, including:

- typed configuration and environment loading
- database models, migrations, seeders, and factories
- storage and media workflows
- auth, authorization, sessions, and security primitives
- events, queues, notifications, mail, broadcasting, and realtime features
- a project CLI for scaffolding and operational commands

Holo-JS is built for teams that want backend conventions without giving up the Nuxt, Next.js, or SvelteKit application model.

## Learning Holo-JS

The Holo-JS documentation is available at [docs.holo-js.com](https://docs.holo-js.com/). It covers installation, configuration, framework integration, database usage, auth, queues, storage, deployment, and the CLI.

To create a new project, run:

```bash
npm create holo-js@latest my-app
```

You can also start with another package manager:

```bash
pnpm create holo-js@latest my-app
yarn create holo-js my-app
bun create holo-js@latest my-app
```

Start the app:

```bash
cd my-app
npm run dev
```

Use the Holo CLI through your package manager when you need backend commands:

```bash
npx holo list
npx holo migrate
npx holo seed
```

## Contributing

Thank you for considering contributing to Holo-JS. Contribution notes and development workflow documentation are available in the [documentation](https://docs.holo-js.com/development/contributing).

## Security Vulnerabilities

If you discover a security vulnerability in Holo-JS, please report it privately instead of opening a public issue.

## License

Holo-JS is open-sourced software licensed under the [MIT license](https://opensource.org/licenses/MIT).
