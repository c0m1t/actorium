import { context, trace } from '@opentelemetry/api';
import {
  assign,
  fromCallback,
  raise,
  sendTo,
  setup,
  spawnChild,
  type AnyActorRef,
  type AnyStateMachine,
} from 'xstate';
import { expect, it, vi } from 'vitest';
import { XStateTracing, type CommandTrace } from '../src/index.js';
import { deferred, createTestActor, internals, useTestTracer } from './helpers.js';

const { tracer, spans, spanNames, spansNamed, getSpan } = useTestTracer('prestart', {
  contextManager: true,
});

it.each(['root relay', 'callback reply', 'nested relay'] as const)(
  'does not attach unrelated startup %s work to a pre-start command',
  async (mode) => {
    const tracing = new XStateTracing(tracer);
    const pending = deferred<string>();
    let settled = false;
    const implementation = vi.fn(async () => {
      const result = await pending.promise;
      settled = true;
      return result;
    });
    const work = tracing.fromPromise<string, object>('startup.work', implementation);
    const worker = setup({ actors: { work } }).createMachine({
      initial: 'idle',
      states: {
        idle: { on: { STARTUP: 'working' } },
        working: {
          invoke: {
            src: 'work',
            input: () => ({}),
            onDone: 'idle',
          },
        },
      },
    });
    let machine: AnyStateMachine;
    if (mode === 'callback reply') {
      const callback = fromCallback(({ sendBack }) => {
        sendBack({ type: 'STARTUP' });
      });
      machine = setup({ actors: { callback, work } }).createMachine({
        invoke: { src: 'callback' },
        initial: 'idle',
        states: {
          idle: { on: { STARTUP: 'working' } },
          working: {
            invoke: {
              src: 'work',
              input: () => ({}),
              onDone: 'idle',
            },
          },
        },
      });
    } else {
      const relay = setup({ actors: { worker } }).createMachine({
        invoke: { id: 'worker', src: 'worker' },
        entry: sendTo('worker', { type: 'STARTUP' }),
      });
      machine =
        mode === 'root relay'
          ? relay
          : setup({ actors: { relay } }).createMachine({ invoke: { src: 'relay' } });
    }
    using actor = createTestActor(machine, { inspect: tracing.inspect });
    const command = tracing.sendCommand(actor, { type: 'IGNORED' }, { name: 'queued.ignored' });
    try {
      actor.start();
      expect(implementation).toHaveBeenCalledOnce();
      await vi.waitFor(() =>
        expect(
          spanNames(),
          'unrelated startup work must not keep the pre-start command open',
        ).toContain('queued.ignored'),
      );
      await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
      pending.resolve('done');
      await vi.waitFor(() => expect(settled).toBe(true));
      expect(spans().some((span) => span.name === 'startup.work')).toBe(false);
    } finally {
      pending.resolve('cleanup');
      actor.stop();
    }
  },
);

it('activates a pre-start command only during its processing turn', async () => {
  const tracing = new XStateTracing(tracer);
  const activeSpanId = (actor: AnyActorRef) =>
    tracing.withActiveOperation(actor, () => trace.getSpanContext(context.active())?.spanId);
  let startupSpanId: string | undefined = 'not executed';
  let commandSpanId: string | undefined;
  using actor = createTestActor(
    setup({}).createMachine({
      entry: ({ self }) => {
        startupSpanId = activeSpanId(self);
      },
      on: {
        RUN: {
          actions: ({ self }) => {
            commandSpanId = activeSpanId(self);
          },
        },
      },
    }),
    { inspect: tracing.inspect },
  );
  const command = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'queued.active' });
  try {
    expect(activeSpanId(actor)).toBeUndefined();
    actor.start();
    await expect(command.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(startupSpanId).toBeUndefined();
    expect(commandSpanId).toBe(command.spanId);
  } finally {
    actor.stop();
  }
});

