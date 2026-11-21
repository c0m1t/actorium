import { trace, SpanStatusCode } from '@opentelemetry/api';
import {
  createActor,
  enqueueActions,
  raise,
  sendTo,
  setup,
  SimulatedClock,
  type AnyActorRef,
  type AnyEventObject,
  stopChild,
} from 'xstate';
import { expect, it, vi } from 'vitest';
import { XStateTracing } from '../src/index.js';
import {
  createTestActor,
  internals,
  expectStoppedActorWarnings,
  useTestTracer,
  expectReleased,
} from './helpers.js';

const { tracer, exporter, spansNamed, spanNames, getSpan } = useTestTracer('timer-indexing');
const timerOperationSpans = () => spansNamed('actorium.xstate.timer_operation');

// The per-system handle index is private and reachable only from live timer
// records. Capture it while a timer exists so later checks prove it drained.
const handleIndexes = new WeakMap<object, Map<unknown, object>>();
function handleIndex(tracing: XStateTracing, actor: AnyActorRef): Map<unknown, object> | undefined {
  const live = internals(tracing).timersByActor.get(actor);
  // Bypass the instance iterator that countRecordAccess uses to detect scans.
  for (const scheduled of live ? Set.prototype.values.call(live) : []) {
    const records = (scheduled as { timeoutRecords?: Map<unknown, object> }).timeoutRecords;
    if (records) handleIndexes.set(actor.system, records);
  }
  return handleIndexes.get(actor.system);
}

// Released timers also leave the per-system handle index empty.
function expectEmpty(tracing: XStateTracing, actor: AnyActorRef): void {
  expectReleased(tracing, actor);
  expect(handleIndex(tracing, actor)?.size ?? 0).toBe(0);
}

// Count actual record comparisons and collection visits. The old registration
// scan and Set copy/reverse both grow quadratically, independent of wall time.
function countRecordAccess(tracing: XStateTracing) {
  const count = { fields: 0, visits: 0 };
  const records = new WeakSet<object>();
  const sets = new WeakSet<Set<object>>();
  const instrumentRecord = (record: object) => {
    if (records.has(record)) return;
    records.add(record);
    for (const key of ['registered', 'owner', 'recipient', 'delayMs', 'id']) {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor) continue;
      let value: unknown = descriptor.value;
      Object.defineProperty(record, key, {
        configurable: true,
        enumerable: descriptor.enumerable ?? false,
        get() {
          count.fields++;
          return value;
        },
        set(updated: unknown) {
          value = updated;
        },
      });
    }
  };
  const table = internals(tracing).timersByActor;
  const set = table.set.bind(table);
  table.set = (actor, collection) => {
    if (!sets.has(collection)) {
      sets.add(collection);
      for (const record of collection) instrumentRecord(record);
      const add = collection.add.bind(collection);
      collection.add = (record) => {
        instrumentRecord(record);
        return add(record);
      };
      const iterator = collection[Symbol.iterator].bind(collection);
      collection[Symbol.iterator] = function* (): SetIterator<object> {
        for (const record of iterator()) {
          count.visits++;
          yield record;
        }
        return undefined;
      };
    }
    return set(actor, collection);
  };
  return count;
}

