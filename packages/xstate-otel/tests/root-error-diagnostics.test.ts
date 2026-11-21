import { diag, SpanStatusCode } from '@opentelemetry/api';
import {
  createActor,
  fromCallback,
  fromTransition,
  setup,
  SimulatedClock,
  raise,
  type AnyActorRef,
} from 'xstate';
import { expect, it, vi } from 'vitest';
import { XStateTracing, type TelemetryDiagnostic } from '../src/index.js';
import {
  deferred,
  createTestActor,
  internals,
  useTestTracer,
  expectReleased,
  expectStoppedActorWarnings,
} from './helpers.js';

const { tracer, spans, spanNames, getSpan } = useTestTracer('root-error-diagnostics');
// A failed root also drops its lifecycle check.
function expectClean(tracing: XStateTracing, actor: AnyActorRef) {
  expectReleased(tracing, actor);
  expect(internals(tracing).lifecycleChecks.has(actor), 'lifecycleChecks').toBe(false);
}
function failingMachine(failure: unknown) {
  return setup({}).createMachine({
    on: {
      FAIL: {
        actions: () => {
          throw failure;
        },
      },
    },
  });
}

it.each([new Error('root failure'), 'string failure'])(
  'reports an unassociated original value after send and cleans its ledger: %s',
  async (failure) => {
    const diagnostic = vi.fn();
    const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
    using actor = createTestActor(failingMachine(failure), { inspect: tracing.inspect });
    const first = vi.fn(),
      second = vi.fn();
    actor.subscribe({ error: first });
    actor.subscribe({ error: second });
    actor.start();
    actor.send({ type: 'FAIL' });
    expect(actor.getSnapshot().error).toBe(failure);
    expect(diagnostic).not.toHaveBeenCalled();
    await tracing.waitForBookkeeping();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
      phase: 'unassociatedRootError',
      error: failure,
    });
    expect(first).toHaveBeenCalledExactlyOnceWith(failure);
    expect(second).toHaveBeenCalledExactlyOnceWith(failure);
    expect(spans()).toHaveLength(0);
    await Promise.resolve();
    expectClean(tracing, actor);
  },
);

it.each([false, true])(
  'does not log roots itself when an optional hook throws = %s',
  async (throws) => {
    const failure = new Error('business error');
    const reporting = vi.spyOn(console, 'error').mockImplementation(() => {
      throw new Error('console must not run');
    });
    const warning = vi.spyOn(diag, 'warn').mockImplementation(() => {
      throw new Error('diag must not run');
    });
    try {
      const hook = vi.fn((_diagnostic: TelemetryDiagnostic) => {
        if (throws) throw new Error('hook failed');
      });
      const diagnostic = throws ? hook : undefined;
      const tracing = new XStateTracing(tracer, diagnostic ? { onDiagnostic: diagnostic } : {});
      using actor = createTestActor(failingMachine(failure), { inspect: tracing.inspect });
      const onError = vi.fn();
      actor.subscribe({ error: onError });
      actor.start();
      actor.send({ type: 'FAIL' });
      await Promise.resolve();
      await Promise.resolve();
      expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
      expect(hook).toHaveBeenCalledTimes(throws ? 1 : 0);
      expect(reporting).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expectClean(tracing, actor);
    } finally {
      reporting.mockRestore();
      warning.mockRestore();
    }
  },
);

it('balances abandoned pre-start commands before invoking a throwing diagnostic hook', async () => {
  const failure = new Error('startup failure');
  let actor: AnyActorRef;
  let tracing: XStateTracing;
  let clearedBeforeDiagnostic = false;
  const diagnostic = vi.fn(() => {
    clearedBeforeDiagnostic =
      !internals(tracing).processing.has(actor) && !internals(tracing).queued.has(actor);
    throw new Error('diagnostic failure');
  });
  tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
  actor = createActor(
    setup({}).createMachine({
      entry: () => {
        throw failure;
      },
    }),
    { inspect: tracing.inspect },
  );
  const onError = vi.fn();
  actor.subscribe({ error: onError });
  const commands = [
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'startup.first' }),
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'startup.second' }),
  ];
  actor.start();
  for (const command of commands)
    await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'unassociatedRootError',
    error: failure,
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(clearedBeforeDiagnostic).toBe(true);
  expect(spans()).toHaveLength(2);
  expect(spans().every((span) => span.status.code !== SpanStatusCode.ERROR)).toBe(true);
  expectClean(tracing, actor);
});

