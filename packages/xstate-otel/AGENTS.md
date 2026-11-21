# @actorium/xstate-otel

The published library. `src/core/` is the lifecycle runtime, `src/otel/` the only
OpenTelemetry code and `src/xstate/` the only private XState access. `scripts/` holds
`check:package` and `test:compatibility`.

## Runtime

- Preserve runtime semantics: mailbox ordering, completion handoff, cancellation, bounded
  cleanup, original business errors and native XState error reporting.
- XState and `@opentelemetry/api` are the only peers; the host owns the SDK.
- Prefer XState public APIs. Represent uncertainty explicitly.

## XState semantics

- Record the exact XState version behind a claim about its behaviour that no test checks. Tests
  need no version: the compatibility matrix runs them on every tested version.
- Reproduce disputed behaviour in a focused executable test before relying on it.
- Keep `SimulatedClock` advancement separate from real timers, Promise microtasks and I/O.
- Never send synthetic `xstate.done.actor.*` events to emulate invoked work completing.
- Cover cancellation, reentry, parallel and `after` cases for lifecycle or timing changes.
- `tests/send-matrix.test.ts` pins how XState delivers a send in each target state and what the
  runtime records for it. Update it with any change to either.

## Public API

- Functions start with a verb (`create*`, `get*`, `send*`); functions returning actor logic use
  `from*`; `with*` runs a callback in a context; predicates `should*`, notifications `on*`.
- Callback inputs are `*Args`, option bags `<Function>Options`. A command enters through
  `sendCommand`; an operation is the traced unit a command or timer starts; work is a traced
  Promise actor's finite work. Use the terms the docs glossary defines.
- `tests/public-api.test.ts` snapshots the published declarations. Update that snapshot only for
  a deliberate API change and say so in the PR.
