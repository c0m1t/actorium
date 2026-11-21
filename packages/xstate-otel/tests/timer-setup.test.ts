import { createActor, raise, setup, SimulatedClock, type AnyActorRef, sendTo } from 'xstate';
import { expect, it, vi } from 'vitest';
import { XStateTracing } from '../src/index.js';
import { createTestActor, internals, useTestTracer } from './helpers.js';

const { tracer, spans, spansNamed, spanNames, getSpan } = useTestTracer('timer-setup');

const mutableClock = (simulated: SimulatedClock) => ({
  setTimeout: vi.fn(simulated.setTimeout.bind(simulated)),
  clearTimeout: vi.fn(simulated.clearTimeout.bind(simulated)),
});

it.each(['untraced', 'new-linked-operation'] as const)(
  'rejects a frozen clock with %s policy before business initialization',
  (mode) => {
    const simulated = new SimulatedClock(),
      clock = Object.freeze(mutableClock(simulated));
    const diagnostic = vi.fn(),
      initialization = vi.fn(() => ({})),
      startup = vi.fn();
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode },
      onDiagnostic: diagnostic,
    });
    let actor: AnyActorRef | undefined;
    let original: AnyActorRef['system']['scheduler'] | undefined;
    expect(() =>
      createActor(setup({}).createMachine({ context: initialization, entry: startup }), {
        clock,
        inspect: (inspection) => {
          if (inspection.type === '@xstate.actor') {
            actor = inspection.actorRef as AnyActorRef;
            original = { ...actor.system.scheduler };
          }
          tracing.inspect(inspection);
        },
      }),
    ).toThrow(/Unsupported native timer tracing configuration: clock.setTimeout/);
    expect(initialization).not.toHaveBeenCalled();
    expect(startup).not.toHaveBeenCalled();
    expect(clock.setTimeout).not.toHaveBeenCalled();
    expect(clock.clearTimeout).not.toHaveBeenCalled();
    expect(diagnostic).toHaveBeenCalledWith({ phase: 'scheduler', error: expect.any(TypeError) });
    for (const method of ['schedule', 'cancel', 'cancelAll'] as const) {
      expect(actor!.system.scheduler[method]).toBe(original![method]);
    }
    const runtime = internals(tracing);
    expect(runtime.observedActors.has(actor!)).toBe(false);
    expect(runtime.instrumentedSystems.has(actor!.system)).toBe(false);
    expect(runtime.lifecycleChecks.has(actor!)).toBe(false);
    expect(runtime.timerRegistrations.has(actor!)).toBe(false);
    expect(runtime.timersByActor.has(actor!)).toBe(false);
  },
);

it.each(['setTimeout', 'clearTimeout'] as const)(
  'requires both clock methods to be writable: %s',
  (method) => {
    const clock = mutableClock(new SimulatedClock());
    Object.defineProperty(clock, method, { writable: false });
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'untraced' },
      onDiagnostic: () => {},
    });
    expect(() =>
      createActor(setup({}).createMachine({}), { clock, inspect: tracing.inspect }),
    ).toThrow(new RegExp(`clock\\.${method} must allow temporary delegation`));
    expect(clock.setTimeout).not.toHaveBeenCalled();
    expect(clock.clearTimeout).not.toHaveBeenCalled();
  },
);

it.each(['freeze', 'seal', 'preventExtensions'] as const)(
  'rejects %s on a clock whose methods need inherited shadowing',
  (method) => {
    const clock = new SimulatedClock();
    if (method === 'freeze') Object.freeze(clock);
    else Object[method](clock);
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'untraced' },
      onDiagnostic: () => {},
    });
    expect(() =>
      createActor(setup({}).createMachine({}), { clock, inspect: tracing.inspect }),
    ).toThrow(/clock.setTimeout must allow temporary delegation/);
  },
);

it.each(['setTimeout', 'clearTimeout'] as const)(
  'rejects accessor clock methods without invoking their getters: %s',
  (method) => {
    const clock = mutableClock(new SimulatedClock());
    const original = clock[method];
    const getter = vi.fn(() => original);
    Object.defineProperty(clock, method, { get: getter });
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'untraced' },
      onDiagnostic: () => {},
    });
    expect(() =>
      createActor(setup({}).createMachine({}), { clock, inspect: tracing.inspect }),
    ).toThrow(new RegExp(`clock\\.${method} must allow temporary delegation`));
    expect(getter).not.toHaveBeenCalled();
  },
);

it.each(['setTimeout', 'clearTimeout'] as const)(
  'rejects missing/non-function clock method %s during setup',
  (method) => {
    const clock = mutableClock(new SimulatedClock());
    Object.defineProperty(clock, method, { value: undefined });
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'untraced' },
      onDiagnostic: () => {},
    });
    expect(() =>
      createActor(setup({}).createMachine({}), { clock, inspect: tracing.inspect }),
    ).toThrow(new RegExp(`clock\\.${method} must allow temporary delegation`));
  },
);

