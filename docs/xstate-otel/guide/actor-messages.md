# Actor messages and actions

Inside an actor system, work joins the current operation when XState reports
which actor caused it. This page covers what is joined automatically and what
needs an explicit boundary.

## Relays between actors

`sendTo`, `sendParent` and other built-in sends made while an actor handles a
traced delivery carry the operation to the recipient. The recipient's
Promise work and its own relays join too, so a request/reply chain across
actors stays one trace:

<<< @/snippets/actor-messages.ts

This requires both actors to be observed by the same tracing runtime: actors
in the same system, or roots that each use the same `tracing.inspect`.
Messages to an actor that another runtime or process observes are not
counted; start a command at that boundary instead.

A relay to an actor that is already terminal does not change the outcome;
see [relays to terminal actors](../reference/outcomes.md#relays-to-terminal-actors).
A relay to an observed actor that has not started yet waits in its mailbox
and keeps the operation open until that actor starts and processes it.

## Direct `send` calls

Calling `otherActor.send(event)` inside an action is a gap: XState reports no
source actor for a direct send, so the recipient cannot inherit the
operation. Use `sendTo(otherActor, event)`, or `sendCommand` when the message
really starts new work.

## Raised events and eventless transitions

An immediate `raise` and `always` transitions run inside the current macrostep
and belong to its operation, including Promise work they start. A `raise` with
a delay is [scheduled work](scheduled-work.md).

## Invoked and spawned machines

A machine created while a command is being handled inherits the command
during its initialization, so Promise work started by its initial state
joins. The child machine itself has no span and does not keep the operation
open; only its traced Promise work does. A spawned machine can outlive the
command; later messages sent to it with `sendTo` join whichever command is
being handled at the time.

Nested initialization relies on the creating parent, which XState does not
expose in inspection events. See [compatibility](../reference/compatibility.md#what-the-library-relies-on).

## Callback and observable actors

Their lifetimes are not spans. A message a callback actor sends back in a
later turn has no operation, and neither does work it starts. Adapt each
meaningful message into a command, as in
[subscriptions and callback actors](../recipes/http-boundaries.md#subscriptions-and-callback-actors).
Events delivered through `emit` listeners are not deliveries either.

## Actions

Actions are synchronous and get no span. With `recordMicrosteps`, each
microstep is a span event on the operation. To record a span for synchronous
work in an action, run it inside the operation's context:

<<< @/snippets/with-active-operation.ts

`withActiveOperation` makes the operation's context active while the callback
runs, if the actor is handling traced work; otherwise it just calls it. It does
not keep the operation open. XState does not await async actions, so put
asynchronous work in an invoked `tracing.fromPromise`.

## Combining inspectors

Pass one inspector to `createActor` and fan out to other tools. Keep the
tracing call outside your `try`: it reports scheduler configuration errors
that must not be swallowed.

<<< @/snippets/inspector-fanout.ts
