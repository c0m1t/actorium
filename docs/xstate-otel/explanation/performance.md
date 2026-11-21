# Performance

## Memory follows current work

The runtime keeps no history of finished commands: an idle actor holds no past
spans. Memory grows with what is in flight:

- mailbox backlogs and their event payloads;
- live operations, their spans and attributes;
- running Promise work and its inputs;
- pending timers, when a timer policy is set;
- your SDK's span processors and exporter queues.

Weak maps do not make their values collectable, so records are also removed
explicitly when an event is processed, a child starts or stops, or an
operation ends. Sends to terminal actors create no record, and a rejected
`sendCommand` removes its records before rethrowing. Timer records keep only
compact origin data.

There is no queue limit, operation age limit or global timeout. Bound active
work in the application: admission limits, service deadlines, registry
eviction and SDK buffer limits. A Promise that never settles keeps its
operation open until the actor stops it.

## Cost per event

Every inspected event, traced or not, gets a small record so ownership stays
exact. Normal mailbox operations take constant time: appending, processing
`xstate.init` ahead of queued commands and taking the next entry. Two
exceptional paths scan the pending queue once: matching an out-of-order
snapshot and rolling back a rejected command.

Each inspected event schedules at most one lifecycle check per actor per
macrostep, tracked weakly. No actor subscriptions are installed.

With a timer policy set, registration normally takes the first matching
recorded action, and cancellation finds its record by timeout handle, so
neither scans all pending timers. `cancelAll` keeps XState's own cost.

## Keeping overhead low

- Leave `recordMicrosteps` off unless you need it. Unsampled spans skip
  microstep serialization, but delivery accounting always runs.
- Keep attribute callbacks cheap and their results small.
- Configure SDK span, event and attribute limits and bounded exporter queues.
- In tests, in-memory exporters keep every span; reset them between tests.
