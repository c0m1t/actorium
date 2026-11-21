# Edge cases

## Supported

| Case                                        | Behaviour                                                                                            |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Reentrant mixed traffic                     | Traced and untraced events keep their own owners in mailbox order                                    |
| Same event object sent again                | Each send is a separate delivery; commands match by object and recipient                             |
| Shared, frozen, callable or primitive input | Passed through unchanged; ownership comes from the creating actor                                    |
| Parallel Promise work                       | Each joins; the operation ends after the last is handed back                                         |
| `onDone`/`onError` starts more work         | The new work joins before the old work is released                                                   |
| Nested invoked or spawned machine           | Its initialization and initial Promise work join the creating command                                |
| Immediate `raise` and `always`              | Same macrostep, same operation                                                                       |
| `sendTo`/`sendParent` chains                | One operation across actors observed by the same runtime                                             |
| Commands before `start()`                   | Each owns its own delivery after initialization; startup work is separate                            |
| Startup failure or stop before start        | Queued commands finish `cancelled`, without the startup error                                        |
| Relay to a terminal actor                   | [Recorded on the span](../reference/outcomes.md#relays-to-terminal-actors); the outcome is unchanged |
| Handled Promise rejection                   | `completed` with `hadError`; the work span is `ERROR`                                                |
| Target actor failure                        | `failed`; XState's native error reporting is unchanged                                               |
| Command to a terminal or unobserved actor   | Sent natively; see [outcomes](../reference/outcomes.md)                                              |
| Promise stopped by leaving its state        | Signal aborted, work span `cancelled`, operation `cancelled`                                         |
| Delay of `0`                                | Still scheduled work, not an immediate relay                                                         |

## Known gaps

These are deliberate boundaries. Each has a workaround.

| Gap                                                   | Workaround                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `otherActor.send()` inside an action loses the source | Use `sendTo`, or [`sendCommand`](../guide/commands.md) for new work                                           |
| Async actions and fire-and-forget Promises            | Move finite work into an invoked [`tracing.fromPromise`](../guide/promise-work.md)                            |
| A callback actor's later `sendBack` is untraced       | [Turn messages into commands](../recipes/http-boundaries.md#subscriptions-and-callback-actors)                |
| `emit` listeners are not deliveries                   | Start a command or a manual span in the listener                                                              |
| Timers are untraced without a policy                  | Set [`scheduledWorkPolicy`](../guide/scheduled-work.md) or start a command when they fire                     |
| A timer scheduled outside a command has no origin     | Schedule from a command, or start a command when it fires                                                     |
| Application timers, queues and other runtimes         | Start a command at the boundary; [propagate context](../recipes/http-boundaries.md#queues-and-other-services) |
| Invoked machines have no span of their own            | Only their traced Promise work keeps the command open                                                         |
| Advancing a clock inside an action without a policy   | The firing looks like a relay from that action; advance clocks between actor calls                            |
| Process restarts end live operations                  | Start new commands; link to stored context when needed                                                        |
| `finished` is not a business result                   | Read the snapshot or an application reply                                                                     |
