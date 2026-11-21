import { SpanStatusCode, trace } from '@opentelemetry/api';
import {
  setup,
  type AnyActorRef,
  sendTo,
  stopChild,
  fromTransition,
  type AnyEventObject,
} from 'xstate';
import { expect, it, vi } from 'vitest';
import { XStateTracing, type OperationTrace } from '../src/index.js';
import {
  createTestActor,
  internals,
  expectStoppedActorWarnings,
  deferred,
  useTestTracer,
  type MirroredEntryRecord,
} from './helpers.js';

const { tracer, spansNamed, getSpan } = useTestTracer('delivery-queue');

// Count collection access rather than timing. A Proxy makes Array.shift's
// movement of the remaining entries observable, without depending on V8's
// array optimization thresholds or the speed of the test machine.
function countQueueAccesses(tracing: XStateTracing, actor: AnyActorRef) {
  const runtime = internals(tracing);
  const queued = runtime.queued.get(actor)!;
  const count = { accesses: 0 };
  runtime.queued.set(
    actor,
    new Proxy(queued, {
      get(target, key, receiver) {
        count.accesses++;
        return Reflect.get(target, key, receiver);
      },
      set(target, key, value, receiver) {
        count.accesses++;
        return Reflect.set(target, key, value, receiver);
      },
      deleteProperty(target, key) {
        count.accesses++;
        return Reflect.deleteProperty(target, key);
      },
    }),
  );
  return count;
}

it.each(['pre-start', 'reentrant'] as const)(
  'drains %s backlog with linear collection access',
  (mode) => {
    const tracing = new XStateTracing(tracer);
    const size = 1000;
    let count: { accesses: number } | undefined;
    let received = 0;
    let ordered = true;
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          QUEUED: {
            actions: ({ event }) => {
              ordered &&= event.sequence === received;
              received++;
            },
          },
          BURST: {
            actions: ({ self }) => {
              for (let i = 0; i < size; i++) self.send({ type: 'QUEUED', sequence: i });
              count = countQueueAccesses(tracing, self);
            },
          },
        },
      }),
      { inspect: tracing.inspect },
    );
    if (mode === 'pre-start') {
      for (let i = 0; i < size; i++) actor.send({ type: 'QUEUED', sequence: i });
      count = countQueueAccesses(tracing, actor);
      actor.start();
    } else {
      actor.start();
      actor.send({ type: 'BURST' });
    }
    expect(received).toBe(size);
    expect(ordered).toBe(true);
    // Allow constant overhead for init/cleanup and each dequeue, while rejecting
    // aggregate work proportional to the square of the backlog.
    expect(count!.accesses).toBeLessThanOrEqual(size * 64 + 100);
    expect(internals(tracing).processing.has(actor)).toBe(false);
    expect(internals(tracing).queued.has(actor)).toBe(false);
  },
);

it.each(['pre-start', 'reentrant'] as const)(
  'drains 100,000 %s deliveries in order without ledger history',
  (mode) => {
    const tracing = new XStateTracing(tracer);
    const size = 100000;
    let received = 0;
    let ordered = true;
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          QUEUED: {
            actions: ({ event }) => {
              ordered &&= event.sequence === received;
              received++;
            },
          },
          BURST: {
            actions: ({ self }) => {
              for (let i = 0; i < size; i++) self.send({ type: 'QUEUED', sequence: i });
            },
          },
        },
      }),
      { inspect: tracing.inspect },
    );
    if (mode === 'pre-start') {
      for (let i = 0; i < size; i++) actor.send({ type: 'QUEUED', sequence: i });
      actor.start();
    } else {
      actor.start();
      actor.send({ type: 'BURST' });
    }
    expect(received).toBe(size);
    expect(ordered).toBe(true);
    expect(internals(tracing).processing.has(actor)).toBe(false);
    expect(internals(tracing).queued.has(actor)).toBe(false);
  },
  15000,
);

it('reconciles a snapshot by identity while another delivery awaits acceptance', async () => {
  const tracing = new XStateTracing(tracer);
  const outer = { type: 'NOTE', value: 'outer' };
  const inner = { type: 'NOTE', value: 'inner' };
  const received: string[] = [];
  let nested: OperationTrace | undefined;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        NOTE: {
          actions: ({ event }) => {
            received.push(event.value as string);
          },
        },
      },
    }),
    {
      inspect: (inspection) => {
        tracing.inspect(inspection);
        if (inspection.type === '@xstate.event' && inspection.event === outer) {
          // The next inspector sends before XState accepts the original event;
          // the nested delivery's snapshot must not consume the original record.
          nested = tracing.sendCommand(inspection.actorRef as AnyActorRef, inner, {
            name: 'queue.inner',
          });
        }
      },
    },
  ).start();
  const original = tracing.sendCommand(actor, outer, { name: 'queue.outer' });
  await expect(original.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  await expect(nested!.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(received).toEqual(['inner', 'outer']);
  expect(internals(tracing).processing.has(actor)).toBe(false);
  expect(internals(tracing).queued.has(actor)).toBe(false);
});

