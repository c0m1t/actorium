# Commands

A command is an event that enters the actor system through `sendCommand`. It
starts an operation span, sends the original event object with `actor.send`
and returns a `CommandTrace` handle.

<<< @/snippets/commands.ts

## Where to send commands

Call `sendCommand` where a new unit of work enters: an HTTP handler, a queue
consumer, a user action, a subscription message or an independently scheduled
job. Use `sendTo` and `sendParent` for messages inside the system; they join
the current operation automatically (see
[actor messages](actor-messages.md)).

Give operations stable, low-cardinality names such as `checkout.add_item`.
Never put order numbers, user IDs or URLs in the name; add a small, reviewed
set of attributes instead. The event itself is not modified: no trace fields
are added, and the same event object can be sent more than once.

## Typed events

The event parameter is typed from the target actor, so an event type or field
that `actor.send` would reject is a compile-time error here too. Actors typed
as `AnyActorRef` accept any event object. The check is type-only; validate
untrusted payloads yourself.

## Link or child

| `relationship`   | Trace shape                            | Use when                                         |
| ---------------- | -------------------------------------- | ------------------------------------------------ |
| `link` (default) | New trace, linked to the incoming span | The caller responds before the work finishes     |
| `child`          | Child of the incoming span             | The caller waits for the work as part of its own |

The incoming context is `parentContext`, or the active context when omitted.
The relationship only shapes the trace; it does not make the caller wait. See
[HTTP and message boundaries](../recipes/http-boundaries.md).

## What the operation covers

The operation includes the command's delivery, everything processed in the
same macrostep, immediate relays to other actors in the system, and every
`tracing.fromPromise` actor those turns create, until each Promise's completion has
been handled. It ends when no counted delivery or Promise work remains, so a
command that leaves the actor waiting for a person ends right away.

Work that starts later is not part of it: a timer firing, a callback actor's
later message or a subscription event. Give those their own command, or use
[scheduled work](scheduled-work.md) for XState timers.

## The `CommandTrace` handle

| Property      | Meaning                                                     |
| ------------- | ----------------------------------------------------------- |
| `operationId` | Number unique within this tracing runtime                   |
| `traceId`     | Trace ID of the operation span                              |
| `spanId`      | Span ID of the operation span                               |
| `finished`    | Resolves with `{ outcome, hadError }` when the work settled |

`finished` never rejects. [Outcomes](../reference/outcomes.md) defines each
`outcome` it can resolve with. An
operation can complete while the business failed, for example when an
`onError` transition leads to a failure state. Read the snapshot, as in the
example above, or use an application reply for the business result.

If `actor.send` throws synchronously, for example because another inspector
throws, the operation is closed as `failed` and the original error is rethrown,
so no handle is returned.

## Commands before `start()`

Commands sent before `actor.start()` wait in XState's mailbox; their spans
include the waiting time; a command stays open for as long as its actor is
neither started nor stopped. A target that is already terminal finishes the
command immediately as [`target_terminal`](../reference/outcomes.md#reasons):
its snapshot is done or errored, for example after a failing initial
`context`, or it was stopped before it started. XState runs initialization first. Startup actions,
relays and Promise work do not belong to a queued command. Each queued command
then owns only its own delivery when it runs.

If startup fails, or the actor is stopped before it starts, queued commands
finish `cancelled` without inheriting the startup error. To trace startup work,
move it behind an explicit command sent after `start()`.
