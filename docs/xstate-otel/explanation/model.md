# Model and operation lifecycle

This page explains how one command becomes one operation and why it ends when
it does. The [introduction](../guide/introduction.md) covers why operations
are per command rather than per actor.

## The operation record

Each operation holds its span and context, a count of **pending deliveries**
and a set of **continuations**: traced Promise work that has not yet been
handed back to its parent. The operation ends when both are empty.

```mermaid
sequenceDiagram
  participant Caller
  participant Trace as Tracing runtime
  participant Parent as Machine actor
  participant Work as Promise actor
  Caller->>Trace: sendCommand(event)
  Trace->>Trace: Start operation, mark the event object
  Trace->>Parent: actor.send(event)
  Parent-->>Trace: Delivery inspected and counted
  Parent->>Work: Create child with ordinary input
  Work-->>Trace: Creation inspected: capture the owning operation
  Parent->>Work: Start the Promise
  Trace->>Trace: shouldTrace, work span, continuation
  Work-->>Parent: Done or error event
  Parent-->>Trace: Handler ran; replacement work may join
  Trace->>Trace: Release continuation, recheck in a microtask
  Trace-->>Caller: finished resolves
```

## 1. Start

`sendCommand` creates the span and remembers the exact event object together
with the target actor, then calls `actor.send`. The first matching
`@xstate.event` inspection claims the operation, so the same event object can
be sent several times without confusion. The runtime always calls `send`,
even for a terminal target. When the send is not counted, the operation ends
with an outcome and reason from [outcomes](../reference/outcomes.md). If
`send` throws, the runtime removes that operation's deliveries from its
records, finishes it `failed` and rethrows.

## 2. Count every delivery

Inspection reports an event before the actor processes it, and an actor that
is already busy queues it. The runtime therefore mirrors each actor's mailbox,
including untraced events, and matches each snapshot to the delivery it
closes. Deliveries owned by the operation increment and decrement its count.

Untraced events have to be mirrored too. If a traced command A, an untraced
event and a traced command B are queued in that order, skipping the middle
entry would make B the owner of the untraced event's work. The
[ordering page](inspection-and-ordering.md#mailbox-ordering) shows this case
and commands queued before `start()`.

A relay inherits ownership from its source: the actor whose turn is being
processed, or a Promise continuation whose done or error event is being
relayed.

## 3. Attach Promise work

Ownership of Promise work follows actor creation, not input:

- When a child actor is created, the runtime records the operation that owns
  the creating parent's current turn, keyed by the child actor.
- When a `tracing.fromPromise` starts, it joins that recorded operation. It never
  looks for a newer one. `shouldTrace` decides only whether to trace this
  child, and runs at start, after ownership was captured.
- Inputs carry no markers and are never inspected, copied or wrapped.
- A child created with no live operation runs untraced, and a child that
  starts after its operation ended cannot reopen it.

The recorded owner is cleared on initialization, stop, error or when the
operation ends, so a retained child that never starts does not retain an
ended operation.

## 4. End in the right order

The work span ends as soon as the Promise settles. The continuation, however,
is released only when the Promise actor's terminal snapshot is inspected,
which happens after the parent has processed the done or error event. A
replacement Promise started by `onDone` or `onError` is therefore registered
before the old one is released.

When both the count and the continuation set reach zero, the runtime checks
again in a microtask before ending the operation. This gives a busy parent's
queued completion event or a synchronous handoff the chance to register new
work, without depending on state names. It does not wait for timers or
anything asynchronous.

## Why outcomes mean what they mean

Callers act on `finished`, so each [outcome](../reference/outcomes.md) has
one meaning:

- `cancelled` is reserved for work the command had started. A relay to an
  already terminal actor is not such work: the command's own work completed,
  and a caller that retried on `cancelled` would repeat a command that took
  effect. It is
  [recorded on the span](../reference/outcomes.md#relays-to-terminal-actors)
  instead.
- A target that fails while handling the command makes it `failed`, while a
  child failure that the parent handled is `completed` with `hadError`. This
  keeps a crashed actor distinguishable from a recovered one. A target that
  was already terminal before the send is `target_terminal` instead, because
  the command caused nothing.

## Keeping business data clean

Associations live in private weak maps keyed by actors and event objects.
Nothing is added to machine context, events or inputs, so snapshots can be
persisted without telemetry. Weak keys do not make their values collectable,
so every record is also removed explicitly when its delivery, child or
operation finishes; see [performance](performance.md).