it('cancels a large mixed backlog without delivering or retaining discarded entries', async () => {
  const tracing = new XStateTracing(tracer);
  const commands: OperationTrace[] = [];
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        QUEUED: { actions: () => received++ },
      },
    }),
    { inspect: tracing.inspect },
  );
  for (let i = 0; i < 10000; i++) {
    const event = { type: 'QUEUED', sequence: i };
    if (i % 3333 === 0)
      commands.push(tracing.sendCommand(actor, event, { name: 'queue.cancelled' }));
    else actor.send(event);
  }
  actor.stop();
  for (const command of commands) {
    await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
  }
  expect(received).toBe(0);
  expect(internals(tracing).processing.has(actor)).toBe(false);
  expect(internals(tracing).queued.has(actor)).toBe(false);
});

it('does not retain consumed payloads while the actor still has queued work', () => {
  const tracing = new XStateTracing(tracer);
  const consumed = { type: 'QUEUED', payload: new Uint8Array(1024) };
  let checked = false;
  let retained = false;
  using actor = createTestActor(setup({}).createMachine({}), {
    inspect: (inspection) => {
      tracing.inspect(inspection);
      if (inspection.type === '@xstate.snapshot' && inspection.event === consumed) {
        const runtime = internals(tracing);
        checked = runtime.queued.has(inspection.actorRef);
        // Inspect the bookkeeping graph without assuming an array, indices,
        // or link names. A surviving backlog must not retain the consumed event.
        const pending: unknown[] = [
          runtime.processing.get(inspection.actorRef),
          runtime.queued.get(inspection.actorRef),
        ];
        const visited = new Set<object>();
        while (pending.length) {
          const value = pending.pop();
          if (!value || typeof value !== 'object' || visited.has(value)) continue;
          if (value === consumed) retained = true;
          visited.add(value);
          pending.push(...Object.values(value));
        }
      }
    },
  });
  actor.send(consumed);
  for (let i = 0; i < 3; i++) actor.send({ type: 'QUEUED' });
  actor.start();
  expect(checked).toBe(true);
  expect(retained).toBe(false);
});

