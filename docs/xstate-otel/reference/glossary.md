# Glossary

How this documentation uses each term. OpenTelemetry and XState sometimes use
them more broadly.

## Library terms

**Command.** An event sent through `sendCommand`. It starts an operation and
returns a `CommandTrace`.

**Operation.** The runtime's record of one command's traced work, and the span
that represents it. It ends when no counted delivery or Promise work remains.

**Continuation.** Traced Promise work that keeps an operation open, from the
Promise's start until its parent has handled the done or error event.

**Delivery.** One event received and processed by one actor. The runtime
counts deliveries, not event types.

**Outcome.** How the tracing lifecycle of a command ended, the value of
`finished`. [Outcomes](outcomes.md#outcomes) lists and defines each one.

**Terminal recipient.** The recipient of a relay that was already done,
errored or stopped. See [relays to terminal actors](outcomes.md#relays-to-terminal-actors).

**Scheduled operation.** An operation started by a timer firing, linked to the
operation that scheduled the timer.

**Target actor.** The actor a command, or a scheduled operation, was sent to.
Its failure makes the operation `failed`.

**System root.** An actor with no creating parent: the actor passed to
`createActor`.

**Attribute namespace.** The prefix of every name the library emits,
`actorium.xstate` by default.

## OpenTelemetry terms

**Span.** A timed record of one piece of work, with a name, status, attributes,
events and links.

**Trace.** A tree of causally related spans.

**Link.** A reference from one span to another that does not make it a parent.
Linked spans can belong to different traces.

**Context.** The OpenTelemetry state active during execution, including the
current span. Not XState's machine context.

**Span event.** A timestamped annotation inside a span, such as a microstep.

**Exporter.** The SDK component that sends spans to a collector or backend.

**High cardinality.** Many distinct values, such as order IDs. Avoid them in
span names and be selective in attributes.

## XState terms

**Inspection.** XState's stream of events describing actor creation,
deliveries, actions, microsteps and snapshots. `tracing.inspect` consumes it.

**Mailbox.** An actor's queue of events waiting to be processed.

**Macrostep.** Processing one event, including the eventless transitions and
immediately raised events it causes.

**Microstep.** A single transition within a macrostep.

**Snapshot.** An actor's state at a point in time.

**Invoked and spawned actors.** Children started by a state's `invoke`, or
created dynamically with `spawn`.

**`AbortSignal`.** The signal XState passes to a Promise actor and aborts when
the actor is stopped.