it('preserves traced and untraced pre-start ownership when the same event object is reused', async () => {
  const tracing = new XStateTracing(tracer);
  const pending = deferred<string>();
  const implementation = vi.fn(() => pending.promise);
  const work = tracing.fromPromise<string, object>('queued.work', implementation);
  using actor = createTestActor(
    setup({ actors: { work } }).createMachine({
      on: {
        WORK: {
          actions: spawnChild('work', { input: () => ({}) }),
        },
      },
    }),
    { inspect: tracing.inspect },
  );
  const event = Object.freeze({ type: 'WORK' });
  const first = tracing.sendCommand(actor, event, { name: 'queued.first' });
  actor.send(event);
  const second = tracing.sendCommand(actor, event, { name: 'queued.second' });
  try {
    actor.start();
    expect(implementation).toHaveBeenCalledTimes(3);
    await Promise.resolve();
    expect(spans()).toHaveLength(0);
    pending.resolve('done');
    await expect(first.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    await expect(second.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(spansNamed('queued.work').map((span) => span.parentSpanContext?.spanId)).toEqual([
      first.spanId,
      second.spanId,
    ]);
    const runtime = internals(tracing);
    expect(runtime.processing.has(actor)).toBe(false);
    expect(runtime.queued.has(actor)).toBe(false);
  } finally {
    pending.resolve('cleanup');
    actor.stop();
  }
});

it('retains the creating command for nested initialization ahead of a queued child command', async () => {
  const tracing = new XStateTracing(tracer);
  const startup = deferred<string>();
  const requested = deferred<string>();
  const startupWork = tracing.fromPromise<string, object>(
    'nested.startup.work',
    () => startup.promise,
  );
  const requestedWork = tracing.fromPromise<string, object>(
    'nested.requested.work',
    () => requested.promise,
  );
  let startupSpanId: string | undefined;
  let childCommand: CommandTrace | undefined;
  const child = setup({ actors: { startupWork, requestedWork } }).createMachine({
    invoke: { src: 'startupWork', input: () => ({}) },
    entry: ({ self }) => {
      startupSpanId = tracing.withActiveOperation(
        self,
        () => trace.getSpanContext(context.active())?.spanId,
      );
    },
    on: {
      RUN: {
        actions: spawnChild('requestedWork', { input: () => ({}) }),
      },
    },
  });
  using actor = createTestActor(
    setup({
      actors: { child },
      types: { context: {} as { child: AnyActorRef | undefined } },
    }).createMachine({
      context: { child: undefined },
      on: {
        START: {
          actions: [
            assign({ child: ({ spawn }) => spawn('child', { id: 'nested' }) }),
            ({ context: state }) => {
              childCommand = tracing.sendCommand(
                state.child!,
                { type: 'RUN' },
                { name: 'nested.requested' },
              );
            },
          ],
        },
      },
    }),
    { inspect: tracing.inspect },
  );
  const origin = tracing.sendCommand(actor, { type: 'START' }, { name: 'nested.origin' });
  try {
    actor.start();
    expect(startupSpanId).toBe(origin.spanId);
    expect(childCommand).toBeDefined();
    requested.resolve('requested');
    await expect(childCommand!.finished).resolves.toEqual({
      outcome: 'completed',
      hadError: false,
    });
    expect(spansNamed('nested.origin')).toEqual([]);
    startup.resolve('startup');
    await expect(origin.finished).resolves.toEqual({ outcome: 'completed', hadError: false });
    expect(getSpan('nested.startup.work').parentSpanContext?.spanId).toBe(origin.spanId);
    expect(getSpan('nested.requested.work').parentSpanContext?.spanId).toBe(childCommand!.spanId);
  } finally {
    requested.resolve('cleanup');
    startup.resolve('cleanup');
    actor.stop();
  }
});

it('keeps raised microsteps in their macrostep when the same event is queued as another command', async () => {
  const tracing = new XStateTracing(tracer, { recordMicrosteps: true });
  const shared = Object.freeze({ type: 'SHARED' });
  let queued: CommandTrace | undefined;
  using actor = createTestActor(
    setup({}).createMachine({
      on: {
        START: {
          actions: [
            ({ self }) => {
              queued = tracing.sendCommand(self, shared, { name: 'raised.queued' });
            },
            raise(shared),
          ],
        },
        SHARED: {},
      },
    }),
    { inspect: tracing.inspect },
  );
  const origin = tracing.sendCommand(actor, { type: 'START' }, { name: 'raised.origin' });
  actor.start();
  await origin.finished;
  await queued!.finished;
  for (const name of ['raised.origin', 'raised.queued']) {
    const span = getSpan(name);
    expect(
      span.events.filter((event) => event.attributes?.['actorium.xstate.event.type'] === 'SHARED'),
    ).toHaveLength(1);
  }
});

it('cancels unprocessed pre-start commands when unrelated root initialization fails', async () => {
  const diagnostic = vi.fn();
  const tracing = new XStateTracing(tracer, { onTelemetryError: diagnostic });
  const failure = new Error('startup failed');
  const onError = vi.fn();
  using actor = createTestActor(
    setup({}).createMachine({
      entry: () => {
        throw failure;
      },
    }),
    { inspect: tracing.inspect },
  );
  actor.subscribe({ error: onError });
  const first = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'startup.abandoned.first' });
  const second = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'startup.abandoned.second' });
  actor.start();
  expect(onError).toHaveBeenCalledWith(failure);
  expect(actor.getSnapshot().status).toBe('error');
  for (const command of [first, second]) {
    await expect(command.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
  }
  const runtime = internals(tracing);
  expect(runtime.processing.has(actor)).toBe(false);
  expect(runtime.queued.has(actor)).toBe(false);
  expect(diagnostic).toHaveBeenCalledExactlyOnceWith({
    phase: 'unassociatedRootError',
    error: actor.getSnapshot().error,
  });
});

it('cancels commands abandoned by stop before start and drops later commands', async () => {
  const tracing = new XStateTracing(tracer);
  using actor = createTestActor(setup({}).createMachine({}), { inspect: tracing.inspect });
  const first = tracing.sendCommand(actor, { type: 'RUN' }, { name: 'before.start' });
  actor.stop();
  await expect(first.finished).resolves.toEqual({ outcome: 'cancelled', hadError: false });
  await expect(
    tracing.sendCommand(actor, { type: 'RUN' }, { name: 'after.stop' }).finished,
  ).resolves.toEqual({ outcome: 'dropped', hadError: false });
  expect(internals(tracing).processing.has(actor)).toBe(false);
});