it.each(['separate commands', 'one macrostep'] as const)(
  'registers shared events and cancels IDs with linear access: %s',
  async (mode) => {
    const tracing = new XStateTracing(trace.getTracer('timer-counts'), {
      timerPolicy: { mode: 'new-linked-operation' },
    });
    const count = countRecordAccess(tracing);
    const size = 1000,
      event = { type: 'FIRE' },
      clock = new SimulatedClock();
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: {
            actions: enqueueActions(({ event: command, enqueue }) => {
              const first = mode === 'one macrostep' ? 0 : (command.sequence as number);
              const end = mode === 'one macrostep' ? size : first + 1;
              for (let i = first; i < end; i++)
                enqueue.raise(event, { delay: 1000000, id: String(i) });
            }),
          },
        },
      }),
      { inspect: tracing.inspect, clock },
    ).start();
    if (mode === 'one macrostep')
      await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.batch' }).finished;
    else
      for (let i = 0; i < size; i++)
        await tracing.sendCommand(actor, { type: 'RUN', sequence: i }, { name: 'timer.command' })
          .finished;
    expect(count.fields).toBeLessThanOrEqual(size * 16);
    expect(count.visits).toBe(0);
    // Registered timers must leave the action-association queue immediately.
    expect(internals(tracing).timerRegistrations.get(actor)?.has(event)).toBe(false);
    expect(internals(tracing).timersByActor.get(actor)?.size).toBe(size);
    expect(handleIndex(tracing, actor)?.size).toBe(size);
    count.fields = 0;
    for (let i = 0; i < size; i++) actor.system.scheduler.cancel(actor, String(i));
    expect(count.fields).toBeLessThanOrEqual(size * 8);
    expect(count.visits).toBe(0);
    expectEmpty(tracing, actor);
  },
);

