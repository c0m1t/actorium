# Compatibility

## Supported versions

| Dependency           | Range         |
| -------------------- | ------------- |
| `xstate`             | `>=5.33.0 <6` |
| `@opentelemetry/api` | `>=1.9.0 <2`  |
| Node.js              | `>=24`        |

The package is ESM-only. Both libraries are peer dependencies; the
application installs the OpenTelemetry SDK it wants.

## Tested versions

The compatibility matrix typechecks, builds and runs the full test suite for
each combination:

| `xstate`        | `@opentelemetry/api` |
| --------------- | -------------------- |
| 5.33.0 (lowest) | 1.9.0 (lowest)       |
| 5.33.2          | latest 1.x           |
| latest 5.x      |                      |

"Latest" means the newest release that is at least a week old when the matrix
runs. The range is wider than the tested set: a version inside it that the
matrix has not run is not verified.

## What the library relies on

Tracing depends on XState behaviour, so treat every XState upgrade as a
change to verify:

- **Inspection events.** The order and shape of `@xstate.actor`,
  `@xstate.event`, `@xstate.action`, `@xstate.microstep` and
  `@xstate.snapshot`, and the relay and snapshot ordering described in
  [inspection and ordering](../explanation/inspection-and-ordering.md).
- **The creating parent.** XState's inspection events do not say which actor
  created a new actor, so the built-in resolver reads the private `_parent`
  field. It is the only private field the library reads. A custom
  `resolveParentActor` must answer while the actor is being created, and the
  built-in resolver still runs as its fallback.
- **Public methods it wraps.** A root actor's `stop()`, and, with
  [scheduled work](../guide/scheduled-work.md) enabled, the system scheduler's
  `schedule` and `cancel` and the root clock's `setTimeout` and
  `clearTimeout`. XState's `cancelAll` must keep cancelling through `cancel`.
- **Error and completion handoff.** A child's done or error event reaches its
  parent before the child's final snapshot is inspected.

## Upgrading XState

1. Pin exact versions of `xstate` and this package in your application.
2. Read the XState changelog for changes to inspection, actor lifecycle,
   delayed actions and Promise actors.
3. Run your own tests that assert trace shape, including nested machines,
   cancellation, retries and any custom clock, with the new version.
4. Upgrade this package when it adds the new version to its tested set, or
   report a failure with a reproduction.

XState 6 is not supported. Its inspection model needs a separate integration.