it('waits for startup before reporting an initial context error', async () => {
  const failure = new Error('context failed'),
    diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
  using actor = createTestActor(
    setup({}).createMachine({
      context: () => {
        throw failure;
      },
    }),
    { inspect: tracing.inspect },
  );
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'prestart.terminal' }).finished;
  expect(diagnostic).not.toHaveBeenCalled();
  const onError = vi.fn();
  actor.subscribe({ error: onError });
  actor.start();
  await tracing.waitForBookkeeping();
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'unassociatedRootError',
    error: failure,
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(spans()[0]?.attributes['actorium.xstate.operation.outcome']).toBe('target_terminal');
  expect(spans()[0]?.attributes['actorium.xstate.operation.outcome_reason']).toBe('error');
});

it('preserves associated failure spans and cleanup with immediate stop', async () => {
  const failure = new Error('command failure'),
    diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
  using actor = createTestActor(failingMachine(failure), { inspect: tracing.inspect });
  const onError = vi.fn();
  actor.subscribe({ error: onError });
  actor.start();
  const command = tracing.sendCommand(actor, { type: 'FAIL' }, { name: 'root.failure' });
  actor.stop();
  await expect(command.finished).resolves.toEqual({
    outcome: 'failed',
    hadError: true,
  });
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'associatedRootError',
    error: failure,
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(spans()).toHaveLength(1);
  expect(spans()[0]?.status.code).toBe(SpanStatusCode.ERROR);
  expect(spans()[0]?.events.filter((event) => event.name === 'exception')).toHaveLength(1);
  expectClean(tracing, actor);
});

it('does not borrow an ended command for a later root failure', async () => {
  const failure = new Error('later error'),
    diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
  using actor = createTestActor(failingMachine(failure), { inspect: tracing.inspect });
  actor.subscribe({ error: vi.fn() });
  actor.start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'previous' }).finished;
  actor.send({ type: 'FAIL' });
  await tracing.waitForBookkeeping();
  expect(diagnostic).toHaveBeenCalledOnce();
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'unassociatedRootError',
    error: failure,
  });
  expect(spans()).toHaveLength(1);
  expect(spans()[0]?.status.code).not.toBe(SpanStatusCode.ERROR);
});

it.each([false, true])(
  'reconciles nested child failure before parent relay; handled = %s',
  async (handled) => {
    const failure = new Error('child failure'),
      diagnostic = vi.fn();
    const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
    const child = fromCallback(() => {
      throw failure;
    });
    const nested = setup({ actors: { child } }).createMachine({ invoke: { src: 'child' } });
    using actor = createTestActor(
      setup({ actors: { nested } }).createMachine({
        initial: 'idle',
        states: {
          idle: { on: { RUN: 'working' } },
          working: { invoke: { src: 'nested', ...(handled ? { onError: 'recovered' } : {}) } },
          recovered: {},
        },
      }),
      { inspect: tracing.inspect },
    );
    const onError = vi.fn();
    actor.subscribe({ error: onError });
    actor.start();
    await expect(
      tracing.sendCommand(actor, { type: 'RUN' }, { name: 'child.operation' }).finished,
    ).resolves.toEqual({ outcome: handled ? 'completed' : 'failed', hadError: true });
    expect(diagnostic).toHaveBeenCalledTimes(handled ? 0 : 1);
    if (!handled)
      expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
        phase: 'associatedRootError',
        error: failure,
      });
    expect(onError).toHaveBeenCalledTimes(handled ? 0 : 1);
    expectClean(tracing, actor);
  },
);

it('reports a linked timer root failure while preserving timer cleanup', async () => {
  const diagnostic = vi.fn(),
    clock = new SimulatedClock();
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
    onDiagnostic: diagnostic,
  });
  const failure = new Error('timer failure');
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: {
          actions: [
            raise({ type: 'FAIL' }, { delay: 10 }),
            raise({ type: 'LATE' }, { delay: 100 }),
          ],
        },
        FAIL: {
          actions: () => {
            throw failure;
          },
        },
      },
    }),
    { inspect: tracing.inspect, clock },
  );
  actor.subscribe({ error: vi.fn() });
  actor.start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.origin' }).finished;
  clock.increment(10);
  await tracing.waitForBookkeeping();
  expect(spanNames()).toContain('actorium.xstate.timer_operation');
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'associatedRootError',
    error: failure,
  });
  expect(getSpan('actorium.xstate.timer_operation').status.code).toBe(SpanStatusCode.ERROR);
  expectClean(tracing, actor);
});

