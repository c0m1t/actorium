# Configuration

Create one runtime with `createXStateTracing({ tracer, ...options })` or
`new XStateTracing(tracer, options)`. A runtime can inspect several root
actors; roots that share it also share in-process event accounting.

<<< @/snippets/configuration.ts

## Options

| Option                                  | Default                                 | Effect                                                                                                |
| --------------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `tracer`                                | Required (factory only)                 | OpenTelemetry `Tracer` for every span                                                                 |
| `telemetryNamespace`                    | `'actorium.xstate'`                     | Prefix for every emitted attribute, span-event and default span name; see [attributes](attributes.md) |
| `recordMicrosteps`                      | `false`                                 | Add a `microstep` span event per microstep to recording operation spans                               |
| `recordStateValues`                     | `true`                                  | Include the serialized state value on microstep events                                                |
| `actorIdAttribute`                      | `<namespace>.actor.id`                  | Full key for actor IDs; `false` omits actor IDs                                                       |
| `operationSpanKind`                     | `SpanKind.INTERNAL`                     | Kind of operation spans; `sendCommand`'s `kind` overrides it                                          |
| `workSpanKind`                          | `SpanKind.INTERNAL`                     | Kind of work spans                                                                                    |
| `commonAttributes`                      | None                                    | Static attributes on operation and work spans                                                         |
| `operationAttributes({ actor, event })` | None                                    | Attributes computed per command                                                                       |
| `workAttributes({ name, input, self })` | None                                    | Attributes computed per work span                                                                     |
| `errorDetails(error)`                   | Built-in mapper                         | Replaces how failures are recorded; see [outcomes and errors](outcomes.md#error-details)              |
| `detailsUnavailableAttribute`           | `<namespace>.error.details_unavailable` | Full key marking failures without details; `false` omits it                                           |
| `timerPolicy`                           | Unset                                   | Policy or callback for XState timers; see [timers](../guide/scheduled-work.md)                        |
| `resolveParentActor(actor)`             | Built-in resolver                       | Finds an actor's creating parent; see [compatibility](compatibility.md#what-the-library-relies-on)    |
| `onDiagnostic(diagnostic)`              | OpenTelemetry `diag.warn`               | Receives [diagnostics](#diagnostics)                                                                  |

An invalid `telemetryNamespace` throws a `TypeError` at construction. Use
lowercase, dot-separated snake_case segments such as `acme.workflows`.

Operation spans get `commonAttributes`, then `operationAttributes`, then the
command's `attributes`, then the built-in command and operation attributes.
Work spans get `commonAttributes`, then `workAttributes`, then the
`fromPromise` attributes, then the actor ID. Attributes are not redacted;
keep them small, low-cardinality and free of personal data, and set limits in
your SDK.

## Runtime members

| Member                                        | Purpose                                                                                             |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `inspect`                                     | Pass to `createActor(machine, { inspect })` for each root                                           |
| `sendCommand(actor, event, options)`          | Start a command; see [commands](../guide/commands.md)                                               |
| `fromPromise(name, implementation, options?)` | Wrap finite work; see [Promise work](../guide/promise-work.md)                                      |
| `withActiveOperation(actor, callback)`        | Run synchronous code in the current operation's context                                             |
| `waitForBookkeeping()`                        | Wait for queued bookkeeping; see [testing](../recipes/testing.md#what-waitforbookkeeping-waits-for) |

`sendCommand` options are `name` (required), `attributes`, `relationship`
(`'link'` or `'child'`), `parentContext`, `kind` and `links`. `fromPromise`
options are `attributes` and `shouldTrace`.

The runtime has no `dispose()`. The application owns actor lifecycles and the
SDK's flush and shutdown.

## Diagnostics

Configuration callbacks run behind an exception boundary. When one fails, the
runtime reports a `TelemetryDiagnostic` `{ phase, error }` and falls back, and
business execution is unaffected. Diagnostics never set `hadError`.

| `phase`                 | Cause                                     | Fallback                                       |
| ----------------------- | ----------------------------------------- | ---------------------------------------------- |
| `operationAttributes`   | The callback threw                        | Omit its attributes                            |
| `workAttributes`        | The callback threw                        | Omit its attributes                            |
| `shouldTrace`           | Threw or returned a non-boolean           | Trace the child                                |
| `timerPolicy`           | Threw or returned an invalid policy       | Deliver that timer untraced                    |
| `resolveParentActor`    | The resolver threw                        | Use the built-in resolver                      |
| `errorDetails`          | The mapper or a detail property threw     | Record `ERROR` and the unavailable marker only |
| `scheduler`             | The clock or scheduler cannot be wrapped  | None: `createActor` throws a `TypeError`       |
| `unassociatedRootError` | A root actor failed outside any operation | Report only                                    |
| `associatedRootError`   | A root actor failed during an operation   | Report only                                    |

Without `onDiagnostic`, diagnostics go to OpenTelemetry's `diag.warn`,
except root failures, which XState already reports. Exceptions thrown by the
hook are contained. Root diagnostics can arrive in a microtask after
`send()` or `start()` returns. See
[outcomes and errors](outcomes.md#actor-failures-and-native-reporting).
