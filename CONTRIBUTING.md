# Contributing

Thanks for helping. Open an issue before large changes so the approach can be agreed first.
Report security problems privately as described in [SECURITY.md](SECURITY.md).

## Setup

Requires pnpm (the version is pinned in `packageManager`). `pnpm install` downloads the Node.js version pinned in `devEngines.runtime`, and pnpm runs every
script on it, whatever Node.js is installed. Raise that pin by editing it and running
`pnpm install`. The published package supports Node.js 24 or later.

```sh
pnpm install
pnpm run check
```

## Commands

| Command                       | Does                                                                              |
| ----------------------------- | --------------------------------------------------------------------------------- |
| `pnpm run check`              | everything CI runs: lint, format, types, tests, build, package, unused code, docs |
| `pnpm run format`             | format all files                                                                  |
| `pnpm run test`               | unit, type and showcase tests                                                     |
| `pnpm run check:package`      | pack the library and test the tarball as a consumer                               |
| `pnpm run docs:dev`           | documentation site with live reload                                               |
| `pnpm run test:compatibility` | tests against each supported XState × OpenTelemetry API pair                      |

API source references link to the commit checked out for the documentation build,
including builds made from tags.

## Pull requests

- Add or update tests for behaviour changes, and update the one docs page that owns the fact.
- A change to the published declarations updates the `tests/public-api.test.ts` snapshot; say
  why in the description.
- PRs are squash-merged, and the PR title becomes the changelog entry, so it must be a
  [Conventional Commit](https://www.conventionalcommits.org/): `feat: …`, `fix: …`, `perf: …`,
  `docs: …`, `refactor: …`, `test: …`, `build: …`, `ci: …` or `chore: …`, with `!` for a breaking
  change (`feat!: …`).

## Releases

[release-please](https://github.com/googleapis/release-please) keeps a release PR open with the
next version and `CHANGELOG.md`, built from `feat`, `fix`, `perf` and breaking-change titles.
Merging it tags the release and publishes to npm from `release.yml` through trusted publishing.
Nobody bumps versions or writes changelog entries by hand.