it('never subscribes to newly observed actors and coalesces ordinary delivery checks', async () => {
  const tracing = new XStateTracing(tracer);
  let subscriptions: ReturnType<typeof vi.spyOn> | undefined;
  using actor = createTestActor(setup({}).createMachine({}), {
    inspect: (event) => {
      if (event.type === '@xstate.actor')
        subscriptions = vi.spyOn(event.actorRef as AnyActorRef, 'subscribe');
      tracing.inspect(event);
    },
  }).start();
  await Promise.resolve();
  expect(subscriptions).not.toHaveBeenCalled();
  const microtasks = vi.spyOn(globalThis, 'queueMicrotask');
  try {
    for (let i = 0; i < 1000; i++) actor.send({ type: 'RUN' });
    expect(microtasks).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expectClean(tracing, actor);
    expect(subscriptions).not.toHaveBeenCalled();
  } finally {
    microtasks.mockRestore();
    actor.stop();
  }
});

it('preserves the failing command when an application observer sends reentrant work', async () => {
  const failure = new Error('reentrant failure'),
    diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
  using actor = createTestActor(failingMachine(failure), { inspect: tracing.inspect });
  let reentrant: ReturnType<typeof tracing.sendCommand> | undefined;
  const onError = vi.fn(() => {
    reentrant = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'observer.reentrant' });
  });
  actor.subscribe({ error: onError });
  actor.start();
  await expect(
    expectStoppedActorWarnings(actor, ['RUN'], () =>
      tracing.sendCommand(actor, { type: 'FAIL' }, { name: 'original' }),
    ).finished,
  ).resolves.toEqual({ outcome: 'failed', hadError: true });
  await expect(reentrant?.finished).resolves.toEqual({
    outcome: 'target_terminal',
    hadError: false,
  });
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'associatedRootError',
    error: failure,
  });
  expect(onError).toHaveBeenCalledExactlyOnceWith(failure);
  expectClean(tracing, actor);
});

it('cleans a running child whose stopped snapshot remains active', async () => {
  const tracing = new XStateTracing(tracer);
  using actor = createTestActor(
    setup({ actors: { worker: fromTransition((state) => state, {}) } }).createMachine({
      initial: 'working',
      states: {
        working: { invoke: { id: 'worker', src: 'worker' }, on: { STOP: 'idle' } },
        idle: {},
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const child = actor.getSnapshot().children.worker!;
  actor.send({ type: 'STOP' });
  expect(child.getSnapshot().status).toBe('active');
  await expect(
    expectStoppedActorWarnings(child, ['RUN'], () =>
      tracing.sendCommand(child, { type: 'RUN' }, { name: 'stopped.child' }),
    ).finished,
  ).resolves.toEqual({ outcome: 'target_terminal', hadError: false });
  expectClean(tracing, child);
});

it('preserves replacement Promise ownership after a child initialization failure', async () => {
  const failure = new Error('nested context failure'),
    diagnostic = vi.fn(),
    handled = vi.fn();
  const completion = deferred<void>();
  const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostic });
  using actor = createTestActor(
    setup({
      actors: {
        broken: setup({}).createMachine({
          context: () => {
            throw failure;
          },
        }),
        replacement: tracing.fromPromise('replacement', () => completion.promise),
      },
    }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { RUN: 'working' } },
        working: {
          invoke: {
            src: 'broken',
            onError: { target: 'recovering', actions: ({ event }) => handled(event.error) },
          },
        },
        recovering: { invoke: { src: 'replacement', onDone: 'done' } },
        done: {},
      },
    }),
    { inspect: tracing.inspect },
  ).start();
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'recovering.command' });
  let finished = false;
  void command.finished.then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(handled).toHaveBeenCalledExactlyOnceWith(failure);
  completion.resolve();
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: true });
  expect(diagnostic).not.toHaveBeenCalled();
  expect(getSpan('recovering.command').status.code).not.toBe(SpanStatusCode.ERROR);
  expect(getSpan('replacement').parentSpanContext?.spanId).toBe(command.spanId);
  expectClean(tracing, actor);
});
