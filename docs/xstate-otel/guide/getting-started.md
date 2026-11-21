# Getting started

## Install

```sh
npm install @actorium/xstate-otel xstate @opentelemetry/api
```

XState (`>=5.33.0 <6`) and `@opentelemetry/api` (`>=1.9.0 <2`) are peer
dependencies, and Node.js 24 or later is required. See
[compatibility](../reference/compatibility.md) for the tested versions.

## Start your OpenTelemetry SDK first

The library only uses the OpenTelemetry API. Initialize your SDK, context
manager and instrumentations before the actors start, and before loading
modules that auto-instrumentation must patch. Without an SDK, the API produces
no-op spans and nothing is exported.

Then create one tracing runtime and share it:

<<< @/snippets/tracing.ts

## Trace a command and its Promise work

<<< @/snippets/getting-started.ts

This produces two spans in one trace: the `inventory.check` operation and its
child `inventory.lookup` work span. HTTP or database calls made inside the
lookup become children of the work span when your SDK instruments them.

Three rules matter:

- Pass `tracing.inspect` when **creating** the root actor. It observes every
  invoked and spawned actor in that system.
- Use `sendCommand` where work enters the system. A plain `actor.send` is not
  traced.
- Wrap finite Promise logic with `tracing.fromPromise` and pass ordinary input.

## Link or child

<<< @/snippets/child-relationship.ts

The default `link` starts a new trace linked to the caller, which suits a
handler that responds before the work finishes. Use `child` when the caller
waits for the work. See [commands](commands.md#link-or-child).

## Shut down

Stop ingress and your actors, wait for queued tracing bookkeeping, then shut
down the SDK:

<<< @/snippets/shutdown.ts

`waitForBookkeeping()` does not wait for business work or export spans; see
[testing with waitForBookkeeping()](../recipes/testing.md#what-waitforbookkeeping-waits-for).

## Next steps

- [Commands](commands.md): naming, typing and the life of a command.
- [Promise work](promise-work.md): selection, inputs and cancellation.
- [Configuration](../reference/configuration.md): every option.
