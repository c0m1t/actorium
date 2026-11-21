import { SpanStatusCode } from '@opentelemetry/api';
import { fromTransition, setup, type AnyActorRef } from 'xstate';
import { expect, it, vi } from 'vitest';
import { createXStateTracing, XStateTracing, type OperationTrace } from '../src/index.js';
import { createTestActor, internals, useTestTracer, expectReleased } from './helpers.js';

const { tracer, spans, getSpan } = useTestTracer('wait-for-bookkeeping');
// Settled also means no bookkeeping is pending.
function expectClean(tracing: XStateTracing, ...actors: AnyActorRef[]) {
  const runtime = internals(tracing);
  expect(runtime.bookkeeping.size).toBe(0);
  expect(runtime.activeBookkeeping).toBeUndefined();
  expectReleased(tracing, ...actors);
}

it.each(['factory', 'constructor'] as const)(
  'settles an empty %s runtime asynchronously and repeatedly',
  async (mode) => {
    const tracing =
      mode === 'factory' ? createXStateTracing({ tracer }) : new XStateTracing(tracer);
    let resolved = false;
    const first = tracing.waitForBookkeeping().then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
    await Promise.all([first, tracing.waitForBookkeeping()]);
    await tracing.waitForBookkeeping();
    expectClean(tracing);
    expect(spans()).toHaveLength(0);
  },
);

it.each([false, true])(
  'settles root error cleanup and finalization with reentrant throwing hook = %s',
  async (throws) => {
    const failure = new Error('original failure');
    let reentrant: Promise<void> | undefined;
    let reentrantCompleted = false;
    const diagnostic = vi.fn(() => {
      reentrant = tracing.waitForBookkeeping().then(() => {
        reentrantCompleted = true;
      });
      if (throws) throw new Error('diagnostic failed');
    });
    const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          FAIL: {
            actions: () => {
              throw failure;
            },
          },
        },
      }),
      { inspect: tracing.inspect },
    );
    const onError = vi.fn();
    actor.subscribe({ error: onError }); // Application-owned native error handling.
    actor.start();
    await tracing.waitForBookkeeping();
    const command = tracing.sendCommand(actor, { type: 'FAIL' }, { name: 'failure' });
    const first = tracing.waitForBookkeeping();
    const concurrent = tracing.waitForBookkeeping();
    expect(diagnostic).not.toHaveBeenCalled();
    await Promise.all([first, concurrent]);
    await reentrant;
    expect(reentrantCompleted).toBe(true);
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      phase: 'associatedRootError',
      error: failure,
    });
    expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
    expect(getSpan('failure').status.code).toBe(SpanStatusCode.ERROR);
    await expect(command.finished).resolves.toEqual({ outcome: 'failed', hadError: true });
    expectClean(tracing, actor);
    await tracing.waitForBookkeeping();
  },
);

it('observes plain root failures without a OperationTrace', async () => {
  const diagnostic = vi.fn();
  const tracing = createXStateTracing({ tracer, onDiagnostic: diagnostic });
  const failure = { original: true };
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        FAIL: {
          actions: () => {
            throw failure;
          },
        },
      },
    }),
    { inspect: tracing.inspect },
  );
  actor.subscribe({ error: vi.fn() });
  actor.start();
  actor.send({ type: 'FAIL' });
  await tracing.waitForBookkeeping();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'unassociatedRootError',
    error: failure,
  });
  expect(spans()).toHaveLength(0);
  expectClean(tracing, actor);
});

it('releases terminal work registrations and follows cleanup into operation finalization', async () => {
  const tracing = new XStateTracing(tracer);
  let complete!: () => void;
  const business = new Promise<void>((resolve) => {
    complete = resolve;
  });
  const work = tracing.fromPromise('work', () => business);
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: { invoke: { id: 'work', src: 'work', onDone: 'done' } },
        done: { type: 'final' },
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'completion' });
  const child = actor.getSnapshot().children.work!;
  // An application observation identifies the business boundary, rather than
  // making waitForBookkeeping responsible for waiting on a Promise that has not completed.
  const done = new Promise<void>((resolve) => actor.subscribe({ complete: resolve }));
  complete();
  await done;
  await tracing.waitForBookkeeping();
  expect(spans().map((span) => span.name)).toEqual(['work', 'completion']);
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  expectClean(tracing, actor, child);
});

