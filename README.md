# actorium

[![CI](https://github.com/c0m1t/actorium/actions/workflows/ci.yml/badge.svg)](https://github.com/c0m1t/actorium/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@actorium/xstate-otel)](https://www.npmjs.com/package/@actorium/xstate-otel)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Observability tools for [XState](https://stately.ai/docs) actor systems.

| Package                                         | Description                                           |
| ----------------------------------------------- | ----------------------------------------------------- |
| [`@actorium/xstate-otel`](packages/xstate-otel) | OpenTelemetry tracing for long-lived XState v5 actors |

Documentation: [c0m1t.github.io/actorium](https://c0m1t.github.io/actorium/).

## Showcase

[`packages/xstate-otel/examples/showcase`](packages/xstate-otel/examples/showcase) is an order desk that runs each
tracing feature as a scenario and draws the resulting traces in the browser:

```sh
pnpm install
pnpm --filter @actorium/xstate-otel-showcase start   # http://localhost:3000
```

The [Showcase guide](https://c0m1t.github.io/actorium/xstate-otel/guide/showcase) also includes
an interactive viewer of traces recorded during the documentation build.

## Development

Requires the pnpm version pinned in `package.json`. `pnpm install` downloads the Node.js version
pinned in `devEngines.runtime`, and pnpm runs every script on it. The published package supports
Node.js 24 or later.

```sh
pnpm install
pnpm run check              # lint, format, types, tests, build, package and docs checks
pnpm run docs:dev           # documentation site with live reload
pnpm run test:compatibility # XState × OpenTelemetry API matrix
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Report vulnerabilities privately as described in
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
