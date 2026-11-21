# Promise work

`tracing.fromPromise` is XState's `fromPromise` with tracing: it takes a span
name, then the same implementation, and returns ordinary Promise actor logic
that works anywhere XState's does. To trace existing work, replace
`fromPromise(implementation)` with `tracing.fromPromise('name', implementation)`.

<<< @/snippets/promise-work.ts

The generic parameters are **output, input, emitted event**, and the
implementation receives the same `{ input, signal, self, system, emit }`
arguments.

## How a Promise joins a command

When the child actor is created while a traced event is processed, the runtime
records the operation that owns that processing. When the Promise starts, it joins that
operation:

1. A work span starts as a child of the operation span.
2. The implementation runs with the work span's context active, so
   instrumented clients create child spans.
3. The work span ends when the Promise settles. The operation stays open
   through the [completion handoff](../reference/glossary.md#library-terms),
   and the parent's handling of `onDone` or `onError` is counted too, so
   replacement work started there joins the same operation.

Ownership is decided by which actor created the child, not by the input. Input
is passed through untouched: objects, shared or frozen objects, functions,
primitives and no input at all work the same way.

A Promise created outside traced processing, for example during startup, still
runs normally but creates no span. A Promise that starts after its operation
ended cannot reopen it.

## Choose which children to trace

`shouldTrace` runs once when the Promise starts, before the implementation,
with `{ name, input, self, parent }`. Returning `false` omits that child's span;
the business work runs unchanged and no longer keeps the command open.

<<< @/snippets/should-trace.ts

Use a stable discriminator: an explicit child `id`, the `src` name or the
input. `self.sessionId` is generated. Promise actors have no state tags. The
parent's tags describe its whole active configuration, including parallel
regions, and a child started manually inside an action may still see the
parent's previous snapshot. A throwing or non-boolean `shouldTrace` is
reported as a [diagnostic](../reference/configuration.md#diagnostics) and the
child is traced.

## Inputs

<<< @/snippets/inputs.ts

XState still applies its own rules: a named `spawn('work', { input })` treats a
function input as a mapper, so pass the logic directly when the input value is
itself a function.

## Cancellation and deadlines

Stopping a Promise actor, for example by leaving the state that invoked it,
aborts its `signal`. The work span records `work.outcome: cancelled`, and the
operation that started the work finishes `cancelled`. Pass the signal to every client call: tracing cannot stop
I/O that ignores it.

An `AbortError` that was not caused by the actor's signal, such as a request
timeout, is a failure. Give services deadlines so a stalled dependency cannot
keep an operation open forever:

<<< @/snippets/deadline.ts

`Promise.race` only stops waiting; the request keeps running. Await body
reading and validation inside the implementation when they are part of the
work.

## Failures

A rejection marks the work span `ERROR` with an exception event and sets the
command's `hadError`. If the machine handles `onError`, the command can still
finish `completed`. See [outcomes and errors](../reference/outcomes.md).

## Only finite work

Wrap work with a clear end. Long-lived actors such as subscriptions, pollers
and WebSockets should not be one span; trace each message or unit of work
instead, as shown in [HTTP and message boundaries](../recipes/http-boundaries.md#subscriptions-and-callback-actors).
