import { raise, setup, SimulatedClock, sendTo, type AnyEventObject, waitFor } from 'xstate';
import { expect, it, vi } from 'vitest';
import { XStateTracing, type TimerPolicy } from '../src/index.js';
import { deferred, internals, createTestActor, useTestTracer } from './helpers.js';

// Timers: policy decisions, linked operations for delayed events and
// the clocks they run on.
const { tracer, spans, spansNamed, spanNames, getSpan } = useTestTracer('timers');

it.each(['static', 'callback'] as const)(
  'snapshots %s policy decisions without changing pending timers',
  async (source) => {
    const policy = { mode: 'new-linked-operation' as const, name: 'policy.original' };
    const tracing = new XStateTracing(tracer, {
      timerPolicy: source === 'static' ? policy : () => policy,
    });
    const clock = new SimulatedClock();
    let received = 0;
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: { actions: raise({ type: 'FIRE' }, { delay: 100 }) },
          FIRE: { actions: () => received++ },
        },
      }),
      { inspect: tracing.inspect, clock },
    ).start();
    const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'policy.origin' });
    await origin.finished;
    const schedule = [...internals(tracing).timersByActor.get(actor)!][0] as {
      policy: TimerPolicy;
    };
    expect(schedule.policy).not.toBe(policy);
    expect(schedule.policy).toEqual({ mode: 'new-linked-operation', name: 'policy.original' });
    Object.assign(policy, { mode: 'untraced', name: 'policy.changed' });
    await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'policy.future' }).finished;
    clock.increment(100);
    await tracing.waitForBookkeeping();
    expect(spanNames()).toContain('policy.original');
    expect(received).toBe(2);
    expect(getSpan('policy.original').links[0]?.context.spanId).toBe(origin.spanId);
    expect(spansNamed('policy.changed')).toHaveLength(0);
    expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  },
);

it('keeps an untraced decision fixed after the consumer enables linked policy', async () => {
  const policy = { mode: 'untraced' as const };
  const tracing = new XStateTracing(tracer, { timerPolicy: policy });
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
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'untraced.fixed' }).finished;
  Object.assign(policy, { mode: 'new-linked-operation', name: 'later.policy' });
  clock.increment(10);
  await Promise.resolve();
  expect(received).toBe(1);
  expect(spans().map((span) => span.name)).toEqual(['untraced.fixed']);
});

it.each(['mode', 'name'] as const)(
  'isolates a throwing policy %s getter at registration',
  async (field) => {
    const failure = new Error(`${field} getter failed`);
    const diagnostics = vi.fn(() => {
      throw new Error('diagnostic failed');
    });
    const policy = Object.defineProperty({ mode: 'new-linked-operation' }, field, {
      get() {
        throw failure;
      },
    }) as TimerPolicy;
    const tracing = new XStateTracing(tracer, {
      timerPolicy: () => policy,
      onDiagnostic: diagnostics,
    });
    const clock = new SimulatedClock();
    let received = 0;
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) },
          FIRE: { actions: () => received++ },
        },
      }),
      { inspect: tracing.inspect, clock },
    ).start();
    await expect(
      tracing.sendCommand(actor, { type: 'RUN' }, { name: 'getter.origin' }).finished,
    ).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(diagnostics).toHaveBeenCalledWith({ phase: 'timerPolicy', error: failure });
    expect(() => clock.increment(1)).not.toThrow();
    expect(received).toBe(1);
    expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
    expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  },
);

