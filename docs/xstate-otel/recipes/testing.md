# Testing with `waitForBookkeeping()`

Trace shape is behaviour worth testing: which operations exist, how work nests
and what outcome each command reports. Use the SDK's in-memory exporter and a
fresh tracing runtime per test.

<<< @/snippets/testing.ts

The example uses `node:assert`; the same steps work in Vitest, Jest or
`node:test`.

## Await the right thing

| To wait for                    | Await                                                           |
| ------------------------------ | --------------------------------------------------------------- |
| One command's traced work      | `command.finished`                                              |
| All queued tracing bookkeeping | `tracing.waitForBookkeeping()`                                  |
| Business progress              | The actor's snapshot or an application reply                    |
| A delayed XState timer         | Advance a `SimulatedClock`, then `tracing.waitForBookkeeping()` |

Do not wait a fixed number of microtasks or use `setImmediate`. Some
bookkeeping, such as the end-of-operation check and lifecycle checks after an
error, runs in a microtask after `send()` returns.

## What `waitForBookkeeping()` waits for

`waitForBookkeeping()` waits only for the bookkeeping groups that are queued or
running when it is called, and the follow-ups they schedule synchronously: not
business completion, empty mailboxes or export. It resolves immediately when
nothing is queued. Each call has its own boundary, so later activity cannot keep
it waiting.

It does **not** wait for pending Promise work, future events, delayed timers
or commands queued before `start()`. It does not stop actors, end spans or
export telemetry. An operation with unfinished Promise work stays open after
`waitForBookkeeping()` resolves.

## Timers

Pass a `SimulatedClock` to `createActor` and advance it between actor calls.
Then `waitForBookkeeping()` and read the spans. With
a [timer policy](../guide/scheduled-work.md) set, the clock must be
mutable.

## Assertions that hold up

- Find spans by name and compare parent span IDs rather than relying on export
  order across traces.
- Read attribute names from `getTelemetryNames()`, or `getTelemetryNames(namespace)`
  when you configure one; see [attributes](../reference/attributes.md).
- Assert business state separately from `outcome`; a `completed` command can
  end in a business failure state.
- Call `exporter.reset()` or create a new exporter between tests.
