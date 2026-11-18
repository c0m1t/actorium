# Outcomes and errors

`CommandTrace.finished` resolves with `{ outcome, hadError }`. Both describe
the traced work, not the business result.

## Outcomes

| `outcome`   | Meaning                                                                                                        |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `completed` | All of the command's deliveries and traced Promise work settled                                                |
| `cancelled` | Accepted work was abandoned: queued deliveries discarded by stop or error, or traced Promise work stopped      |
| `dropped`   | The command was never delivered: the target was stopped, not observed by this runtime, or no delivery was seen |
| `failed`    | The target actor errored, or `actor.send` threw (the error is rethrown)                                        |

`outcome` is also recorded on the operation span as `operation.outcome`.

A relay refused by an already stopped actor is not abandoned work. The
operation keeps its outcome and `hadError`, and records a `delivery.dropped`
event (recipient ID and event type, never the payload) and
`operation.dropped_delivery_count`.

## `hadError` and span status

`hadError` is `true` when any traced work of the command failed.

| What failed                                 | `outcome`   | `hadError` | Operation span status |
| ------------------------------------------- | ----------- | ---------- | --------------------- |
| Nothing                                     | `completed` | `false`    | `UNSET`               |
| A Promise rejected and `onError` handled it | `completed` | `true`     | `UNSET`               |
| The command's target actor errored          | `failed`    | `true`     | `ERROR`               |

A failed Promise always marks its own work span `ERROR`.

The target actor is the actor passed to `sendCommand`, or the target of a
scheduled operation. It need not be a system root. `operation.had_error` and
`operation.error_count` record the same information on the span; the count
includes every failed traced span, so recovered failures stay visible.

A cancelled Promise is not a failure: its span records
`work.outcome: cancelled` without an exception. An `AbortError` that the
actor's signal did not cause is a failure.

## Error details

A failed span gets `ERROR` status, a status message when one is available and
at most one `exception` event with `exception.type`, `exception.message` and
`exception.stacktrace`.

By default the runtime reads `name`, `message` and `stack` from errors and
other objects, and records strings and other primitives as their type and
text. When the message and stack are missing, it sets
`error.details_unavailable: true` (see `detailsUnavailableAttribute`). Values
are read once, without serializing payloads or following causes.

To control what is recorded, supply `errorDetails`. Its result **replaces** the
built-in details; omitted fields are never filled from the raw error:

<<< @/snippets/error-details.ts

| Mapper result              | Recorded                                                             |
| -------------------------- | -------------------------------------------------------------------- |
| `{ type, message, stack }` | Status message from `message`, exception event with the fields       |
| `{ attributes }` only      | Exception event with those attributes                                |
| `{}`                       | `ERROR` status only                                                  |
| Throws                     | `ERROR` status and the unavailable marker; `errorDetails` diagnostic |

The mapper runs synchronously once per failed span, so an unhandled child
failure can call it for both the work span and the operation span. Its output
is trusted as typed. Dedicated fields take precedence over `exception.*`
attributes. The original error value always continues unchanged through
XState.

## Actor failures and native reporting

Tracing never changes how XState reports errors. It installs no error
subscriptions, adds no console output and does not rethrow. An unhandled
failure keeps XState's native behaviour, and your error observers and parent
handlers receive the original error.

When a system root fails, `onTelemetryError` receives one diagnostic:
`associatedRootError` when an operation was live, otherwise
`unassociatedRootError`, which creates no span. The hook observes; it cannot
suppress native reporting. Child failures handled by the parent produce no
root diagnostic. Commands queued when the root failed finish `cancelled`.

These diagnostics and the related cleanup can run in a microtask after
`send()` or `start()` returns. Read the snapshot for immediate status, and
await `finished` or `settle()` for tracing results.
