# actorium

pnpm workspace for OpenTelemetry tracing of XState v5 actors:

- `packages/xstate-otel`: the published library. Its
  [AGENTS.md](packages/xstate-otel/AGENTS.md) holds the runtime, XState-semantics and public-API
  rules; read it before changing the library.
- `docs/`: the VitePress site. `packages/xstate-otel/examples/showcase`: the demo app.
- `scripts/`: helpers shared by package scripts.

pnpm runs everything on the Node pinned in `devEngines.runtime`, locally and in CI; the library
supports Node 24 or later (`engines.node`).

## Commands

- `pnpm run check`: lint, format, types, tests, build, package, unused code and docs.
- `pnpm run format`: format all files.
- `pnpm run test:compatibility`: the XState × OTel API matrix; `--xstate` and `--api` pick rows.

## Pull requests

- PRs are squash-merged and the title becomes the changelog entry, so it is a Conventional
  Commit (`feat`, `fix`, `perf`, `docs`, `refactor`, `test`, `build`, `ci` or `chore`; `!` for a
  breaking change). See [CONTRIBUTING.md](CONTRIBUTING.md#pull-requests).

## Writing

- Keep docs and PR descriptions short. Docs describe current behaviour only.
- Each fact has one owning docs page; update it and link to it instead of copying.
- Never add handoff, summary or status files.