it('copies only supported primitive policy fields and evaluates getters once', async () => {
  const name = vi.fn(() => 'normalized.timer');
  const mode = vi.fn(() => 'new-linked-operation' as const);
  const extra = vi.fn(() => {
    throw new Error('extra fields must not be read');
  });
  let rawPolicy: object | undefined;
  const tracing: XStateTracing = new XStateTracing(tracer, {
    timerPolicy: ({ actor }): TimerPolicy => {
      rawPolicy = {
        get mode() {
          return mode();
        },
        get name() {
          return name();
        },
        get extra() {
          return extra();
        },
        retained: internals(tracing).processing.get(actor)?.operation,
      };
      return rawPolicy as TimerPolicy;
    },
  });
  const clock = new SimulatedClock();
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 10 }) },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'normalized.origin' });
  await origin.finished;
  const schedule = [...internals(tracing).timersByActor.get(actor)!][0] as {
    policy: TimerPolicy;
  };
  expect(schedule.policy === rawPolicy).toBe(false);
  expect(schedule.policy).toEqual({ mode: 'new-linked-operation', name: 'normalized.timer' });
  expect(Object.getOwnPropertyDescriptor(schedule.policy, 'name')?.get).toBeUndefined();
  expect('operation' in schedule).toBe(false);
  clock.increment(10);
  await tracing.waitForBookkeeping();
  expect(spanNames()).toContain('normalized.timer');
  expect(mode).toHaveBeenCalledOnce();
  expect(name).toHaveBeenCalledOnce();
  expect(extra).not.toHaveBeenCalled();
  expect(getSpan('normalized.timer').links[0]?.context.spanId).toBe(origin.spanId);
});

it('ordinary and explicit sends cannot consume a timer association', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock();
  const event = Object.freeze({ type: 'FIRE', value: 1 });
  const seen: object[] = [];
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise(event, { delay: 10 }) },
        FIRE: {
          actions: ({ event: received }) => {
            seen.push(received);
          },
        },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const origin = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.reuse.origin' });
  await origin.finished;
  actor.send(event);
  await tracing.sendCommand(actor, event, { name: 'timer.reuse.command' }).finished;
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
  expect(getSpan('timer.reuse.command').attributes['actorium.xstate.operation.outcome']).toBe(
    'completed',
  );
  clock.increment(10);
  await tracing.waitForBookkeeping();
  expect(spanNames()).toContain('actorium.xstate.timer_operation');
  expect(getSpan('actorium.xstate.timer_operation').links[0]?.context.spanId).toBe(origin.spanId);
  expect(seen).toHaveLength(3);
  expect(seen.every((received) => received === event)).toBe(true);
});

it('explicit commands override untraced schedules using the same event', async () => {
  const tracing = new XStateTracing(tracer, { timerPolicy: { mode: 'untraced' } });
  const clock = new SimulatedClock(),
    event = { type: 'FIRE' };
  using actor = createTestActor(
    setup({}).createMachine({ on: { RUN: { actions: raise(event, { delay: 10 }) } } }),
    { inspect: tracing.inspect, clock },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'untraced.origin' }).finished;
  await expect(
    tracing.sendCommand(actor, event, { name: 'explicit.command' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: false });
  clock.increment(10);
  await Promise.resolve();
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
});

it('links timers sharing one event object to their actual origin in firing order', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: { mode: 'new-linked-operation' },
  });
  const clock = new SimulatedClock(),
    event = { type: 'FIRE' };
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        SLOW: { actions: raise(event, { delay: 20 }) },
        FAST: { actions: raise(event, { delay: 10 }) },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  const slow = tracing.sendCommand(actor, { type: 'SLOW' }, { name: 'slow' });
  await slow.finished;
  const fast = tracing.sendCommand(actor, { type: 'FAST' }, { name: 'fast' });
  await fast.finished;
  clock.increment(10);
  await tracing.waitForBookkeeping();
  expect(spanNames()).toContain('actorium.xstate.timer_operation');
  let scheduled = spansNamed('actorium.xstate.timer_operation');
  expect(scheduled[0]?.links[0]?.context.spanId).toBe(fast.spanId);
  expect(scheduled[0]?.attributes['actorium.xstate.timer.delay_ms']).toBe(10);
  clock.increment(10);
  await tracing.waitForBookkeeping();
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(2);
  scheduled = spansNamed('actorium.xstate.timer_operation');
  expect(scheduled[1]?.links[0]?.context.spanId).toBe(slow.spanId);
});