it('does not search other actors sharing a static event in the same system', async () => {
  const tracing = new XStateTracing(trace.getTracer('timer-population'), {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const count = countRecordAccess(tracing),
    event = { type: 'FIRE' },
    clock = new SimulatedClock();
  const worker = setup({}).createMachine({
    on: { RUN: { actions: raise(event, { delay: 1000000, id: 'same-id' }) } },
  });
  using root = createTestActor(
    setup({ actors: { worker } }).createMachine({
      context: ({ spawn }) => ({
        workers: Array.from({ length: 500 }, (_, i) => spawn('worker', { id: String(i) })),
      }),
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  for (const actor of root.getSnapshot().context.workers) {
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.worker' }).finished;
  }
  expect(count.fields).toBeLessThanOrEqual(500 * 16);
  expect(count.visits).toBe(0);
  const records = handleIndex(tracing, root.getSnapshot().context.workers[0]!);
  expect(records?.size).toBe(500);
  count.fields = 0;
  for (const actor of root.getSnapshot().context.workers) {
    root.system.scheduler.cancel(actor, 'same-id');
    expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  }
  expect(count.fields).toBeLessThanOrEqual(500 * 8);
  expect(count.visits).toBe(0);
  expect(records?.size).toBe(0);
});

it('preserves event identity and origin links after cancelling the middle shared-event timer', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock(),
    shared = Object.freeze({ type: 'FIRE' }),
    seen: AnyEventObject[] = [];
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: {
          actions: enqueueActions(({ event, enqueue }) => {
            enqueue.raise(shared, { delay: event.delay as number, id: event.id as string });
          }),
        },
        FIRE: {
          actions: ({ event }) => {
            seen.push(event);
          },
        },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const origins = [];
  for (let i = 0; i < 3; i++) {
    const command = tracing.sendCommand(
      actor,
      { type: 'RUN', delay: 30 - i * 10, id: String(i) },
      { name: 'timer.origin' },
    );
    await command.finished;
    origins.push(command);
  }
  actor.system.scheduler.cancel(actor, '1');
  clock.increment(10);
  await Promise.resolve();
  clock.increment(20);
  await Promise.resolve();
  expect(seen).toEqual([shared, shared]);
  expect(seen.every((event) => event === shared)).toBe(true);
  expect(timerOperationSpans().map((span) => span.links[0]?.context.spanId)).toEqual([
    origins[2]!.spanId,
    origins[0]!.spanId,
  ]);
  expectEmpty(tracing, actor);
});

it.each(['cancel newest', 'cancel all', 'older fires first', 'newer fires first'] as const)(
  'preserves native overlapping-ID behavior: %s',
  async (mode) => {
    const run = async (instrumented: boolean) => {
      const tracing = new XStateTracing(tracer, {
        timerPolicy: { mode: 'new-linked-operation' },
      });
      const clock = new SimulatedClock(),
        seen: number[] = [];
      const actor = createActor(
        setup({}).createMachine({
          on: {
            RUN: {
              actions: enqueueActions(({ event, enqueue }) => {
                enqueue.raise(
                  { type: 'FIRE', sequence: event.sequence },
                  { delay: event.delay as number, id: 'retry' },
                );
              }),
            },
            FIRE: {
              actions: ({ event }) => {
                seen.push(event.sequence as number);
              },
            },
          },
        }),
        { clock, ...(instrumented ? { inspect: tracing.inspect } : {}) },
      ).start();
      const origins: string[] = [];
      for (let i = 0; i < 2; i++) {
        const event = {
          type: 'RUN',
          sequence: i,
          delay: mode === 'newer fires first' ? 20 - i * 10 : 10 + i * 10,
        };
        if (instrumented) {
          const command = tracing.sendCommand(actor, event, { name: 'timer.overlap' });
          await command.finished;
          origins.push(command.spanId);
        } else actor.send(event);
      }
      if (mode === 'cancel all') actor.system.scheduler.cancelAll(actor);
      else if (mode === 'cancel newest') {
        actor.system.scheduler.cancel(actor, 'retry');
        actor.system.scheduler.cancel(actor, 'retry'); // Must not cancel the older timer.
      } else {
        clock.increment(10);
        await Promise.resolve();
        actor.system.scheduler.cancel(actor, 'retry'); // Firing already cleared the native slot.
      }
      if (instrumented) expect(internals(tracing).timersByActor.get(actor)?.size).toBe(1);
      clock.increment(100);
      await Promise.resolve();
      if (instrumented) {
        expect(timerOperationSpans().map((span) => span.links[0]?.context.spanId)).toEqual(
          seen.map((i) => origins[i]),
        );
        expectEmpty(tracing, actor);
      }
      actor.stop();
      return seen;
    };
    const plain = await run(false);
    expect(await run(true)).toEqual(plain);
    expect(plain).toEqual(
      mode === 'newer fires first' ? [1, 0] : mode === 'older fires first' ? [0, 1] : [0],
    );
  },
);

it.each(['ordinary action', 'direct scheduler'] as const)(
  'cancels an unassociated newer timer without removing the older trace: %s',
  async (mode) => {
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'new-linked-operation' },
    });
    const clock = new SimulatedClock(),
      seen: number[] = [];
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: {
            actions: enqueueActions(({ event, enqueue }) => {
              enqueue.raise({ type: 'FIRE', sequence: event.sequence }, { delay: 10, id: 'retry' });
            }),
          },
          FIRE: {
            actions: ({ event }) => {
              seen.push(event.sequence as number);
            },
          },
        },
      }),
      { inspect: tracing.inspect, clock },
    ).start();
    const origin = tracing.sendCommand(
      actor,
      { type: 'RUN', sequence: 0 },
      { name: 'timer.older' },
    );
    await origin.finished;
    if (mode === 'ordinary action') actor.send({ type: 'RUN', sequence: 1 });
    else {
      const event = { type: 'FIRE', sequence: 1 };
      actor.system.scheduler.schedule(actor, actor, event, 10, 'retry');
    }
    actor.system.scheduler.cancel(actor, 'retry');
    expect(internals(tracing).timersByActor.get(actor)?.size).toBe(1);
    clock.increment(10);
    await Promise.resolve();
    expect(seen).toEqual([0]);
    expect(timerOperationSpans().map((span) => span.links[0]?.context.spanId)).toEqual([
      origin.spanId,
    ]);
    expectEmpty(tracing, actor);
  },
);

it('removes the exact generated-ID timer through native cancellation', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock();
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 10 }) },
        FIRE: { actions: () => received++ },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.generated' }).finished;
  // Public snapshot is used only to obtain XState's generated ID in this test.
  const id = Object.values(actor.system.getSnapshot()._scheduledEvents)[0]!.id;
  actor.system.scheduler.cancel(actor, id);
  expectEmpty(tracing, actor);
  clock.increment(100);
  await Promise.resolve();
  expect(received).toBe(0);
  expect(timerOperationSpans()).toHaveLength(0);
});

