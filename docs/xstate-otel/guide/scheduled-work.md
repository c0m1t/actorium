# Scheduled work

XState timers (`after`, delayed `raise` and delayed `sendTo`) fire after the
command that scheduled them has ended. Without configuration they are not
traced. Setting `scheduledWorkPolicy` installs a scheduler integration that
can start a new operation, linked to the origin, when a timer fires.

<<< @/snippets/scheduled-policy.ts

Here the `editor.edit` operation ends as soon as the edit is processed. When
the debounce timer fires, a new `editor.autosave` operation starts with a link
to the edit, and the save work becomes its child.

## Policies

| Policy                                    | When the timer fires                                                         |
| ----------------------------------------- | ---------------------------------------------------------------------------- |
| `{ mode: 'untraced' }`                    | Delivered without an operation                                               |
| `{ mode: 'new-linked-operation', name? }` | New operation linked to the origin; default name `actorium.xstate.scheduled` |

The option takes a fixed policy or a callback that receives
`{ actor, actionType, event, delayMs, id }` for each timer. The decision is
made and copied when the timer is registered; later changes to the returned
object have no effect. A throwing callback or an invalid policy is reported
as a [diagnostic](../reference/configuration.md#diagnostics) and that timer is
untraced.

Only timers scheduled during a traced turn have an origin. A timer scheduled
during startup or untraced work fires untraced. A cancelled timer, or one
whose recipient is already terminal when it fires, creates no operation and
records nothing. Linked operations record the action, the delay and the
origin's operation ID as `scheduled.*` [attributes](../reference/attributes.md).

## Timers never hold a command open

The origin operation finishes when its deliveries and Promise work settle,
whatever timers are pending, and it keeps no reference to them. Use an
application reply or the actor's snapshot to wait for delayed business work.

## Clock requirements

Setting any policy, including `untraced`, requires a clock and scheduler the
integration can wrap: XState's stock clock or a mutable `SimulatedClock`.
Unsupported methods throw a `TypeError` from `createActor`, before the machine
starts. Advance a `SimulatedClock` between actor calls, not inside an action.
[Scheduler internals](../explanation/scheduler.md#requirements) has the exact
contract for custom clocks.

XState's own cancellation rules apply unchanged: when two pending timers share
an ID, cancelling the ID reaches only the newer one. Use distinct IDs for
timers that can overlap.

## Application timers

`setTimeout`, job schedulers and other timers outside XState are not covered.
Start a command when they fire. To link it to the work that scheduled it,
capture only the span context:

<<< @/snippets/timer-bridge.ts

Do this instead of, not in addition to, a linked policy for the same timer.