it('discards late payloads and settles relays to stopped children', async () => {
  const tracing = new XStateTracing(tracer);
  const worker = setup({}).createMachine({});
  const machine = setup({ actors: { worker } }).createMachine({
    context: ({ spawn }) => ({ worker: spawn('worker', { id: 'worker' }) }),
    on: {
      STOP: { actions: stopChild(({ context }) => context.worker) },
      RUN: { actions: sendTo(({ context }) => context.worker, { type: 'WORK' }) },
    },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
  actor.send({ type: 'STOP' });
  const child = actor.getSnapshot().context.worker;
  const command = expectStoppedActorWarnings(
    child,
    [...Array<string>(100).fill('LATE'), 'WORK'],
    () => {
      for (let i = 0; i < 100; i++) child.send({ type: 'LATE', payload: new Uint8Array(1024) });
      return tracing.sendCommand(actor, { type: 'RUN' }, { name: 'stopped.relay' });
    },
  );
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(internals(tracing).processing.has(child)).toBe(false);
  expect(internals(tracing).queued.has(child)).toBe(false);
  const span = getSpan('stopped.relay');
  expect(span.status.code).toBe(SpanStatusCode.UNSET);
  expect(span.attributes['actorium.xstate.operation.outcome']).toBe('completed');
  expect(span.attributes['actorium.xstate.operation.terminal_recipient_event_count']).toBe(1);
  expect(span.attributes['actorium.xstate.operation.had_error']).toBeUndefined();
  expect(
    span.events.filter((event) => event.name === 'actorium.xstate.event.recipient_terminal'),
  ).toEqual([
    expect.objectContaining({
      attributes: {
        'actorium.xstate.actor.id': 'worker',
        'actorium.xstate.event.type': 'WORK',
        'actorium.xstate.event.terminal_reason': 'stopped',
      },
    }),
  ]);
});

it('completes an operation whose relay to a child stopped in the same macrostep is refused', async () => {
  const tracing = new XStateTracing(tracer, { actorIdAttribute: 'app.actor' });
  const worker = setup({}).createMachine({});
  // The payload must never reach span attributes.
  const workEvent = { type: 'WORK', secret: 'payload' };
  const machine = setup({ actors: { worker } }).createMachine({
    context: ({ spawn }) => ({ worker: spawn('worker', { id: 'worker' }) }),
    on: {
      RUN: {
        actions: [
          stopChild(({ context }) => context.worker),
          sendTo(({ context }) => context.worker, workEvent),
          sendTo(({ context }) => context.worker, { type: 'MORE' }),
        ],
      },
    },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
  const child = actor.getSnapshot().context.worker;
  const command = expectStoppedActorWarnings(child, ['WORK', 'MORE'], () =>
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'same.macrostep' }),
  );
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  const span = getSpan('same.macrostep');
  expect(span.attributes['actorium.xstate.operation.terminal_recipient_event_count']).toBe(2);
  expect(
    span.events
      .filter((event) => event.name === 'actorium.xstate.event.recipient_terminal')
      .map((event) => event.attributes),
  ).toEqual([
    {
      'app.actor': 'worker',
      'actorium.xstate.event.type': 'WORK',
      'actorium.xstate.event.terminal_reason': 'stopped',
    },
    {
      'app.actor': 'worker',
      'actorium.xstate.event.type': 'MORE',
      'actorium.xstate.event.terminal_reason': 'stopped',
    },
  ]);
  expect(internals(tracing).processing.has(child)).toBe(false);
  expect(internals(tracing).queued.has(child)).toBe(false);
});

it('keeps traced work open and completes it after a refused relay', async () => {
  const tracing = new XStateTracing(tracer, { actorIdAttribute: false });
  const pending = deferred<string>();
  const work = tracing.fromPromise('relay.work', () => pending.promise);
  const worker = setup({}).createMachine({});
  const machine = setup({ actors: { worker, work } }).createMachine({
    context: ({ spawn }) => ({ worker: spawn('worker', { id: 'worker' }) }),
    initial: 'idle',
    states: {
      idle: {
        on: {
          STOP: { actions: stopChild(({ context }) => context.worker) },
          RUN: {
            target: 'working',
            actions: sendTo(({ context }) => context.worker, { type: 'NOTIFY' }),
          },
        },
      },
      working: { invoke: { src: 'work', onDone: 'idle' } },
    },
  });
  using actor = createTestActor(machine, { inspect: tracing.inspect }).start();
  actor.send({ type: 'STOP' });
  const child = actor.getSnapshot().context.worker;
  let settled = false;
  const command = expectStoppedActorWarnings(child, ['NOTIFY'], () =>
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'relay.with.work' }),
  );
  void command.finished.then(() => {
    settled = true;
  });
  await tracing.waitForBookkeeping();
  expect(settled).toBe(false);
  pending.resolve('done');
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  const span = getSpan('relay.with.work');
  expect(span.attributes['actorium.xstate.operation.terminal_recipient_event_count']).toBe(1);
  expect(
    span.events.find((event) => event.name === 'actorium.xstate.event.recipient_terminal')
      ?.attributes,
  ).toEqual({
    'actorium.xstate.event.type': 'NOTIFY',
    'actorium.xstate.event.terminal_reason': 'stopped',
  });
});

it('recognizes stopped transition actors with active snapshots', async () => {
  const tracing = new XStateTracing(tracer);
  using actor = createTestActor(
    fromTransition((state) => state, {}),
    { inspect: tracing.inspect },
  ).start();
  actor.stop();
  expect(actor.getSnapshot().status).toBe('active');
  await expect(
    expectStoppedActorWarnings(actor, ['RUN'], () =>
      tracing.sendCommand(actor, { type: 'RUN' }, { name: 'transition.stopped' }),
    ).finished,
  ).resolves.toEqual({ outcome: 'target_terminal', hadError: false });
  expect(getSpan('transition.stopped').attributes['actorium.xstate.operation.outcome_reason']).toBe(
    'stopped',
  );
  expectStoppedActorWarnings(actor, ['LATE'], () => actor.send({ type: 'LATE' }));
  expect(internals(tracing).processing.has(actor)).toBe(false);
});

it('adds no lifecycle subscriptions across synchronous command bursts', async () => {
  const tracing = new XStateTracing(tracer);
  using actor = createTestActor(setup({}).createMachine({}), { inspect: tracing.inspect }).start();
  const subscribe = vi.spyOn(actor, 'subscribe');
  const commands = Array.from({ length: 1000 }, () =>
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'burst' }),
  );
  await Promise.all(commands.map((command) => command.finished));
  expect(subscribe).not.toHaveBeenCalled();
  expect(internals(tracing).processing.has(actor)).toBe(false);
});