it('uses the actor clock for linked firing while real time advances', async () => {
  vi.useFakeTimers();
  try {
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode: 'new-linked-operation' },
    });
    const clock = new SimulatedClock();
    using actor = createTestActor(
      setup({}).createMachine({ on: { RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) } } }),
      { inspect: tracing.inspect, clock },
    ).start();
    const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'actor.clock' });
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    await vi.advanceTimersByTimeAsync(20);
    expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
    clock.increment(1);
    await Promise.resolve();
    expect(getSpan('actorium.xstate.timer_operation').links[0]?.context.spanId).toBe(
      command.spanId,
    );
  } finally {
    vi.useRealTimers();
  }
});

it('rejects the retired bounded policy in types and diagnoses it as untraced at runtime', async () => {
  // @ts-expect-error A bounded timer mode is outside the public contract.
  const policy: TimerPolicy = { mode: 'bounded', maxDurationMs: 5 };
  const diagnostics = vi.fn();
  const tracing = new XStateTracing(tracer, {
    timerPolicy: policy,
    onDiagnostic: diagnostics,
  });
  const clock = new SimulatedClock();
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) },
        FIRE: { actions: () => received++ },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'retired.policy' }).finished;
  expect(diagnostics).toHaveBeenCalledWith({
    phase: 'timerPolicy',
    error: expect.any(TypeError),
  });
  clock.increment(1);
  await Promise.resolve();
  expect(received).toBe(1);
  expect(internals(tracing).timersByActor.has(actor)).toBe(false);
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
});

it('diagnoses a non-string scheduled name and keeps business delivery untraced', async () => {
  const diagnostics = vi.fn();
  const policy = {
    mode: 'new-linked-operation',
    name: { retained: 'application data' },
  } as unknown as TimerPolicy;
  const tracing = new XStateTracing(tracer, {
    timerPolicy: policy,
    onDiagnostic: diagnostics,
  });
  const clock = new SimulatedClock();
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) },
        FIRE: { actions: () => received++ },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'invalid.name' }).finished;
  clock.increment(1);
  expect(received).toBe(1);
  expect(diagnostics).toHaveBeenCalledWith({
    phase: 'timerPolicy',
    error: expect.any(TypeError),
  });
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
});

it('isolates policy and diagnostic-hook failures while delivering the timer', async () => {
  const onDiagnostic = vi.fn(() => {
    throw new Error('diagnostics failed');
  });
  const tracing = new XStateTracing(tracer, {
    timerPolicy: () => {
      throw new Error('policy failed');
    },
    onDiagnostic,
  });
  const clock = new SimulatedClock();
  let received = 0;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) },
        FIRE: { actions: () => received++ },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'safe.policy' }).finished,
  ).resolves.toEqual({ outcome: 'completed', hadError: false });
  clock.increment(1);
  expect(received).toBe(1);
  expect(actor.getSnapshot().status).toBe('active');
  expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(0);
  expect(onDiagnostic).toHaveBeenCalledWith({
    phase: 'timerPolicy',
    error: expect.any(Error),
  });
});

it('suppresses unrelated command ownership when a supported clock fires reentrantly', async () => {
  const tracing = new XStateTracing(tracer, { timerPolicy: { mode: 'untraced' } });
  const clock = new SimulatedClock(),
    implementation = vi.fn(async () => 'done');
  const work = tracing.fromPromise<string, object>('timer.reentrant.work', implementation);
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      initial: 'idle',
      on: {
        RUN: { actions: raise({ type: 'FIRE' }, { delay: 10 }) },
        ADVANCE: { actions: () => clock.increment(10) },
      },
      states: {
        idle: { on: { FIRE: 'working' } },
        working: {
          invoke: {
            src: 'work',
            input: () => ({}),
            onDone: 'idle',
          },
        },
      },
    }),
    { inspect: tracing.inspect, clock },
  ).start();
  await tracing.sendCommand(actor, { type: 'RUN' }, { name: 'timer.origin' }).finished;
  await tracing.sendCommand(actor, { type: 'ADVANCE' }, { name: 'unrelated.advance' }).finished;
  await waitFor(actor, (snapshot) => snapshot.value === 'idle');
  expect(implementation).toHaveBeenCalledOnce();
  expect(spans().map((span) => span.name)).toEqual(['timer.origin', 'unrelated.advance']);
});