it.each(['schedule', 'cancel'] as const)(
  'rejects a readonly scheduler %s before installing any wrappers',
  (method) => {
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'untraced' },
      onDiagnostic: () => {},
    });
    const clock = mutableClock(new SimulatedClock());
    const initialization = vi.fn(() => ({}));
    let actor: AnyActorRef | undefined;
    let original: AnyActorRef['system']['scheduler'] | undefined;
    expect(() =>
      createActor(setup({}).createMachine({ context: initialization }), {
        clock,
        inspect: (inspection) => {
          if (inspection.type === '@xstate.actor') {
            actor = inspection.actorRef as AnyActorRef;
            original = { ...actor.system.scheduler };
            Object.defineProperty(actor.system.scheduler, method, { writable: false });
          }
          tracing.inspect(inspection);
        },
      }),
    ).toThrow(new RegExp(`system\\.scheduler\\.${method} must allow temporary delegation`));
    expect(initialization).not.toHaveBeenCalled();
    for (const key of ['schedule', 'cancel', 'cancelAll'] as const) {
      expect(actor!.system.scheduler[key]).toBe(original![key]);
    }
    expect(internals(tracing).instrumentedSystems.has(actor!.system)).toBe(false);
  },
);

it('leaves a readonly scheduler cancelAll native and still releases timers on stop', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = mutableClock(new SimulatedClock());
  let cancelAll: AnyActorRef['system']['scheduler']['cancelAll'] | undefined;
  using actor = createTestActor(
    setup({}).createMachine({
      on: { RUN: { actions: raise({ type: 'FIRE' }, { delay: 100, id: 'later' }) } },
    }),
    {
      clock,
      inspect: (inspection) => {
        if (inspection.type === '@xstate.actor' && !cancelAll) {
          const { scheduler } = (inspection.actorRef as AnyActorRef).system;
          Object.defineProperty(scheduler, 'cancelAll', { writable: false });
          cancelAll = scheduler.cancelAll;
        }
        tracing.inspect(inspection);
      },
    },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.readonly-cancel-all' }).finished;
  expect(actor.system.scheduler.cancelAll).toBe(cancelAll);
  expect(internals(tracing).timersByActor.get(actor)?.size).toBe(1);
  actor.stop();
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
});

it('keeps configuration failure visible even if the diagnostic callback throws', () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: () => ({ mode: 'untraced' }),
    onDiagnostic: () => {
      throw new Error('diagnostic failure');
    },
  });
  expect(() =>
    createActor(setup({}).createMachine({}), {
      clock: Object.freeze(mutableClock(new SimulatedClock())),
      inspect: tracing.inspect,
    }),
  ).toThrow(/Unsupported native timer tracing configuration: clock.setTimeout/);
});

it.each(['seal', 'preventExtensions'] as const)(
  'allows %s when clock data methods are already own writable properties',
  async (method) => {
    const simulated = new SimulatedClock(),
      clock = mutableClock(simulated);
    Object[method](clock);
    const { setTimeout, clearTimeout } = clock;
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'new-linked-operation' },
    });
    let received = 0;
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: {
            actions: [
              raise({ type: 'FIRE' }, { delay: 10, id: 'fire' }),
              raise({ type: 'FIRE' }, { delay: 100, id: 'cancel' }),
            ],
          },
          FIRE: { actions: () => received++ },
        },
      }),
      { clock, inspect: tracing.inspect },
    ).start();
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.mutable-methods' }).finished;
    actor.system.scheduler.cancel(actor, 'cancel');
    simulated.increment(100);
    await Promise.resolve();
    expect(received).toBe(1);
    expect(clock.setTimeout).toBe(setTimeout);
    expect(clock.clearTimeout).toBe(clearTimeout);
    expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  },
);

it('can use the runtime with a supported clock after a failed configuration', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'untraced' },
    onDiagnostic: () => {},
  });
  expect(() =>
    createActor(setup({}).createMachine({}), {
      clock: Object.freeze(mutableClock(new SimulatedClock())),
      inspect: tracing.inspect,
    }),
  ).toThrow(TypeError);
  using actor = createTestActor(setup({}).createMachine({}), {
    clock: new SimulatedClock(),
    inspect: tracing.inspect,
  }).start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.valid' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: false });
});

it('does not fall back to native scheduling if the clock is frozen after setup', async () => {
  const simulated = new SimulatedClock(),
    clock = mutableClock(simulated),
    diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'untraced' },
    onDiagnostic: diagnostic,
  });
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 10 }) },
        ADVANCE: { actions: () => simulated.increment(10) },
        FIRE: { actions: () => received++ },
      },
    }),
    { clock, inspect: tracing.inspect },
  );
  const onError = vi.fn();
  actor.subscribe({ error: onError });
  actor.start();
  Object.freeze(clock);
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.invalidated' }).finished,
  ).resolves.toEqual({ outcome: 'failed', hadError: true });
  expect(clock.setTimeout).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith({ phase: 'scheduler', error: expect.any(TypeError) });
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  simulated.increment(10);
  expect(received).toBe(0);
  expect(onError).toHaveBeenCalledExactlyOnceWith(actor.getSnapshot().error);
});