it('delegates stock-clock firing and cancellation and restores both clock methods', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: {
          actions: [
            raise({ type: 'FIRE' }, { delay: 5, id: 'fire' }),
            raise({ type: 'FIRE' }, { delay: 1000, id: 'cancel' }),
          ],
        },
        FIRE: { actions: () => received++ },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const clock = (actor as AnyActorRef & { clock: { setTimeout: unknown; clearTimeout: unknown } })
    .clock;
  const { setTimeout, clearTimeout } = clock;
  const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.stock' });
  await origin.finished;
  expect(clock.setTimeout).toBe(setTimeout);
  actor.system.scheduler.cancel(actor, 'cancel');
  expect(clock.clearTimeout).toBe(clearTimeout);
  // The stock clock fires on a real timer.
  await vi.waitFor(() => expect(timerOperationSpans()).toHaveLength(1));
  expect(received).toBe(1);
  expect(timerOperationSpans()[0]?.links[0]?.context.spanId).toBe(origin.spanId);
  expectEmpty(tracing, actor);
});

it('keeps a reentrant replacement timer with the same ID independently indexed', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock(),
    event = { type: 'FIRE' };
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise(event, { delay: 10, id: 'retry' }) },
        FIRE: { actions: [() => received++, raise(event, { delay: 10, id: 'retry' })] },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.reentrant' });
  await origin.finished;
  clock.increment(10);
  await Promise.resolve();
  expect(timerOperationSpans()[0]?.links[0]?.context.spanId).toBe(origin.spanId);
  expect(handleIndex(tracing, actor)?.size).toBe(1);
  actor.system.scheduler.cancel(actor, 'retry');
  expectEmpty(tracing, actor);
  clock.increment(100);
  await Promise.resolve();
  expect(received).toBe(1);
});

it('keeps shared events, identical IDs, and different recipients in one deferred batch distinct', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: ({ actionType }) => ({ mode: 'new-linked-operation', name: actionType }),
  });
  const clock = new SimulatedClock(),
    event = Object.freeze({ type: 'FIRE' });
  const seen: object[] = [];
  const worker = setup({}).createMachine({
    on: {
      FIRE: {
        actions: ({ event }) => {
          seen.push(event);
        },
      },
    },
  });
  using actor = createTestActor(
    setup({ actors: { worker } }).createMachine({
      context: ({ spawn }) => ({ worker: spawn('worker', { id: 'worker' }) }),
      on: {
        RUN: {
          actions: [
            raise(event, { delay: 10, id: 'same' }),
            sendTo(({ context }) => context.worker, event, { delay: 20, id: 'same' }),
          ],
        },
        FIRE: {
          actions: ({ event }) => {
            seen.push(event);
          },
        },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.batch' });
  await origin.finished;
  clock.increment(10);
  await Promise.resolve();
  actor.system.scheduler.cancel(actor, 'same'); // The first firing cleared the ID slot.
  clock.increment(10);
  await Promise.resolve();
  expect(seen.every((received) => received === event)).toBe(true);
  expect(
    exporter
      .getFinishedSpans()
      .filter((span) => span.name.startsWith('xstate.'))
      .map((span) => [span.name, span.links[0]?.context.spanId]),
  ).toEqual([
    ['xstate.raise', origin.spanId],
    ['xstate.sendTo', origin.spanId],
  ]);
  expectEmpty(tracing, actor);
});

it('releases a large mixed-ID timer population on stop without copying records', async () => {
  const tracing = new XStateTracing(trace.getTracer('timer-stop'), {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock(),
    shared = { type: 'FIRE' },
    count = countRecordAccess(tracing);
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: {
          actions: enqueueActions(({ enqueue }) => {
            for (let i = 0; i < 10000; i++)
              enqueue.raise(shared, { delay: 1000, id: String(i % 5000) });
          }),
        },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.stop' }).finished;
  count.visits = 0;
  actor.stop();
  expect(count.visits).toBeLessThanOrEqual(10000);
  expectEmpty(tracing, actor);
});

it('releases deferred associations when the actor fails before native registration', async () => {
  const diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, {
    onDiagnostic: diagnostic,
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock(),
    event = { type: 'FIRE' };
  let sawRegistration = false;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: {
          actions: [
            raise(event, { delay: 10 }),
            () => {
              throw new Error('action failure');
            },
          ],
        },
      },
    }),
    {
      clock,
      inspect: (inspection) => {
        tracing.inspect(inspection);
        if (inspection.type === '@xstate.action' && inspection.action.type === 'xstate.raise') {
          sawRegistration =
            internals(tracing).timerRegistrations.get(inspection.actorRef)?.has(event) ?? false;
        }
      },
    },
  );
  const onError = vi.fn();
  actor.subscribe({ error: onError });
  actor.start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.failure' }).finished,
  ).resolves.toEqual({ outcome: 'failed', hadError: true });
  expect(sawRegistration).toBe(true);
  expect(actor.getSnapshot().status).toBe('error');
  expectEmpty(tracing, actor);
  actor.stop();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'associatedRootError',
    error: actor.getSnapshot().error,
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(actor.getSnapshot().error);
});