it.each(['new-linked-operation', 'untraced'] as const)(
  'creates no instrumentation deadline or clear call for %s firing',
  async (mode) => {
    const simulated = new SimulatedClock(),
      diagnostics = vi.fn();
    const clock = {
      setTimeout: vi.fn((callback: () => void, delay: number) => {
        return simulated.setTimeout(callback, delay);
      }),
      clearTimeout: vi.fn(() => {
        throw new Error('no deadline should be cleared on firing');
      }),
    };
    const tracing = new XStateTracing(tracer, {
      timerPolicy: { mode },
      onDiagnostic: diagnostics,
    });
    let received = 0;
    using actor = createTestActor(
      setup({}).createMachine({
        on: {
          RUN: { actions: raise({ type: 'FIRE' }, { delay: 1 }) },
          FIRE: { actions: () => received++ },
        },
      }),
      { inspect: tracing.inspect, clock },
    ).start();
    await expect(
      tracing.sendCommand(actor, { type: 'RUN' }, { name: 'no.deadline' }).finished,
    ).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(clock.setTimeout).toHaveBeenCalledOnce();
    expect(clock.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1);
    simulated.increment(1);
    await Promise.resolve();
    expect(received).toBe(1);
    expect(internals(tracing).timersByActor.has(actor)).toBe(false);
    expect(clock.clearTimeout).not.toHaveBeenCalled();
    expect(diagnostics).not.toHaveBeenCalled();
    expect(spansNamed('actorium.xstate.timer_operation')).toHaveLength(mode === 'untraced' ? 0 : 1);
  },
);

it('ends the origin before the timer and keeps linked finite work open until settlement', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: {
      mode: 'new-linked-operation',
      name: 'timer.linked',
    },
  });
  const clock = new SimulatedClock();
  const result = deferred<string>();
  const work = tracing.fromPromise<string, Record<string, never>>(
    'timer.linked_work',
    () => result.promise,
  );
  const machine = setup({
    actors: { work },
    types: { events: {} as { type: 'START' } },
  }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { START: 'waiting' } },
      waiting: { after: { 10: 'working' } },
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: 'done',
        },
      },
      done: {},
    },
  });
  using actor = createTestActor(machine, {
    clock,
    inspect: tracing.inspect,
  }).start();

  const command = tracing.sendCommand(actor, { type: 'START' }, { name: 'timer.linked_origin' });
  await expect(command.finished).resolves.toEqual({
    outcome: 'completed',
    hadError: false,
  });
  expect(actor.getSnapshot().matches('waiting')).toBe(true);
  clock.increment(10);
  expect(actor.getSnapshot().matches('working')).toBe(true);
  expect(spanNames()).not.toContain('timer.linked');
  result.resolve('done');
  await waitFor(actor, (snapshot) => snapshot.matches('done'));
  await tracing.waitForBookkeeping();
  const linked = getSpan('timer.linked');
  expect(linked.links[0]?.context.spanId).toBe(command.spanId);
  expect(getSpan('timer.linked_work').parentSpanContext?.spanId).toBe(linked.spanContext().spanId);
});

it('cancels a linked timer without changing the originating command outcome', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: {
      mode: 'new-linked-operation',
    },
  });
  const clock = new SimulatedClock();
  const machine = setup({
    types: {
      events: {} as { type: 'START' } | { type: 'CANCEL' },
    },
  }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { START: 'waiting' } },
      waiting: { after: { 10: 'expired' }, on: { CANCEL: 'idle' } },
      expired: {},
    },
  });
  using actor = createTestActor(machine, {
    clock,
    inspect: tracing.inspect,
  }).start();

  const start = tracing.sendCommand(actor, { type: 'START' }, { name: 'timer.cancelled_origin' });
  const cancel = tracing.sendCommand(actor, { type: 'CANCEL' }, { name: 'timer.cancel' });

  await expect(start.finished).resolves.toEqual({
    outcome: 'completed',
    hadError: false,
  });
  await expect(cancel.finished).resolves.toEqual({
    outcome: 'completed',
    hadError: false,
  });
  clock.increment(10);
  expect(actor.getSnapshot().matches('idle')).toBe(true);
  expect(spanNames()).not.toContain('actorium.xstate.timer_operation');
});

