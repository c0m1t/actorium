# Glossary

How this documentation uses each term. OpenTelemetry and XState sometimes use
them more broadly.

## Library terms

**Command.** An event sent through `sendCommand`. It starts an operation and
returns an `OperationTrace`.

**Operation.** A bounded tracing scope, and the span that represents it,
started by a command or by a timer under a linked
[timer policy](../guide/scheduled-work.md). It groups counted event processing
and the traced Promise actors created during it, and ends when neither
remains. Timers don't keep the operation that scheduled them open, and a
cancelled timer creates no operation.

**Delivery.** XState putting an event into an actor's mailbox. Delivery,
waiting in the mailbox and processing are separate boundaries: inspection
reports a send before the mailbox accepts it, so the runtime's
**mirrored mailbox entries** are tracing records, not proof that XState
accepted the event. The runtime counts processing per event object, not per
event type.

**Relay.** An actor-originated send whose source XState reports: `sendTo`,
`sendParent`, self-sends and the done and error notifications of child
actors. `raise` and `emit` are not relays.

**Observed, associated and traced actors.** An actor is _observed_ when this
runtime receives its inspection events, _associated_ while an operation owns
its current processing or initialization, and _traced_ when it is a traced
Promise actor with a work span. A child excluded by `shouldTrace` is still
observed, and associated through initialization only, without a work span or
work registration.

**Traced Promise actor.** A `tracing.fromPromise` actor that joined an
operation and has a work span.

**Work registration.** What keeps an operation open for a traced Promise
actor. It can outlive the work span: it is released when the runtime
reconciles the actor as terminal, including by a stop.

**Completion handoff.** XState relaying a traced Promise actor's done or error
notification to its parent. The work registration keeps the actor linked to
the operation through the handoff, and the parent's queued handling of the
notification is counted separately; the registration is not guaranteed to
last until the parent's handler runs.

**Outcome.** How the tracing lifecycle of an operation ended, the value of
`finished`. [Outcomes](outcomes.md#outcomes) lists and defines each one.

**Terminal recipient.** The recipient of a relay that was already done,
errored or stopped. See [relays to terminal actors](outcomes.md#relays-to-terminal-actors).

**Timer operation.** An operation started by a timer firing, linked to the
operation that scheduled the timer.

**Target actor.** The actor a command, or a timer operation, was sent to.
Its failure makes the operation `failed`.

**Root actor.** An actor with no creating parent: the actor passed to
`createActor`.

**Telemetry namespace.** The prefix of every name the library emits,
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
sends, actions, microsteps and snapshots. `tracing.inspect` consumes it.

**Mailbox.** An actor's queue of events waiting to be processed.

**Macrostep.** One machine event processed through its immediate internal
steps, including eventless transitions and immediately raised events. Relays
to other actors and asynchronous work are not part of it.

**Microstep.** One atomic step that applies the selected non-conflicting
transitions. Parallel regions can contribute several transitions to one
microstep.

**Snapshot.** An actor's state at a point in time.

**Invoked and spawned actors.** Children started by a state's `invoke`, or
created dynamically with `spawn`.

**`AbortSignal`.** The signal XState passes to a Promise actor and aborts when
the actor is stopped.