it('fails scheduled roots and removes timers cancelled by their error', async () => {
  const diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, {
    onDiagnostic: diagnostic,
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock();
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: {
          actions: [
            raise({ type: 'FAIL' }, { delay: 10 }),
            raise({ type: 'LATE' }, { delay: 1000 }),
          ],
        },
        FAIL: {
          actions: () => {
            throw new Error('scheduled failure');
          },
        },
      },
    }),
    { inspect: tracing.inspect, clock },
  );
  const onError = vi.fn();
  actor.subscribe({ error: onError });
  actor.start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.origin' }).finished;
  clock.increment(10);
  await tracing.waitForBookkeeping();
  expect(spanNames()).toContain('actorium.xstate.timer_operation');
  const scheduled = getSpan('actorium.xstate.timer_operation');
  expect(scheduled.attributes['actorium.xstate.operation.outcome']).toBe('failed');
  expect(scheduled.status.code).toBe(SpanStatusCode.ERROR);
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  expect(internals(tracing).processing.has(actor)).toBe(false);
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'associatedRootError',
    error: actor.getSnapshot().error,
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(actor.getSnapshot().error);
});

it.each(['new-linked-operation', 'untraced'] as const)(
  'stores no live operation for %s timers',
  async (mode) => {
    const tracing = new XStateTracing(tracer, { timerPolicy: { mode } });
    const clock = new SimulatedClock();
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: { actions: raise({ type: 'FIRE' }, { delay: 100000 }) },
        },
      }),
      { inspect: tracing.inspect, clock },
    ).start();
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'retention.origin' }).finished;
    const schedule = [...internals(tracing).timersByActor.get(actor)!][0] as {
      operation?: unknown;
    };
    expect(schedule.operation).toBeUndefined();
    actor.stop();
    expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  },
);

it('removes a timer record after its stopped recipient discards the firing', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock();
  const worker = setup({}).createMachine({});
  using actor = createTestActor(
    setup({ actors: { worker } }).createMachine({
      context: ({ spawn }) => ({ worker: spawn('worker', { id: 'worker' }) }),
      on: {
        RUN: { actions: sendTo(({ context }) => context.worker, { type: 'FIRE' }, { delay: 10 }) },
        STOP: { actions: stopChild(({ context }) => context.worker) },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.stopped' });
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  actor.send({ type: 'STOP' });
  expectStoppedActorWarnings(actor.getSnapshot().context.worker, ['FIRE'], () =>
    clock.increment(10),
  );
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
  expect(getSpan('timer.stopped').attributes['actorium.xstate.operation.outcome']).toBe(
    'completed',
  );
});

it('observes cancellation through the public scheduler without action inspection', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock();
  using actor = createTestActor(
    setup({}).createMachine({
      on: { RUN: { actions: raise({ type: 'FIRE' }, { delay: 10, id: 'timer' }) } },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'public.cancel' });
  actor.system.scheduler.cancel(actor, 'timer');
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  clock.increment(100);
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
});