it('leaves pending business work and pre-start mailboxes open, then settles cancellation', async () => {
  const tracing = new XStateTracing(tracer);
  const input = Object.freeze({ business: true });
  const implementation = vi.fn((_args: { input: unknown }) => new Promise<never>(() => {}));
  using actor = createTestActor(
    setup({
      actors: { work: tracing.fromPromise('pending.work', implementation) },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: { invoke: { id: 'work', src: 'work', input } },
      },
    }),
    { inspect: tracing.inspect },
  );
  const event = { type: 'RUN' };
  const command = tracing.sendCommand(actor, event, { name: 'pending.command' });
  let finished = false;
  void command.finished.then(() => {
    finished = true;
  });
  await tracing.waitForBookkeeping();
  expect(finished).toBe(false);
  expect(implementation).not.toHaveBeenCalled();
  expect(spans()).toHaveLength(0);
  actor.start();
  const child = actor.getSnapshot().children.work!;
  await tracing.waitForBookkeeping();
  expect(implementation.mock.calls[0]?.[0].input).toBe(input);
  expect(finished).toBe(false);
  expect(spans()).toHaveLength(0);
  actor.stop();
  await tracing.waitForBookkeeping();
  expect(spans().map((span) => span.name)).toEqual(['pending.work', 'pending.command']);
  await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
  expectClean(tracing, actor, child);
});

it('settles silent pre-start stop and stopped-active snapshots without lifecycle subscriptions', async () => {
  const tracing = new XStateTracing(tracer);
  using actor = createTestActor(
    fromTransition((state) => state, {}),
    { inspect: tracing.inspect },
  );
  const subscribe = vi.spyOn(actor, 'subscribe');
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'prestart' });
  actor.stop();
  await tracing.waitForBookkeeping();
  await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
  expectClean(tracing, actor);
  using active = createTestActor(
    fromTransition((state) => state, {}),
    { inspect: tracing.inspect },
  ).start();
  active.stop();
  expect(active.getSnapshot().status).toBe('active');
  await tracing.waitForBookkeeping();
  expectClean(tracing, active);
  expect(subscribe).not.toHaveBeenCalled();
});

it('excludes later independent callbacks while including synchronous reentrant follow-ups', async () => {
  // Control the native queue to observe the precise boundary without timing races.
  const callbacks: Array<() => void> = [];
  const microtask = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    callbacks.push(callback);
  });
  try {
    const tracing = new XStateTracing(tracer);
    const runtime = internals(tracing);
    using actor = createTestActor(setup({}).createMachine({}), {
      inspect: tracing.inspect,
    }).start();
    let later: OperationTrace | undefined;
    let reentrant: Promise<void> | undefined;
    runtime.scheduleBookkeeping(() => {
      reentrant = tracing.waitForBookkeeping();
      later = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'followup' });
    });
    const first = tracing.waitForBookkeeping();
    // Enqueued after first's boundary, with a follow-up that must remain pending.
    runtime.scheduleBookkeeping(() => runtime.scheduleBookkeeping(() => {}));
    callbacks.shift()!(); // Initial actor lifecycle check.
    callbacks.shift()!(); // Included callback and synchronous reentrant work.
    callbacks.shift()!(); // Independent callback; queues an excluded follow-up.
    // Included finalization and lifecycle checks precede excluded follow-up.
    callbacks.shift()!();
    callbacks.shift()!();
    await first;
    expect(spans().some((span) => span.name === 'followup')).toBe(true);
    expect(runtime.bookkeeping.size).toBe(1);
    const includedGroups = [...runtime.bookkeeping];
    expect(includedGroups[0]?.waiters.length).toBeGreaterThan(0); // Reentrant call includes it.
    callbacks.shift()!();
    await reentrant;
    await later!.finished;
    expect(includedGroups[0]?.waiters).toEqual([]);
    expectClean(tracing);
    actor.stop();
    while (callbacks.length) callbacks.shift()!();
  } finally {
    microtask.mockRestore();
  }
});

it('releases accounting even when a queued callback fails, preserving its throw', async () => {
  const callbacks: Array<() => void> = [];
  const microtask = vi.spyOn(globalThis, 'queueMicrotask').mockImplementation((callback) => {
    callbacks.push(callback);
  });
  try {
    const tracing = new XStateTracing(tracer);
    const runtime = internals(tracing);
    const failure = new Error('callback failure');
    runtime.scheduleBookkeeping(() => {
      throw failure;
    });
    const settlement = tracing.waitForBookkeeping();
    const group = [...runtime.bookkeeping][0]!;
    expect(() => callbacks.shift()!()).toThrow(failure);
    await settlement;
    expect(group.waiters).toEqual([]);
    expectClean(tracing);
  } finally {
    microtask.mockRestore();
  }
});
