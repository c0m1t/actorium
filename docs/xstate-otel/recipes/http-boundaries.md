# HTTP and message boundaries

Every boundary where work enters the actor system needs a command. This page
shows the common shapes. All of them assume your SDK instruments the incoming
request or message, so its span is active when the handler runs.

## Accept and respond early

When the handler answers before the work finishes, keep the default `link`.
The operation becomes its own trace, linked to the request, and the request
span ends independently:

<<< @/snippets/http-accept.ts

Returning `traceId` lets a client or support engineer find the operation.

## Wait for a result

When the handler waits, make the operation a `child` of the request span and
wait for the business result through your own channel. `finished` only says
that the traced work settled:

<<< @/snippets/http-wait.ts

## Queues and other services

Trace context crosses a process boundary only through your messages. Inject
it inside traced work and start a linked command from the extracted context
on the other side. The SDK must have a propagator configured, usually W3C
Trace Context:

<<< @/snippets/propagation.ts

Validate incoming carriers like any other external input. The same pattern
connects two tracing runtimes in one process.

## Subscriptions and callback actors

Sockets, feeds, pollers and callback actors live too long to be spans. Turn
each meaningful message into a command and let the target invoke finite work:

<<< @/snippets/subscription.ts

For a callback actor, either start the command in the source callback or
handle its `sendBack` event in the parent with an action that sends a command.
Do not add a second command for a reply that already belongs to a traced
request/reply chain.

## Restarts and recovery

Live spans and the runtime's associations are in memory only. After a restart,
restore business state from your own persistence and start new commands for
new work. To connect to earlier work, store a validated span context
deliberately and pass it as `parentContext` or in `links`.

Each workflow needs one authoritative actor owner, for example through sticky
routing or partitioning. Tracing does not route or place actors.