it('starts linked work after a long delay without holding the origin open', async () => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: {
      mode: 'new-linked-operation',
      name: 'timer.later',
    },
  });
  const clock = new SimulatedClock();
  const work = tracing.fromPromise<string, Record<string, never>>(
    'timer.late_work',
    async () => 'done',
  );
  const machine = setup({
    actors: { work },
    types: { events: {} as { type: 'START' } },
  }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { START: 'waiting' } },
      waiting: { after: { 50: 'working' } },
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: 'done',
        },
      },
      done: {},
    },
  });
  using actor = createTestActor(machine, {
    clock,
    inspect: tracing.inspect,
  }).start();

  const command = tracing.sendCommand(actor, { type: 'START' }, { name: 'timer.late_origin' });
  await expect(command.finished).resolves.toEqual({
    outcome: 'completed',
    hadError: false,
  });
  clock.increment(50);
  await waitFor(actor, (snapshot) => snapshot.matches('done'));
  await tracing.waitForBookkeeping();

  const lateOperation = getSpan('timer.later');
  expect(lateOperation.links[0]?.context.spanId).toBe(command.spanId);
  expect(getSpan('timer.late_work').parentSpanContext?.spanId).toBe(
    lateOperation.spanContext().spanId,
  );
});

it.each([
  { mode: 'raise' as const, delay: 10 },
  { mode: 'sendTo' as const, delay: 10 },
  { mode: 'after' as const, delay: 10 },
  { mode: 'raise' as const, delay: 0 },
])('starts a linked operation for delayed $mode work at $delay ms', async ({ mode, delay }) => {
  const tracing = new XStateTracing(tracer, {
    timerPolicy: () => ({
      mode: 'new-linked-operation',
      name: `timer.${mode}.scheduled`,
    }),
  });
  const clock = new SimulatedClock();
  const work = tracing.fromPromise<string, Record<string, never>>('timer.work', async () => 'done');
  const delayedAction =
    mode === 'raise'
      ? raise({ type: 'FIRE' }, { delay })
      : sendTo(({ self }) => self, { type: 'FIRE' }, { delay });
  const machine = setup({
    actors: { work },
    types: { events: {} as AnyEventObject },
  }).createMachine({
    initial: 'idle',
    states: {
      idle: { on: { START: 'waiting' } },
      waiting:
        mode === 'after'
          ? { after: { [delay]: 'working' } }
          : { entry: delayedAction, on: { FIRE: 'working' } },
      working: {
        invoke: {
          src: 'work',
          input: () => ({}),
          onDone: 'done',
        },
      },
      done: {},
    },
  });
  using actor = createTestActor(machine, {
    clock,
    inspect: tracing.inspect,
  }).start();

  const command = tracing.sendCommand(actor, { type: 'START' }, { name: `timer.${mode}.origin` });
  await expect(command.finished).resolves.toEqual({
    outcome: 'completed',
    hadError: false,
  });

  clock.increment(delay);
  await waitFor(actor, (snapshot) => snapshot.matches('done'));
  await tracing.waitForBookkeeping();

  const scheduled = getSpan(`timer.${mode}.scheduled`);
  const workSpan = getSpan('timer.work');
  expect(scheduled.links[0]?.context.spanId).toBe(command.spanId);
  expect(scheduled.spanContext().traceId).not.toBe(command.traceId);
  expect(workSpan.parentSpanContext?.spanId).toBe(scheduled.spanContext().spanId);
});