it.each([false, true])('settles cross-system relays with shared runtime = %s', async (shared) => {
  const tracing = new XStateTracing(tracer);
  const targetTracing = shared ? tracing : new XStateTracing(tracer);
  let received = 0;
  using target = createTestActor(
    setup({}).createMachine({ on: { WORK: { actions: () => received++ } } }),
    { inspect: targetTracing.inspect },
  ).start();
  using source = createTestActor(
    setup({}).createMachine({ on: { RUN: { actions: sendTo(target, { type: 'WORK' }) } } }),
    { inspect: tracing.inspect },
  ).start();
  await expect(
    tracing.sendCommand(source, { type: 'RUN' }, { name: 'cross.system' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(received).toBe(1);
  expect(internals(tracing).processing.has(target)).toBe(false);
  source.stop();
});

it('reports hadError when synchronous send throws', async () => {
  const tracing = new XStateTracing(tracer);
  using actor = createTestActor(setup({}).createMachine({}), { inspect: tracing.inspect }).start();
  vi.spyOn(actor, 'send').mockImplementation(() => {
    throw new Error('send failed');
  });
  expect(() => tracing.sendCommand(actor, { type: 'RUN' }, { name: 'send.failure' })).toThrow(
    'send failed',
  );
  const span = getSpan('send.failure');
  expect(span.attributes['actorium.xstate.operation.had_error']).toBe(true);
  expect(span.attributes['actorium.xstate.operation.outcome']).toBe('failed');
  actor.stop();
});

it.each([true, false])(
  'rolls back rejected sends and traces later work with recording = %s',
  async (recording) => {
    const tracing = new XStateTracing(recording ? tracer : trace.getTracer('noop.rollback'));
    const failure = new Error('application inspector failed');
    const rejected: MirroredEntryRecord[] = [];
    const implementation = vi.fn(async () => 'done');
    const work = tracing.fromPromise<string, object>('rollback.work', implementation);
    using actor = createTestActor(
      setup({ actors: { work } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: {
            invoke: {
              src: 'work',
              input: () => ({}),
              onDone: 'idle',
            },
          },
        },
      }),
      {
        inspect: (inspection) => {
          tracing.inspect(inspection);
          if (inspection.type === '@xstate.event' && inspection.event.type === 'FAIL') {
            rejected.push(internals(tracing).processing.get(inspection.actorRef)!);
            throw failure;
          }
        },
      },
    ).start();

    for (let i = 0; i < 100; i++) {
      const event = { type: 'FAIL', payload: new Uint8Array(1024) };
      let caught: unknown;
      try {
        tracing.sendCommand(actor, event, { name: 'rollback.failed' });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(failure);
      expect(internals(tracing).processing.has(actor)).toBe(false);
      expect(internals(tracing).queued.has(actor)).toBe(false);
      expect(internals(tracing).pendingCommands.has(event)).toBe(false);
    }
    for (const delivery of rejected) {
      expect(delivery.operation?.pendingEventCount).toBe(0);
      expect(delivery.operation?.ended).toBe(true);
      await expect(delivery.operation?.finished).resolves.toEqual({
        outcome: 'failed',
        hadError: true,
      });
    }

    const later = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'rollback.later' });
    await expect(later.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(implementation).toHaveBeenCalledOnce();
    expect(internals(tracing).processing.has(actor)).toBe(false);
    expect(internals(tracing).queued.has(actor)).toBe(false);
    if (recording) {
      const failed = spansNamed('rollback.failed');
      expect(failed).toHaveLength(100);
      expect(failed.every((span) => span.status.code === SpanStatusCode.ERROR)).toBe(true);
      expect(getSpan('rollback.work').parentSpanContext?.spanId).toBe(later.spanId);
    }
  },
);

it('rolls back only rejected commands in a mixed reentrant mailbox', async () => {
  const tracing = new XStateTracing(tracer);
  const failure = new Error('reentrant inspector failed');
  const shared = Object.freeze({ type: 'NOTE' });
  const commands: OperationTrace[] = [];
  const caught: unknown[] = [];
  const rejected: MirroredEntryRecord[] = [];
  const seen: { event: AnyEventObject; operationId: number | undefined }[] = [];
  let reject = false;
  let headAfterRollback: MirroredEntryRecord | undefined;
  let queueAfterRollback: MirroredEntryRecord[] = [];
  const work = tracing.fromPromise<string, object>('mixed.work', async () => 'done');
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            RUN: {
              actions: ({ self }) => {
                self.send(shared);
                commands.push(tracing.sendCommand(self, shared, { name: 'mixed.accepted' }));
                reject = true;
                for (let i = 0; i < 2; i++) {
                  try {
                    tracing.sendCommand(self, shared, { name: 'mixed.rejected' });
                  } catch (error) {
                    caught.push(error);
                  }
                }
                reject = false;
                self.send(shared);
                commands.push(tracing.sendCommand(self, { type: 'WORK' }, { name: 'mixed.later' }));
                headAfterRollback = internals(tracing).processing.get(self);
                queueAfterRollback = [...internals(tracing).queued.get(self)!];
              },
            },
            NOTE: {
              actions: ({ self, event }) => {
                seen.push({
                  event,
                  operationId: internals(tracing).processing.get(self)?.operation?.id,
                });
              },
            },
            WORK: 'working',
          },
        },
        working: {
          invoke: {
            src: 'work',
            input: () => ({}),
            onDone: 'idle',
          },
        },
      },
    }),
    {
      inspect: (inspection) => {
        tracing.inspect(inspection);
        if (reject && inspection.type === '@xstate.event' && inspection.event === shared) {
          rejected.push([...internals(tracing).queued.get(inspection.actorRef)!].at(-1)!);
          throw failure;
        }
      },
    },
  ).start();

  const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'mixed.origin' });
  await Promise.all([origin, ...commands].map((command) => command.finished));
  expect(caught).toEqual([failure, failure]);
  expect(headAfterRollback?.operation?.id).toBe(origin.operationId);
  expect(queueAfterRollback.map((delivery) => delivery.operation?.id)).toEqual([
    undefined,
    commands[0]!.operationId,
    undefined,
    commands[1]!.operationId,
  ]);
  expect(seen.map((item) => item.event)).toEqual([shared, shared, shared]);
  expect(seen.every((item) => item.event === shared)).toBe(true);
  expect(seen.map((item) => item.operationId)).toEqual([
    undefined,
    commands[0]!.operationId,
    undefined,
  ]);
  for (const delivery of rejected) {
    expect(delivery.operation?.pendingEventCount).toBe(0);
    await expect(delivery.operation?.finished).resolves.toEqual({
      outcome: 'failed',
      hadError: true,
    });
  }
  expect(getSpan('mixed.work').parentSpanContext?.spanId).toBe(commands[1]!.spanId);
  expect(internals(tracing).processing.has(actor)).toBe(false);
  expect(internals(tracing).queued.has(actor)).toBe(false);
});