it('throws a later clearTimeout delegation failure without pretending the timer was cancelled', async () => {
  const simulated = new SimulatedClock(),
    clock = mutableClock(simulated),
    diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'untraced' },
    onDiagnostic: diagnostic,
  });
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 10, id: 'timer' }) },
      },
    }),
    { clock, inspect: tracing.inspect },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.cancel.invalid' }).finished;
  Object.defineProperty(clock, 'clearTimeout', { writable: false });
  expect(() => actor.system.scheduler.cancel(actor, 'timer')).toThrow(
    /clock.clearTimeout no longer allows method delegation/,
  );
  expect(clock.clearTimeout).not.toHaveBeenCalled();
  expect(diagnostic).toHaveBeenCalledWith({ phase: 'scheduler', error: expect.any(TypeError) });
  expect(internals(tracing).timersByActor.has(actor)).toBe(true);
  // Restore the violated precondition solely to clean up the still-pending timer.
  Object.defineProperty(clock, 'clearTimeout', { writable: true });
  actor.stop();
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
});

it.each([false, true])(
  'leaves scheduler methods untouched without opt-in on a frozen clock = %s',
  async (frozen) => {
    const diagnostics = vi.fn();
    const tracing = new XStateTracing(tracer, { onDiagnostic: diagnostics });
    const simulated = new SimulatedClock();
    const suppliedClock = {
      setTimeout: simulated.setTimeout.bind(simulated),
      clearTimeout: simulated.clearTimeout.bind(simulated),
    };
    const clock = frozen ? Object.freeze(suppliedClock) : suppliedClock;
    let originalScheduler: AnyActorRef['system']['scheduler'] | undefined;
    let received = 0;
    const child = setup({}).createMachine({});
    using actor = createTestActor(
      setup({ actors: { child } }).createMachine({
        invoke: { src: 'child' },
        on: {
          RUN: { actions: raise({ type: 'FIRE' }, { delay: 10 }) },
          FIRE: { actions: () => received++ },
        },
      }),
      {
        inspect: (inspection) => {
          if (inspection.type === '@xstate.actor' && !originalScheduler) {
            originalScheduler = { ...(inspection.actorRef as AnyActorRef).system.scheduler };
          }
          tracing.inspect(inspection);
        },
        clock,
      },
    ).start();
    for (const method of ['schedule', 'cancel', 'cancelAll'] as const) {
      expect(actor.system.scheduler[method]).toBe(originalScheduler![method]);
    }
    const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timers.disabled' });
    await expect(origin.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(internals(tracing).timersByActor.has(actor)).toBe(false);
    simulated.increment(10);
    expect(received).toBe(1);
    expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
    expect(diagnostics).not.toHaveBeenCalled();
  },
);

it('rejects immutable custom clocks during timer tracing setup', () => {
  const diagnostics = vi.fn(),
    simulated = new SimulatedClock();
  const clock = Object.freeze({
    setTimeout: simulated.setTimeout.bind(simulated),
    clearTimeout: simulated.clearTimeout.bind(simulated),
  });
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
    onDiagnostic: diagnostics,
  });
  let received = 0;
  expect(() =>
    createActor(
      setup({}).createMachine({
        on: {
          RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) },
          FIRE: { actions: () => received++ },
        },
      }),
      { inspect: tracing.inspect, clock },
    ),
  ).toThrow(/Unsupported native timer tracing configuration: clock.setTimeout/);
  simulated.increment(1);
  expect(received).toBe(0);
  expect(diagnostics).toHaveBeenCalledWith({ phase: 'scheduler', error: expect.any(TypeError) });
  expect(spans()).toHaveLength(0);
});

it('uses the system scheduling clock even if a child has a different individual clock', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock(),
    childClock = new SimulatedClock();
  const worker = setup({}).createMachine({
    on: { RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) } },
  });
  using actor = createTestActor(
    setup({ actors: { worker } }).createMachine({
      invoke: { id: 'worker', src: 'worker' },
      on: { RUN: { actions: sendTo('worker', { type: 'RUN' }) } },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const child = actor.getSnapshot().children.worker as unknown as { clock: SimulatedClock };
  child.clock = childClock;
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'system.clock' });
  await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
  childClock.increment(10);
  await Promise.resolve();
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
  clock.increment(1);
  await tracing.waitForBookkeeping();
  expect(spanNames()).toContain('actorium.xstate.timer_operation');
  expect(getSpan('actorium.xstate.timer_operation').links[0]?.context.spanId).toBe(command.spanId);
});