it('restores accepted deliveries queued behind a rejected head', async () => {
  const tracing = new XStateTracing(tracer);
  const failure = new Error('head inspector failed');
  const note = { type: 'NOTE' };
  const seen: AnyEventObject[] = [];
  let accepted!: OperationTrace;
  let rejected: MirroredEntryRecord | undefined;
  const work = tracing.fromPromise<string, object>('head.work', async () => 'done');
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: {
          on: {
            NOTE: {
              actions: ({ event }) => {
                seen.push(event);
              },
            },
            WORK: 'working',
          },
        },
        working: {
          invoke: {
            src: 'work',
            input: () => ({}),
            onDone: 'idle',
          },
        },
      },
    }),
    {
      inspect: (inspection) => {
        tracing.inspect(inspection);
        if (inspection.type === '@xstate.event' && inspection.event.type === 'FAIL') {
          rejected = internals(tracing).processing.get(inspection.actorRef);
          const recipient = inspection.actorRef as AnyActorRef;
          recipient.send(note);
          accepted = tracing.sendCommand(recipient, { type: 'WORK' }, { name: 'head.accepted' });
          throw failure;
        }
      },
    },
  );

  expect(() => tracing.sendCommand(actor, { type: 'FAIL' }, { name: 'head.rejected' })).toThrow(
    failure,
  );
  expect(rejected?.operation?.pendingEventCount).toBe(0);
  await expect(rejected?.operation?.finished).resolves.toEqual({
    outcome: 'failed',
    hadError: true,
  });
  expect(internals(tracing).processing.get(actor)?.event).toBe(note);
  expect(
    [...internals(tracing).queued.get(actor)!].map((delivery) => delivery.operation?.id),
  ).toEqual([accepted.operationId]);
  actor.start();
  await expect(accepted.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expect(seen).toEqual([note]);
  expect(getSpan('head.work').parentSpanContext?.spanId).toBe(accepted.spanId);
  expect(internals(tracing).processing.has(actor)).toBe(false);
  expect(internals(tracing).queued.has(actor)).toBe(false);
});
